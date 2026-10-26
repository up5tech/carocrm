import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { OmnichannelCallService } from './omnichannel-call.service.js';
import { OmnichannelCapabilityService } from './omnichannel-capability.service.js';
import { OmnichannelConversationService } from './omnichannel-conversation.service.js';
import { OmnichannelDraftService } from './omnichannel-draft.service.js';
import { OmnichannelHandoffService } from './omnichannel-handoff.service.js';
import { OmnichannelIdentityService } from './omnichannel-identity.service.js';
import { OmnichannelModuleHealthService } from './omnichannel-module-health.service.js';
import { OmnichannelNavigationService } from './omnichannel-navigation.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelRoutingService } from './omnichannel-routing.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';
import { OmnichannelSnippetService } from './omnichannel-snippet.service.js';

/**
 * Phase 19-OM.2 — the `Omnichannel` control plane
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`).
 *
 * Only the control plane exists at this phase: the caller's rights, the module's own navigation
 * signal, health, and the settings document that switches the workspace. The inbox, composer,
 * queue, identity, connection and operations endpoints arrive with their own sub-phases (contract
 * §3) and pass through this same permission service — plan §14 OM.2 forbids placeholder controllers
 * for features that do not exist yet, and there are none here.
 *
 * Every route checks a capability server-side; hiding a control in the SPA is never authorization
 * (AGENTS.md §5.3). Registered before `ENTITY_CONTROLLERS`, so the static `/api/v1/Omnichannel`
 * prefix can never be swallowed by the generic `/api/v1/:entity` wildcard.
 */

const SendMessageSchema = z
  .object({
    body: z.string().max(20_000).default(''),
    idempotencyKey: z.string().trim().min(8).max(200),
    templateKey: z.string().trim().max(120).optional(),
    templateLanguage: z.string().trim().max(20).optional(),
    templateVariables: z.record(z.string().max(2_000)).optional(),
    mediaAttachmentIds: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    isInternalNote: z.boolean().optional(),
  })
  .strict();
