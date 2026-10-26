import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { OmnichannelCapabilityService } from './omnichannel-capability.service.js';
import { OmnichannelConversationService } from './omnichannel-conversation.service.js';
import { OmnichannelModuleHealthService } from './omnichannel-module-health.service.js';
import { OmnichannelNavigationService } from './omnichannel-navigation.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

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

const SettingsPatchSchema = z
  .object({
    features: z
      .object({
        workspace: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

const StatusInputSchema = z.object({ status: z.string().trim().min(1).max(40) }).strict();
const AssignInputSchema = z
  .object({
    userId: z.string().trim().min(1).max(120).nullable().optional(),
    teamId: z.string().trim().min(1).max(120).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

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
  ) {
    await this.permissions.assert('inboxView');
    const page = pageOf(limit, offset);
    return this.conversations.list({
      ...page,
      ...(typeof status === 'string' && status !== '' ? { status } : {}),
      ...(typeof channel === 'string' && channel !== '' ? { channel } : {}),
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

  /** Assign to a user or a team, with an optional reason recorded in the conversation history. */
  @HttpCode(200)
  @Post('action/conversations/:id/assign')
  async assignConversation(@Param('id') id: string, @Body() body: unknown) {
    await this.permissions.assert('assign');
    const parsed = AssignInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid assignment input.', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return this.conversations.assign(id, parsed.data);
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
    const parsed = SettingsPatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError('Invalid Omnichannel settings patch.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return this.settings.update(parsed.data);
  }
}
