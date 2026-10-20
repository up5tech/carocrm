import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { AssistantReadiness } from './crm-chat-assistant.service.js';
import { CRMChatAssistantService } from './crm-chat-assistant.service.js';
import {
  CRM_CHAT_FEATURES,
  CRM_CHAT_MODULE,
  CRM_CHAT_OPTIONAL_INTEGRATIONS,
  CRM_CHAT_REQUIRED_CAPABILITIES,
  CRM_CHAT_TABLES,
  type CRMChatFeatureKey,
  type PlatformEvidence,
} from './crm-chat-module.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';

/**
 * Phase 19-CHAT.2 — module health
 * (PLAN_Phase_19_CRM_Chat.md §13, §15.3, §17 `19-CHAT.2`).
 *
 * Every fact is read from the running system: `information_schema`, the live hook registry, the
 * metadata registry, the Chat settings row and the owner module's readiness. Nothing is hard-coded
 * `true`, and the view contains no credential, prompt or record value — it names structures and
 * states, which is what an operator needs to answer "why can nobody chat?".
 */
export interface CRMChatHealthDependency {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
  readonly missing: readonly string[];
}

export interface CRMChatHealthIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly present: boolean;
  readonly status: 'available' | 'unavailable';
}

export interface CRMChatModuleHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
    readonly dependsOn: readonly string[];
  };
  readonly ok: boolean;
  readonly workspace: { readonly enabled: boolean };
  readonly assistant: AssistantReadiness;
  readonly dependencies: readonly CRMChatHealthDependency[];
  readonly optionalIntegrations: readonly CRMChatHealthIntegration[];
  readonly features: readonly {
    readonly key: CRMChatFeatureKey;
    readonly label: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly effective: boolean;
    readonly defaultEnabled: boolean;
    readonly settingsPath: string;
  }[];
  /** Structures the module owns: citations, feedback and saved prompts (19-CHAT.3). */
  readonly structures: readonly { readonly name: string; readonly present: boolean }[];
  readonly settings: { readonly version: number; readonly updatedAt: string | null; readonly warnings: readonly string[] };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class CRMChatModuleHealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(CRMChatSettingsService) private readonly settings: CRMChatSettingsService,
    @Inject(CRMChatAssistantService) private readonly assistant: CRMChatAssistantService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  async health(): Promise<CRMChatModuleHealthView> {
    const settingsView = await this.settings.read();
    const schema = await this.readSchemaFacts();
    const phases = new Set<string>(this.hooks.phases());

    const present = (item: PlatformEvidence): boolean => {
      switch (item.kind) {
        case 'entity':
          return this.metadata.registry.hasEntity(item.value);
        case 'table':
          return schema.tables.has(item.value);
        case 'column':
          return schema.columns.has(item.value);
        case 'hookPhase':
          return phases.has(item.value);
        default: {
          const exhaustive: never = item.kind;
          throw new Error(`Unsupported capability evidence kind "${String(exhaustive)}".`);
        }
      }
    };

    const dependencies: CRMChatHealthDependency[] = CRM_CHAT_REQUIRED_CAPABILITIES.map((capability) => {
      const evidence = capability.evidence.map((item) => ({
        kind: item.kind,
        value: item.value,
        present: present(item),
      }));
      const missing = evidence.filter((entry) => !entry.present).map((entry) => `${entry.kind}:${entry.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const registeredEntities = new Set(this.metadata.registry.getEntities());
    const optionalIntegrations: CRMChatHealthIntegration[] = CRM_CHAT_OPTIONAL_INTEGRATIONS.map((integration) => {
      const found =
        integration.markerTable !== undefined && integration.markerTable !== ''
          ? schema.tables.has(integration.markerTable)
          : registeredEntities.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present: found,
        status: found ? 'available' : 'unavailable',
      };
    });

    const structures = CRM_CHAT_TABLES.map((name) => ({ name, present: schema.tables.has(name) }));
    const missingStructures = structures.filter((entry) => !entry.present).map((entry) => entry.name);
    const assistant = await this.assistant.readiness();
    const workspaceEnabled = settingsView.features.workspace;

    const checks: { name: string; ok: boolean; detail: string }[] = [
      {
        name: 'schema',
        ok: missingStructures.length === 0,
        detail:
          CRM_CHAT_TABLES.length === 0
            ? 'The module owns no tables yet; conversations stay in the AI Agents store.'
            : missingStructures.length === 0
              ? `${String(CRM_CHAT_TABLES.length)} CRM Chat tables are present (citations, feedback, saved prompts).`
              : `Missing: ${missingStructures.join(', ')}. Apply the module migration (062_phase19_crm_chat.sql).`,
      },
      {
        name: 'workspace',
        ok: workspaceEnabled,
        detail: workspaceEnabled
          ? 'The workspace is enabled; the menu entry is visible to holders of the Chat capability.'
          : 'The workspace is disabled: the menu entry is hidden and every Chat endpoint answers 403.',
      },
      {
        name: 'assistant',
        ok: assistant.state === 'ready',
        detail: assistant.reason,
      },
      {
        name: 'conversation-store',
        ok: assistant.state === 'ready' || assistant.state === 'not-configured',
        detail:
          'Conversation and message history are owned by AI Agents (`ai_agent_conversations`, `ai_agent_messages`); Chat reuses them and adds no competing store.',
      },
      {
        name: 'owner-module',
        ok: dependencies.find((entry) => entry.id === 'aia-runs')?.present === true,
        detail:
          dependencies.find((entry) => entry.id === 'aia-runs')?.present === true
            ? 'The AI Agents run engine is present; Chat delegates every model call and tool invocation to it.'
            : 'The AI Agents run engine tables are missing; Chat cannot answer anything.',
      },
    ];

    return {
      module: {
        id: CRM_CHAT_MODULE.id,
        name: CRM_CHAT_MODULE.name,
        version: CRM_CHAT_MODULE.version,
        minPlatformVersion: CRM_CHAT_MODULE.minPlatformVersion,
        loadOrder: CRM_CHAT_MODULE.loadOrder,
        apiPrefix: CRM_CHAT_MODULE.apiPrefix,
        frontendRoute: CRM_CHAT_MODULE.frontendRoute,
        implementedPhases: CRM_CHAT_MODULE.implementedPhases,
        dependsOn: CRM_CHAT_MODULE.dependsOn,
      },
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      workspace: { enabled: workspaceEnabled },
      assistant,
      dependencies,
      optionalIntegrations,
      features: CRM_CHAT_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        description: feature.description,
        enabled: settingsView.features[feature.key],
        effective: settingsView.effectiveFeatures[feature.key],
        defaultEnabled: feature.defaultEnabled,
        settingsPath: feature.settingsPath,
      })),
      structures,
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wantedTables = new Set<string>([...CRM_CHAT_TABLES]);
    for (const capability of CRM_CHAT_REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === 'table') wantedTables.add(item.value);
        if (item.kind === 'column') {
          const table = item.value.split('.')[0];
          if (table !== undefined && table !== '') wantedTables.add(table);
        }
      }
    }
    for (const integration of CRM_CHAT_OPTIONAL_INTEGRATIONS) {
      if (integration.markerTable !== undefined && integration.markerTable !== '') {
        wantedTables.add(integration.markerTable);
      }
    }

    const tables = new Set<string>();
    const columns = new Set<string>();
    if (wantedTables.size === 0) return { tables, columns };
    const rows = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema() and table_name in (${sql.join([...wantedTables])})
    `.execute(this.database.db);
    for (const row of rows.rows) {
      tables.add(row.table_name);
      columns.add(`${row.table_name}.${row.column_name}`);
    }
    return { tables, columns };
  }
}