const IdentityLinkSchema = z
  .object({
    participantId: z.string().trim().min(1).max(120).optional(),
    entityType: z.enum(['Contact', 'Lead']),
    entityId: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const IdentityUnlinkSchema = z
  .object({
    participantId: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const StatusInputSchema = z.object({ status: z.string().trim().min(1).max(40) }).strict();
const AssignInputSchema = z
  .object({
    userId: z.string().trim().min(1).max(120).nullable().optional(),
    teamId: z.string().trim().min(1).max(120).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();
const RouteInputSchema = z.object({ expectedVersion: z.number().int().min(0).optional() }).strict();
const HandoffSchema = z.object({ linkCaseId: z.string().trim().min(1).max(120).optional() }).strict();
const SnippetPreviewSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(120).optional(),
    variables: z.record(z.string().max(200)).optional(),
  })
  .strict();
const DraftSchema = z.object({ body: z.string().max(20_000), isInternalNote: z.boolean().optional() }).strict();

function pageOf(limit: unknown, offset: unknown): { limit: number; offset: number } {
  const parsedLimit = Number(limit ?? 25);
  const parsedOffset = Number(offset ?? 0);
  return {
    limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 100) : 25,
    offset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.trunc(parsedOffset) : 0,
  };
}

@ApiTags('omnichannel')
@Controller('api/v1/Omnichannel')
export class OmnichannelController {
  constructor(
    @Inject(OmnichannelModuleHealthService) private readonly health: OmnichannelModuleHealthService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
    @Inject(OmnichannelNavigationService) private readonly navigation: OmnichannelNavigationService,
    @Inject(OmnichannelCapabilityService) private readonly channelCapabilities: OmnichannelCapabilityService,
    @Inject(OmnichannelConversationService) private readonly conversations: OmnichannelConversationService,
    @Inject(OmnichannelIdentityService) private readonly identities: OmnichannelIdentityService,
    @Inject(OmnichannelRoutingService) private readonly routing: OmnichannelRoutingService,
    @Inject(OmnichannelSnippetService) private readonly snippets: OmnichannelSnippetService,
    @Inject(OmnichannelDraftService) private readonly drafts: OmnichannelDraftService,
    @Inject(OmnichannelCallService) private readonly calls: OmnichannelCallService,
    @Inject(OmnichannelHandoffService) private readonly handoff: OmnichannelHandoffService,
  ) {}

  /**
   * The channel capability catalog (OM.4): per channel, what the bound transports actually declare,
   * gated by the owning module's flags. The composer enables or refuses from this answer — an
   * undeclared capability is refused as `unsupported`, never attempted or faked (contract §9).
   */
  @Get('action/channels')
  async channels() {
    await this.permissions.assert('inboxView');
    return this.channelCapabilities.catalog();
  }

  // ---------------------------------------------------------------------------
  // Conversation workspace (19-OM.6) — composed over the exported Voice facade (D1)
  // ---------------------------------------------------------------------------

  /** The inbox page with the workspace projection (priority/tags/queue/snooze/threads). */
  @Get('action/conversations')
  async listConversations(
    @Query('limit') limit: unknown,
    @Query('offset') offset: unknown,
    @Query('status') status: string | undefined,
    @Query('channel') channel: string | undefined,
    @Query('assignee') assignee: string | undefined,
    @Query('priority') priority: string | undefined,
    @Query('language') language: string | undefined,
    @Query('tag') tag: string | undefined,
    @Query('unread') unread: string | undefined,
    @Query('snoozed') snoozed: string | undefined,
    @Query('queueId') queueId: string | undefined,
  ) {
    await this.permissions.assert('inboxView');
    const page = pageOf(limit, offset);
    return this.conversations.list({
      ...page,
      ...(typeof status === 'string' && status !== '' ? { status } : {}),
      ...(typeof channel === 'string' && channel !== '' ? { channel } : {}),
      ...(typeof assignee === 'string' && assignee !== '' ? { assignee } : {}),
      ...(typeof priority === 'string' && priority !== '' ? { priority } : {}),
      ...(typeof language === 'string' && language !== '' ? { language } : {}),
      ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
      ...(typeof queueId === 'string' && queueId !== '' ? { queueId } : {}),
      ...(unread === 'true' || unread === '1' ? { unreadOnly: true } : {}),
      ...(snoozed === 'only' || snoozed === 'exclude' ? { snoozed } : {}),
    });
  }

  /** The merged, ordered timeline (messages + events) of one conversation. */
  @Get('action/conversations/:id/timeline')
  async conversationTimeline(
    @Param('id') id: string,
    @Query('limit') limit: unknown,
    @Query('offset') offset: unknown,
  ) {
    await this.permissions.assert('inboxView');
    return this.conversations.timeline(id, pageOf(limit, offset));
  }

  /** The channel threads attached to the canonical conversation (contract §4). */
  @Get('action/conversations/:id/threads')
  async conversationThreads(@Param('id') id: string) {
    await this.permissions.assert('inboxView');
    return this.conversations.threads(id);
  }

  /** Mark the conversation read for this agent (read-state lives on the canonical record). */
  @HttpCode(200)
  @Post('action/conversations/:id/read')
  async markConversationRead(@Param('id') id: string) {
    await this.permissions.assert('inboxView');
    return this.conversations.markRead(id);
  }

  /** Transition the conversation status — the owner records the event; a Case is never touched. */
  @HttpCode(200)
  @Post('action/conversations/:id/status')
  async setConversationStatus(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('assign');
    const parsed = StatusInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid status input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.conversations.setStatus(id, parsed.data.status);
  }

  /**
   * Run the deterministic routing decision for a conversation (ServiceDesk engine, D2) and apply it
   * through the record owner. Returns the decision so the workspace can explain it.
   */
  @HttpCode(200)
  @Post('action/conversations/:id/route')
  async routeConversation(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('assign');
    const parsed = RouteInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid routing input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.routing.route(id, parsed.data);
  }

  /** Assign to a user or a team, with an optional reason recorded in the conversation history. */
  @HttpCode(200)
  @Post('action/conversations/:id/assign')
  async assignConversation(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('assign');
    const parsed = AssignInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid assignment input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.conversations.assign(id, parsed.data);
  }

  // ---------------------------------------------------------------------------
  // Identity review and linking (19-OM.7) — policy on the Voice records, never a second store
  // ---------------------------------------------------------------------------

  /** Resolve the customer participants, persist the evidence, and name only readable candidates. */
  @Get('action/conversations/:id/identity')
  async conversationIdentity(@Param('id') id: string) {
    await this.permissions.assert('inboxView');
    return this.identities.review(id);
  }

  /** Staff link to a Contact/Lead; the target must be readable and the reason is audited. */
  @HttpCode(200)
  @Post('action/conversations/:id/identity/link')
  async linkIdentity(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('identityLink');
    const parsed = IdentityLinkSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid identity link input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.identities.link(id, parsed.data);
  }

  /** Remove a manual link (the auto evidence is recomputed on the next review). */
  @HttpCode(200)
  @Post('action/conversations/:id/identity/unlink')
  async unlinkIdentity(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('identityLink');
    const parsed = IdentityUnlinkSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid identity unlink input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.identities.unlink(id, parsed.data);
  }

  /** The ambiguous/uncertain links staff must review (contract §6 "visible uncertainty"). */
  @Get('action/identities/conflicts')
  async identityConflicts(@Query('limit') limit: unknown) {
    await this.permissions.assert('identityLink');
    const parsed = Number(limit ?? 50);
    return this.identities.conflicts(Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 200) : 50);
  }

  // ---------------------------------------------------------------------------
  // ServiceDesk hand-off (19-OM.17) — a Case is created by its domain command, never generic CRUD
  // ---------------------------------------------------------------------------

  /** The Case linked to this conversation (read-only context; Case ACL enforced). */
  @Get('action/conversations/:id/case')
  async conversationCase(@Param('id') id: string) {
    return this.handoff.context(id);
  }

  /** Create-or-link a Case for the conversation; idempotent, safe to retry after a failure. */
  @HttpCode(200)
  @Post('action/conversations/:id/case/handoff')
  async handoffConversation(@Param('id') id: string, @Body() body: unknown) {
    const parsed = HandoffSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid hand-off input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.handoff.createOrLink(id, parsed.data);
  }

  /** Conversations linked to one Case (safe fields; the Case read ACL is the gate). */
  @Get('action/cases/:caseId/conversations')
  async caseConversations(@Param('caseId') caseId: string) {
    return this.handoff.conversationsForCase(caseId);
  }

  // ---------------------------------------------------------------------------
  // Call context (19-OM.13) — calls are context, never converted into messages
  // ---------------------------------------------------------------------------

  /** Recent calls the caller may see, each with the customer's existing conversation (or null). */
  @Get('action/calls')
  async recentCalls(@Query('limit') limit: unknown, @Query('offset') offset: unknown) {
    await this.permissions.assert('inboxView');
    return this.calls.recent(pageOf(limit, offset));
  }

  /** The explicit "open conversation" action for one call. */
  @HttpCode(200)
  @Post('action/calls/:id/conversation')
  async openCallConversation(@Param('id') id: string) {
    await this.permissions.assert('inboxView');
    return this.calls.openConversation(id);
  }

  // ---------------------------------------------------------------------------
  // Canned replies and drafts (19-OM.12)
  // ---------------------------------------------------------------------------

  /** Service snippets for this channel (owner store, team/language-filtered, plain text only). */
  @Get('action/snippets')
  async listSnippets(@Query('channel') channel: string | undefined) {
    await this.permissions.assert('inboxView');
    return this.snippets.list(typeof channel === 'string' && channel !== '' ? channel : undefined);
  }

  /** Preview with approved variables only; the rendered body is plain text. */
  @HttpCode(200)
  @Post('action/snippets/:key/preview')
  async previewSnippet(@Param('key') key: string, @Body() body: unknown) {
    const parsed = SnippetPreviewSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid snippet preview input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.snippets.preview(key, parsed.data);
  }

  /** Operational use count — a counter and a timestamp, never the composed message. */
  @HttpCode(200)
  @Post('action/snippets/:key/used')
  async usedSnippet(@Param('key') key: string) {
    return this.snippets.recordUse(key);
  }

  /** The caller's own draft for this conversation (never another agent's). */
  @Get('action/conversations/:id/draft')
  async readDraft(@Param('id') id: string) {
    return this.drafts.get(id);
  }

  @HttpCode(200)
  @Put('action/conversations/:id/draft')
  async saveDraft(@Param('id') id: string, @Body() body: unknown) {
    const parsed = DraftSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid draft input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.drafts.save(id, parsed.data);
  }

  @HttpCode(200)
  @Delete('action/conversations/:id/draft')
  async deleteDraft(@Param('id') id: string) {
    return this.drafts.remove(id);
  }

  /**
   * 19-OM.8 — the reply command. The workspace facade pre-checks the channel/payload, then the owner
   * runs its full pipeline (policy, consent, window, capability, idempotency) and records the state;
   * a policy/consent refusal comes back as named codes the composer can explain.
   */
  @HttpCode(201)
  @Post('action/conversations/:id/messages')
  async sendMessage(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('reply');
    const parsed = SendMessageSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid message input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.conversations.send(id, parsed.data);
  }

  /**
   * E7 — reconcile an unknown delivery outcome by asking the provider, never by repeating a send.
   * Operational, so it asks the replay capability rather than the ordinary reply right.
   */
  @HttpCode(200)
  @Post('action/messages/:id/reconcile')
  async reconcileMessage(@Param('id') id: string) {
    await this.permissions.assert('opsReplay');
    return this.conversations.reconcile(id);
  }

  /**
   * Module health: the platform foundation, the module switch, and the caller's rights.
   * Readable with the inbox capability — an agent who can open the workspace can see why it is
   * not ready; no secret or configuration value is in the answer (plan §8.1).
   */
  @Get('action/health')
  async moduleHealth() {
    await this.permissions.assert('inboxView');
    if (!(await this.settings.workspaceEnabled())) {
      await this.permissions.assert('settingsManage');
    }
    return this.health.health();
  }

  /**
   * What this caller may do — the SPA renders from this answer, not from a guess about roles.
   * Unauthenticated with the endpoint itself: the answer only describes the caller's own rights,
   * and every workspace route still enforces them server-side.
   */
  @Get('action/capabilities')
  async capabilities() {
    return { capabilities: await this.permissions.describe() };
  }

  /** The module's own navigation signal. */
  @Get('action/nav')
  async nav() {
    await this.permissions.assert('inboxView');
    return this.navigation.visibility();
  }

  /**
   * The validated settings document with its warnings and defaults. The document is the module's
   * policy — it is administered, not browsed — so both verbs ask `settingsManage`, the same right
   * the write needs (the `ESignature` precedent).
   */
  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('settingsManage');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('settingsManage');
    // The service deep-merges and validates with the strict schema (unknown keys are refused there),
    // so a new settings section (like `webChat` in 19-OM.9) does not need a second hand-kept copy.
    return this.settings.update(body ?? {});
  }
}
