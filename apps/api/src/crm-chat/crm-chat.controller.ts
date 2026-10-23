import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

import { CRMChatActionService } from './crm-chat-actions.service.js';
import { CRMChatAIAgentsClientService } from './crm-chat-ai-agents-client.service.js';
import type { AssistantReadiness } from './crm-chat-assistant.service.js';
import { CRMChatAssistantService } from './crm-chat-assistant.service.js';
import { CRMChatCitationService } from './crm-chat-citations.service.js';
import { CRM_CHAT_CONTRACT_VERSION } from './crm-chat-contract.js';
import {
  CRMChatConversationService,
  type CRMChatConversationView,
  type CRMChatMessagePage,
} from './crm-chat-conversations.service.js';
import { CRMChatCrossModuleService } from './crm-chat-cross-module.service.js';
import { CRMChatFeedbackService } from './crm-chat-feedback.service.js';
import { CRMChatHelpService } from './crm-chat-help.service.js';
import {
  CRM_CHAT_FEATURES,
  CRM_CHAT_MODULE,
  type CRMChatFeatureKey,
  type CRMChatModuleDescriptor,
} from './crm-chat-module.js';
import { CRMChatModuleHealthService } from './crm-chat-module-health.service.js';
import { CRMChatObservabilityService } from './crm-chat-observability.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';
import { CRMChatPromptService } from './crm-chat-prompts.service.js';
import { CRMChatQueryService, type QueryPlan } from './crm-chat-query.service.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';
import { CRMChatStreamingService } from './crm-chat-streaming.service.js';
import {
  CRMChatConversationListQuerySchema,
  CRMChatConversationPatchSchema,
  CRMChatFeedbackCreateSchema,
  CRMChatMessageListQuerySchema,
  CRMChatPromptCreateSchema,
  CRMChatPromptPatchSchema,
  CRMChatSettingsPatchSchema,
  CRMChatTurnCreateSchema,
} from './dto/crm-chat-shapes.js';

/**
 * Phase 19-CHAT.2 — the `CRMChat` foundation API
 * (PLAN_Phase_19_CRM_Chat.md §8, §13, §17 `19-CHAT.2`).
 *
 * Only the foundation routes exist here: capabilities, diagnostics and the administrative settings
 * row. Conversation, turn, streaming, citation, feedback and prompt routes arrive with their own
 * sub-phases, and they are specified — not implemented — in
 * `docs/architecture/crm-chat-contract.md`.
 *
 * Route shape follows the repository, not the plan's illustrative sketch: a PascalCase resource
 * prefix with `action/…` for commands (`api/v1/AIAgents`, `api/v1/AdvancedIntegrations`). It is
 * registered before `ENTITY_CONTROLLERS`, so the generic `:entity` wildcard can never swallow it.
 *
 * Authorization order is fixed and visible in every route:
 *
 *   1. `GET action/capabilities` — needs the Chat capability but **not** the deployment flag: this is
 *      the endpoint that explains a disabled module, so it must answer while it is off.
 *   2. `GET action/health` — needs the workspace flag; a disabled module's diagnostics are not served.
 *   3. `GET|POST action/settings` — needs the administration capability and **not** the workspace
 *      flag, otherwise disabling Chat would be irreversible through the API.
 */
export interface CRMChatCapabilitiesView {
  readonly module: {
    readonly id: CRMChatModuleDescriptor['id'];
    readonly name: string;
    readonly version: string;
    /** Version of the published contract this API implements (`crm-chat-contract.ts`). */
    readonly contractVersion: string;
    readonly apiPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
  };
  readonly workspace: { readonly enabled: boolean; readonly permitted: boolean };
  readonly capabilities: readonly {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly granted: boolean;
  }[];
  readonly features: readonly {
    readonly key: CRMChatFeatureKey;
    readonly label: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly effective: boolean;
    readonly defaultEnabled: boolean;
    readonly settingsPath: string;
  }[];
  readonly assistant: AssistantReadiness;
  readonly limits: {
    readonly maxMessageChars: number;
    readonly maxContextRefs: number;
    readonly maxActiveTurnsPerUser: number;
    readonly maxConversationsPerUser: number;
    readonly turnTimeoutSeconds: number;
    readonly heartbeatSeconds: number;
  };
  /** What the shell may offer right now, derived on the server, never inferred from a hidden control. */
  readonly actions: {
    readonly canStartTurn: boolean;
    readonly canConfirmWrite: boolean;
    readonly reason: string | null;
  };
}

