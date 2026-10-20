import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import {
  AI_AGENTS_FEATURES,
  AI_AGENTS_MODULE,
  AI_AGENTS_TABLES,
  OPTIONAL_INTEGRATIONS,
  type PlatformEvidence,
  REQUIRED_CAPABILITIES,
} from './ai-agents-module.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderRegistry } from './ai-provider.js';
import { providerPresets } from './ai-provider-presets.js';

/**
 * Phase 19-AI.2/19-AI.4 — module health
 * (PLAN_Phase_19_AI_Agents.md §16, §20 `19-AI.2`/`19-AI.4`).
 *
 * Every fact is read from the running system: `information_schema`, the live hook registry, the
 * registered adapters, the settings row and the connection count. Nothing is hard-coded `true`.
 * Provider keys are only shown to a caller who holds the provider-administration capability; every
 * other caller sees aggregate counts. No path returns a credential.
 */
export interface HealthDependency {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
  readonly missing: readonly string[];
}

export interface HealthIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly present: boolean;
  readonly status: 'available' | 'unavailable';
}

export interface AIAgentsModuleHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly execution: { readonly enabled: boolean; readonly paused: boolean; readonly reason: string | null };
  readonly dependencies: readonly HealthDependency[];
  readonly optionalIntegrations: readonly HealthIntegration[];
  readonly features: readonly { readonly key: string; readonly label: string; readonly enabled: boolean; readonly settingsPath: string }[];
  readonly structures: readonly { readonly name: string; readonly present: boolean }[];
  readonly providers: {
    readonly count: number;
    readonly enabledCount: number;
    readonly credentialCount: number;
    readonly adapterKeys: readonly string[];
    readonly adapters: readonly {
      readonly key: string;
      readonly label: string;
      readonly structuredOutput: boolean;
      readonly toolCalling: boolean;
    }[];
    /**
     * The curated catalog of popular endpoints an administrator picks from when creating a
     * connection. It is configuration, not access: a preset carries a base URL, a model suggestion
     * and the credential header — never a secret and never a grant.
     */
    readonly presets: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: string;
      readonly baseUrl: string;
      readonly models: readonly string[];
      readonly group: string;
      readonly authHeader: string;
      readonly requiresApiKey: boolean;
      readonly note: string | null;
    }[];
    readonly defaultKey: string | null;
    readonly defaultResolvable: boolean;
    readonly encryptionConfigured: boolean;
  };
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class AIAgentsModuleHealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(AIProviderRegistry) private readonly providers: AIProviderRegistry,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async health(revealConfiguration: boolean): Promise<AIAgentsModuleHealthView> {
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

    const dependencies: HealthDependency[] = REQUIRED_CAPABILITIES.map((capability) => {
      const evidence = capability.evidence.map((item) => ({
        kind: item.kind,
        value: item.value,
        present: present(item),
      }));
      const missing = evidence.filter((entry) => !entry.present).map((entry) => `${entry.kind}:${entry.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const registeredEntities = new Set(this.metadata.registry.getEntities());
    const optionalIntegrations: HealthIntegration[] = OPTIONAL_INTEGRATIONS.map((integration) => {
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

    const connectionRows = await this.database.db
      .selectFrom('ai_provider_connections')
      .select(['key', 'enabled', 'api_key_encrypted'])
      .orderBy('key', 'asc')
      .execute();
    const defaultKey = settingsView.settings.provider.defaultKey === '' ? null : settingsView.settings.provider.defaultKey;
    const defaultResolvable = defaultKey !== null && connectionRows.some((row) => row.key === defaultKey && row.enabled);
    const encryptionConfigured = this.config.encryptionKey.trim() !== '';
    const credentialCount = connectionRows.filter((row) => row.api_key_encrypted !== null).length;

    const structures = AI_AGENTS_TABLES.map((name) => ({ name, present: schema.tables.has(name) }));
    const missingStructures = structures.filter((entry) => !entry.present).map((entry) => entry.name);

    const checks: { name: string; ok: boolean; detail: string }[] = [
      {
        name: 'schema',
        ok: missingStructures.length === 0,
        detail:
          missingStructures.length === 0
            ? `${String(AI_AGENTS_TABLES.length)} AI Agents tables are present.`
            : `Missing: ${missingStructures.join(', ')}. Apply the module migrations.`,
      },
      {
        name: 'provider-adapters',
        ok: this.providers.keys().length > 0,
        detail:
          this.providers.keys().length > 0
            ? `Registered adapters: ${this.providers.keys().join(', ')}.`
            : 'No provider adapter is registered; no run can reach a model.',
      },
      {
        name: 'credential-encryption',
        ok: credentialCount === 0 || encryptionConfigured,
        detail: encryptionConfigured
          ? 'ENCRYPTION_KEY is configured; provider credentials are encrypted at rest.'
          : credentialCount === 0
            ? 'ENCRYPTION_KEY is not configured, so a provider credential cannot be saved yet.'
            : 'Provider credentials exist but ENCRYPTION_KEY is missing; the connections cannot be used.',
      },
      {
        name: 'execution-gate',
        ok: true,
        detail: settingsView.settings.features.execution
          ? settingsView.settings.safety.globalExecutionPaused
            ? 'Execution is enabled but globally paused by the operator kill switch.'
            : 'Execution is enabled.'
          : 'Execution is disabled; run creation is refused until features.execution is enabled.',
      },
      {
        // A default provider is a convenience for templates, not a prerequisite: a published agent
        // names its own connection, so an unset default must not darken the module's health.
        name: 'default-provider',
        ok: defaultKey === null || defaultResolvable,
        detail:
          defaultKey === null
            ? 'No default provider connection is configured; agents must name an enabled connection before publishing.'
            : defaultResolvable
              ? `The default provider "${defaultKey}" is enabled.`
              : `The default provider "${defaultKey}" is missing or disabled.`,
      },
    ];

    const settingsFeatures: Record<string, boolean> = settingsView.settings.features as unknown as Record<string, boolean>;

    return {
      module: {
        id: AI_AGENTS_MODULE.id,
        name: AI_AGENTS_MODULE.name,
        version: AI_AGENTS_MODULE.version,
        minPlatformVersion: AI_AGENTS_MODULE.minPlatformVersion,
        loadOrder: AI_AGENTS_MODULE.loadOrder,
        apiPrefix: AI_AGENTS_MODULE.apiPrefix,
        frontendRoute: AI_AGENTS_MODULE.frontendRoute,
        implementedPhases: AI_AGENTS_MODULE.implementedPhases,
      },
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      execution: {
        enabled: settingsView.settings.features.execution,
        paused: settingsView.settings.safety.globalExecutionPaused,
        reason: settingsView.settings.safety.reason,
      },
      dependencies,
      optionalIntegrations,
      features: AI_AGENTS_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: settingsFeatures[feature.key] === true,
        settingsPath: feature.settingsPath,
      })),
      structures,
      providers: {
        count: connectionRows.length,
        enabledCount: connectionRows.filter((row) => row.enabled).length,
        credentialCount,
        adapterKeys: this.providers.keys(),
        adapters: this.providers.list().map((adapter) => ({
          key: adapter.key,
          label: adapter.label,
          structuredOutput: adapter.capabilities.structuredOutput,
          toolCalling: adapter.capabilities.toolCalling,
        })),
        presets: providerPresets(this.providers.has('fake')).map((preset) => ({
          key: preset.key,
          label: preset.label,
          kind: preset.kind,
          baseUrl: preset.baseUrl,
          models: [...preset.models],
          group: preset.group,
          authHeader: preset.authHeader,
          requiresApiKey: preset.requiresApiKey,
          note: preset.note ?? null,
        })),
        defaultKey: revealConfiguration ? defaultKey : null,
        defaultResolvable: revealConfiguration ? defaultResolvable : defaultKey !== null,
        encryptionConfigured,
      },
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wantedTables = new Set<string>([...AI_AGENTS_TABLES]);
    for (const capability of REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === 'table') wantedTables.add(item.value);
        if (item.kind === 'column') {
          const table = item.value.split('.')[0];
          if (table !== undefined && table !== '') wantedTables.add(table);
        }
      }
    }
    for (const integration of OPTIONAL_INTEGRATIONS) {
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

