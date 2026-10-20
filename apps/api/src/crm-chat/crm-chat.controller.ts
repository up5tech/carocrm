import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import type { AssistantReadiness } from './crm-chat-assistant.service.js';
import { CRMChatAssistantService } from './crm-chat-assistant.service.js';
import { CRM_CHAT_CONTRACT_VERSION } from './crm-chat-contract.js';
import {
  CRMChatConversationService,
  type CRMChatConversationView,
  type CRMChatMessagePage,
} from './crm-chat-conversations.service.js';
import {
  CRM_CHAT_FEATURES,
  CRM_CHAT_MODULE,
  type CRMChatFeatureKey,
  type CRMChatModuleDescriptor,
} from './crm-chat-module.js';
import { CRMChatModuleHealthService } from './crm-chat-module-health.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';
import {
  CRMChatConversationListQuerySchema,
  CRMChatConversationPatchSchema,
  CRMChatMessageListQuerySchema,
  CRMChatSettingsPatchSchema,
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
    @Inject(CRMChatModuleHealthService) private readonly health: CRMChatModuleHealthService,
    @Inject(CRMChatConversationService) private readonly conversations: CRMChatConversationService,
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