@ApiTags('crm-chat')
@Controller('api/v1/CRMChat')
export class CRMChatController {
  constructor(
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatPolicyService) private readonly policy: CRMChatPolicyService,
    @Inject(CRMChatSettingsService) private readonly settings: CRMChatSettingsService,
    @Inject(CRMChatAssistantService) private readonly assistant: CRMChatAssistantService,
    @Inject(CRMChatAIAgentsClientService) private readonly aiAgents: CRMChatAIAgentsClientService,
    @Inject(CRMChatCitationService) private readonly citations: CRMChatCitationService,
    @Inject(CRMChatHelpService) private readonly help: CRMChatHelpService,
    @Inject(CRMChatQueryService) private readonly query: CRMChatQueryService,
    @Inject(CRMChatStreamingService) private readonly streaming: CRMChatStreamingService,
    @Inject(CRMChatModuleHealthService) private readonly health: CRMChatModuleHealthService,
    @Inject(CRMChatConversationService) private readonly conversations: CRMChatConversationService,
    @Inject(CRMChatPromptService) private readonly prompts: CRMChatPromptService,
    @Inject(CRMChatFeedbackService) private readonly feedback: CRMChatFeedbackService,
    @Inject(CRMChatActionService) private readonly actions: CRMChatActionService,
    @Inject(CRMChatCrossModuleService) private readonly crossModule: CRMChatCrossModuleService,
    @Inject(CRMChatObservabilityService) private readonly observability: CRMChatObservabilityService,
  ) {}

  /**
   * What this caller may do, and why the workspace is (not) ready. The SPA renders from this answer;
   * a missing capability means the matching endpoint would refuse the call, not that a button is
   * merely hidden.
   */
  @Get('action/capabilities')
  async capabilities(): Promise<CRMChatCapabilitiesView> {
    await this.permissions.assert('use');
    // A caller who cannot read AI Agent definitions sees `unresolvable` instead of a 403, so the
    // workspace explains the prerequisite instead of failing to load.
    const [settingsView, capabilities, assistant] = await Promise.all([
      this.settings.read(),
      this.permissions.describe(),
      this.assistant.readiness(),
    ]);
    const permitted = capabilities.some((capability) => capability.key === 'use' && capability.granted);
    const workspaceEnabled = settingsView.features.workspace && permitted;
    const writesEnabled =
      settingsView.effectiveFeatures.actionProposals && settingsView.settings.safety.allowWrites;
    const assistantReady = assistant.state === 'ready';
    const reason = !settingsView.features.workspace
      ? 'The Chat workspace is disabled by an administrator.'
      : !assistantReady
        ? assistant.reason
        : null;
    return {
      module: {
        id: CRM_CHAT_MODULE.id,
        name: CRM_CHAT_MODULE.name,
        version: CRM_CHAT_MODULE.version,
        contractVersion: CRM_CHAT_CONTRACT_VERSION,
        apiPrefix: CRM_CHAT_MODULE.apiPrefix,
        frontendRoute: CRM_CHAT_MODULE.frontendRoute,
        implementedPhases: CRM_CHAT_MODULE.implementedPhases,
      },
      workspace: { enabled: workspaceEnabled, permitted },
      capabilities,
      features: CRM_CHAT_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        description: feature.description,
        enabled: settingsView.features[feature.key],
        effective: settingsView.effectiveFeatures[feature.key],
        defaultEnabled: feature.defaultEnabled,
        settingsPath: feature.settingsPath,
      })),
      assistant,
      limits: settingsView.settings.limits,
      actions: {
        canStartTurn: workspaceEnabled && assistantReady,
        canConfirmWrite: workspaceEnabled && writesEnabled && assistantReady,
        reason,
      },
    };
  }

  /** Module diagnostics: dependency evidence, feature flags, assistant readiness and safe checks. */
  @Get('action/health')
  async moduleHealth() {
    await this.policy.assertWorkspace();
    return this.health.health();
  }

  /**
   * Conversation surface (19-CHAT.4). Each handler delegates the capability and flag decision to
   * `CRMChatConversationService`, so one operation has exactly one gate and the route cannot drift
   * from the service that actually reads the rows.
   */
  @Get('action/conversations')
  async listConversations(@Query() query: unknown) {
    return this.conversations.list(parse(CRMChatConversationListQuerySchema, query));
  }

  @Get('action/conversations/:id')
  async getConversation(@Param('id') id: string): Promise<{ conversation: CRMChatConversationView; messages: CRMChatMessagePage }> {
    return this.conversations.get(id);
  }

  @Get('action/conversations/:id/messages')
  async listConversationMessages(@Param('id') id: string, @Query() query: unknown): Promise<CRMChatMessagePage> {
    return this.conversations.messages(id, parse(CRMChatMessageListQuerySchema, query));
  }

  @Patch('action/conversations/:id')
  async patchConversation(@Param('id') id: string, @Body() body: unknown): Promise<CRMChatConversationView> {
    return this.conversations.patch(id, parse(CRMChatConversationPatchSchema, body));
  }

  @Delete('action/conversations/:id')
  async deleteConversation(@Param('id') id: string): Promise<{ status: true }> {
    return this.conversations.remove(id);
  }

  // -------------------------------------------------------------------------
  // 19-CHAT.5 — turn submission and lifecycle
  // -------------------------------------------------------------------------

  /**
   * Submit a user message to the assistant agent. The server verifies assistant readiness, creates or
   * continues a conversation thread, and submits the prompt to AIAgents. Returns a turn/run ID for
   * status polling.
   */
  @Post('action/turns')
  async createTurn(@Body() body: unknown) {
    await this.policy.assertWorkspace();
    const input = parse(CRMChatTurnCreateSchema, body);

    // Verify assistant is ready before submitting.
    const readiness = await this.assistant.readiness();
    if (readiness.state !== 'ready' || !readiness.agentId) {
      throw new InvalidQueryError('The assistant agent is not ready.', {
        state: readiness.state,
        reason: readiness.reason,
      });
    }

    // Generate an idempotency key if not provided by the client.
    const idempotencyKey = input.idempotencyKey ?? `crm-chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const result = await this.aiAgents.submitTurn({
      agentId: readiness.agentId,
      prompt: input.prompt,
      conversationId: input.conversationId,
      idempotencyKey,
      contextRefs: input.contextRefs,
    });

    return result;
  }

  /** Retrieve the current status of a turn. */
  @Get('action/turns/:turnId')
  async getTurn(@Param('turnId') turnId: string) {
    await this.policy.assertWorkspace();
    return this.aiAgents.getTurnStatus(turnId);
  }

  /** Request cancellation of a running turn. The turn may complete a step before stopping. */
  @HttpCode(200)
  @Post('action/turns/:turnId/cancel')
  async cancelTurn(@Param('turnId') turnId: string, @Body() body: unknown) {
    await this.policy.assertWorkspace();
    parse(z.object({}).strict(), body);
    return this.aiAgents.cancelTurn(turnId);
  }

  /**
   * SSE stream for a turn's events. The client can resume after a disconnect by sending the
   * Last-Event-ID header. Events are user-safe and never expose tool arguments or hidden reasoning.
   */
  @Get('action/turns/:turnId/events')
  async streamTurnEvents(
    @Param('turnId') turnId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    await this.policy.assertWorkspace();

    // Verify the turn exists and the user has access.
    try {
      await this.aiAgents.getTurnStatus(turnId);
    } catch {
      throw new InvalidQueryError('Turn not found or access denied.');
    }

    // Take over the raw response. Fastify's reply headers are not guaranteed to reach the wire when
    // the handler writes directly to `reply.raw`; without an explicit `text/event-stream` MIME type,
    // the browser's EventSource aborts the connection before the first event is parsed.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if present.
    });
    reply.raw.flushHeaders();

    // Create a writer adapter for the Fastify response.
    const writer = {
      write: (chunk: string) => {
        reply.raw.write(chunk);
      },
      end: () => {
        reply.raw.end();
      },
      onclose: (callback: () => void) => {
        reply.raw.on('close', callback);
      },
    };

    // Stream events to the writer.
    await this.streaming.streamToWriter(turnId, writer, lastEventId);
  }

  /**
   * Search for CRM help content. Answers "how do I" questions by searching Knowledge Base articles
   * and other approved help sources. Retrieved content is treated as untrusted data.
   */
  @Get('action/help/search')
  async searchHelp(@Query('q') query?: string) {
    await this.policy.assertWorkspace();

    if (!query || query.trim().length === 0) {
      throw new InvalidQueryError('Please provide a search query using ?q=your+question');
    }

    return this.help.searchHelp(query);
  }

  /**
   * Execute a validated read-only query with ACL enforcement. The query plan is validated against
   * metadata; no raw SQL is ever executed. List sizes are bounded to prevent unbounded consumption.
   */
  @Post('action/query/execute')
  async executeQuery(@Body() body: unknown) {
    await this.policy.assertWorkspace();

    const schema = z.object({
      entity: z.string().trim().min(1).max(120),
      fields: z.array(z.string().trim().min(1).max(120)).optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
      sort: z.object({
        field: z.string().trim().min(1).max(120),
        direction: z.enum(['asc', 'desc']),
      }).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
    }).strict();

    const input = parse(schema, body);
    return this.query.executeQuery(input as QueryPlan);
  }

  /**
   * Reauthorize citations before rendering. Ensures that each cited source is still accessible to
   * the current user at render time (permissions may have changed since the turn was created).
   *
   * A CRM citation is re-read through the Entity Engine and a handbook citation through `DocsService`,
   * so the answer reflects the caller's *current* rights, not the rights the turn was created under. A
   * citation that is no longer readable is reported as inaccessible rather than rendered with a stale
   * label, and the label and route in the reply are the server's, never the caller's.
   */
  @HttpCode(200)
  @Post('action/citations/reauthorize')
  async reauthorizeCitations(@Body() body: unknown) {
    await this.policy.assertWorkspace();

    const schema = z.object({
      citations: z
        .array(
          z
            .object({
              sourceType: z.enum(['crm_record', 'query_result', 'report', 'help_document', 'approved_external_source']),
              entity: z.string().max(120).nullish(),
              recordId: z.string().max(120).nullish(),
              label: z.string().min(1).max(200),
              route: z.string().max(400).default(''),
            })
            .strict(),
        )
        .max(20),
    });

    const input = parse(schema, body);
    const results = await this.citations.reauthorize(input.citations);

    return { citations: results };
  }

  /** The administration surface. Never returns a credential: Chat stores none. */
  @Get('action/settings')
  async readSettings() {
    await this.permissions.assert('admin');
    return this.settings.read();
  }

  @HttpCode(200)
  @Post('action/settings')
  async updateSettings(@Body() body: unknown) {
    await this.permissions.assert('admin');
    const patch = parse(CRMChatSettingsPatchSchema, body);
    return this.settings.update(patch);
  }

  // -------------------------------------------------------------------------
  // 19-CHAT.12 — action proposals and confirmation
  // -------------------------------------------------------------------------

  /**
   * The authorized projection of one proposal. Chat owns no proposal record: this is a read of the
   * `ai_agent_approvals` row the AIAgents runtime wrote, for a proposal in the caller's own thread.
   */
  @Get('action/actions/:approvalId')
  async getAction(@Param('approvalId') approvalId: string) {
    return this.actions.get(approvalId);
  }

  /**
   * Confirm the proposal. The product gate (`actionProposals` + `safety.allowWrites`) is Chat's;
   * the revalidation — ACL, field rights, record state, proposal hash, expiry — is AIAgents'.
   */
  @HttpCode(200)
  @Post('action/actions/:approvalId/confirm')
  async confirmAction(@Param('approvalId') approvalId: string, @Body() body: unknown) {
    const input = parse(z.object({ note: z.string().trim().min(1).max(1000).optional() }).strict(), body);
    return this.actions.confirm(approvalId, input.note);
  }

  /** Reject the proposal. A rejection never needs the write switch — it removes an intent to write. */
  @HttpCode(200)
  @Post('action/actions/:approvalId/reject')
  async rejectAction(@Param('approvalId') approvalId: string, @Body() body: unknown) {
    const input = parse(z.object({ note: z.string().trim().min(1).max(1000).optional() }).strict(), body);
    return this.actions.reject(approvalId, input.note);
  }

  // -------------------------------------------------------------------------
  // 19-CHAT.14 — saved prompts, feedback and history search
  // -------------------------------------------------------------------------

  /** The caller's own prompt templates. Data only; nothing here is executed by the server. */
  @Get('action/prompts')
  async listPrompts() {
    return this.prompts.list();
  }

  @Post('action/prompts')
  async createPrompt(@Body() body: unknown) {
    const input = parse(CRMChatPromptCreateSchema, body);
    return this.prompts.create(input);
  }

  @Patch('action/prompts/:id')
  async patchPrompt(@Param('id') id: string, @Body() body: unknown) {
    const patch = parse(CRMChatPromptPatchSchema, body);
    return this.prompts.patch(id, patch);
  }

  @Delete('action/prompts/:id')
  async deletePrompt(@Param('id') id: string): Promise<{ status: true }> {
    return this.prompts.remove(id);
  }

  /**
   * Rate the answer a turn produced. One rating per user per answer: a second submission updates
   * the first. The rating is an auditable fact and never changes model behaviour or permissions.
   */
  @HttpCode(200)
  @Post('action/turns/:turnId/feedback')
  async submitFeedback(@Param('turnId') turnId: string, @Body() body: unknown) {
    const input = parse(CRMChatFeedbackCreateSchema, body);
    return this.feedback.submit(turnId, input);
  }

  // -------------------------------------------------------------------------
  // 19-CHAT.11 — cross-module analysis
  // -------------------------------------------------------------------------

  /** The curated cross-module paths this installation can answer. */
  @Get('action/cross-module/scenarios')
  async crossModuleScenarios() {
    await this.policy.assertWorkspace();
    return { list: this.crossModule.scenarios() };
  }

  /**
   * Run one curated cross-module path against a record the caller may read. The caller names a
   * scenario and its root record; the entity, the relations and the bounds are server-owned.
   */
  @HttpCode(200)
  @Post('action/cross-module/analyze')
  async analyzeCrossModule(@Body() body: unknown) {
    await this.policy.assertWorkspace();
    const input = parse(
      z
        .object({
          scenario: z.string().trim().min(1).max(80),
          rootId: z.string().trim().min(1).max(120),
        })
        .strict(),
      body,
    );
    return this.crossModule.run(input.scenario, input.rootId);
  }

  // -------------------------------------------------------------------------
  // 19-CHAT.17 — usage and observability
  // -------------------------------------------------------------------------

  /** The usage of one turn, read from the AIAgents run and its provider ledger. */
  @Get('action/turns/:turnId/usage')
  async turnUsage(@Param('turnId') turnId: string) {
    await this.policy.assertWorkspace();
    return this.observability.usageForTurn(turnId);
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T['_output'] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError('The request is not valid.', {
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return parsed.data;
}
