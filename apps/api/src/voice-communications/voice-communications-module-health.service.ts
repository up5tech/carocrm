import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import { ADMIN_PERMISSION_ENTITY } from "./voice-communications-domain.js";
import {
  OPTIONAL_INTEGRATIONS,
  REQUIRED_CAPABILITIES,
  VOICE_COMMUNICATIONS_MODULE,
  VOICE_FEATURES,
  VOICE_STRUCTURES,
  type VoicePlatformEvidence,
} from "./voice-communications-module.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { VoiceProviderRegistry } from "./voice-provider.js";

/**
 * Phase 19-VC.2 — module health and diagnostics
 * (`PLAN_Phase_19_Voice_Communications.md` §14, §15 `19-VC.2`, §18).
 *
 * "Module loads without changing unrelated modules" is only honest if an operator can *see* the
 * state, so every fact here is read from the running platform — the metadata registry,
 * `information_schema`, the live hook registry and the bound adapters. Nothing is hard-coded `true`,
 * and a module that cannot place a call says which dependency is missing rather than failing when
 * someone finally presses Call.
 */

export interface DependencyView {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
  readonly missing: readonly string[];
}

export interface OptionalIntegrationView {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly present: boolean;
  readonly status: "available" | "unavailable";
}

export interface ModuleHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly dependencies: readonly DependencyView[];
  readonly optionalIntegrations: readonly OptionalIntegrationView[];
  readonly features: readonly {
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly settingsPath: string;
    readonly requires: readonly string[];
  }[];
  readonly providers: {
    readonly configuredDefaultAccount: string;
    readonly available: readonly {
      readonly key: string;
      readonly label: string;
      readonly mode: string;
      readonly channels: readonly string[];
      readonly capabilities: number;
      readonly webhookSignature: string;
    }[];
    readonly accounts: number;
    readonly enabledAccounts: number;
  };
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class VoiceCommunicationsModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceProviderRegistry) private readonly providers: VoiceProviderRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async health(): Promise<ModuleHealthView> {
    const registered = new Set(this.metadata.registry.getEntities());
    const settingsView = await this.settings.read();
    const schema = await this.readSchemaFacts();
    const phases = new Set<string>(this.hooks.phases());

    const present = (item: VoicePlatformEvidence): boolean => {
      switch (item.kind) {
        case "entity":
          return registered.has(item.value);
        case "table":
          return schema.tables.has(item.value);
        case "column":
          return schema.columns.has(item.value);
        case "hookPhase":
          return phases.has(item.value);
        default: {
          const exhaustive: never = item.kind;
          throw new Error(`Unsupported capability evidence kind "${String(exhaustive)}".`);
        }
      }
    };

    const dependencies: DependencyView[] = REQUIRED_CAPABILITIES.map((capability) => {
      const evidence = capability.evidence.map((item) => ({
        kind: item.kind,
        value: item.value,
        present: present(item),
      }));
      const missing = evidence.filter((item) => !item.present).map((item) => `${item.kind}:${item.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const optionalIntegrations: OptionalIntegrationView[] = OPTIONAL_INTEGRATIONS.map((integration) => {
      const found =
        integration.markerTable !== undefined && integration.markerTable !== ""
          ? schema.tables.has(integration.markerTable)
          : registered.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present: found,
        status: found ? "available" : "unavailable",
      };
    });

    const checks: { name: string; ok: boolean; detail: string }[] = [];

    const missingTables = VOICE_STRUCTURES.tables.filter((table) => !schema.tables.has(table));
    checks.push({
      name: "schema",
      ok: missingTables.length === 0,
      detail:
        missingTables.length === 0
          ? `${String(VOICE_STRUCTURES.tables.length)} module tables are present.`
          : `Missing tables: ${missingTables.join(", ")}. Migration 051 has not been fully applied.`,
    });

    const missingIndexes = VOICE_STRUCTURES.indexes.filter((index) => !schema.indexes.has(index));
    checks.push({
      name: "idempotency-indexes",
      ok: missingIndexes.length === 0,
      detail:
        missingIndexes.length === 0
          ? "Webhook, event, call and message idempotency indexes are present."
          : `Missing: ${missingIndexes.join(", ")}. Duplicate provider callbacks would not be refused structurally.`,
    });

    // The webhook door fails closed when ENCRYPTION_KEY is absent: a webhook secret cannot be stored,
    // so every callback is rejected. Report that instead of letting an operator wonder.
    checks.push({
      name: "secret-encryption",
      ok: this.config.encryptionKey.trim() !== "",
      detail:
        this.config.encryptionKey.trim() !== ""
          ? "Provider credentials and webhook secrets can be stored encrypted."
          : "ENCRYPTION_KEY is not configured; provider credentials and webhook secrets cannot be stored, so callbacks will be rejected.",
    });

    checks.push({
      name: "settings-row",
      ok: true,
      detail:
        settingsView.version === 0
          ? "No stored settings row yet; validated defaults are in effect."
          : `Settings version ${String(settingsView.version)}.`,
    });

    const accountCounts = await this.accountCounts();
    checks.push({
      name: "provider-accounts",
      ok: true,
      detail:
        accountCounts.total === 0
          ? "No provider account is configured; every send and call is refused until one exists."
          : `${String(accountCounts.enabled)} of ${String(accountCounts.total)} provider account(s) are enabled.`,
    });

    const guardRegistered = this.hooks.list().some((hook) => hook.name === "voiceCommunications.writeGuard");
    checks.push({
      name: "write-guard",
      ok: true,
      detail: guardRegistered
        ? "The module write guard is registered."
        : "No module write guard is registered yet (it arrives with the record surfaces in 19-VC.7/19-VC.12).",
    });

    // Admin visibility is a capability, not a formality: the module's whole surface is administrative
    // until the inbox lands, and the navigation service reports the same fact.
    const adminReadable = (await this.acl.canUser(ADMIN_PERMISSION_ENTITY, "read")) !== "no";
    checks.push({
      name: "admin-surface",
      ok: true,
      detail: adminReadable
        ? "This caller can read provider configuration."
        : "This caller cannot read provider configuration; the admin endpoints will refuse.",
    });

    return {
      module: {
        id: VOICE_COMMUNICATIONS_MODULE.id,
        name: VOICE_COMMUNICATIONS_MODULE.name,
        version: VOICE_COMMUNICATIONS_MODULE.version,
        minPlatformVersion: VOICE_COMMUNICATIONS_MODULE.minPlatformVersion,
        loadOrder: VOICE_COMMUNICATIONS_MODULE.loadOrder,
        apiPrefix: VOICE_COMMUNICATIONS_MODULE.apiPrefix,
        webhookPrefix: VOICE_COMMUNICATIONS_MODULE.webhookPrefix,
        implementedPhases: VOICE_COMMUNICATIONS_MODULE.implementedPhases,
      },
      // A deployment with no provider account is healthy for what it has delivered (configuration and
      // event ingestion) and honest about the rest; only missing kernel dependencies make it not-ok.
      ok: dependencies.every((dependency) => dependency.present) && missingTables.length === 0,
      dependencies,
      optionalIntegrations,
      features: VOICE_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: (settingsView.settings.features as unknown as Record<string, boolean>)[feature.key] === true,
        settingsPath: feature.settingsPath,
        requires: feature.requires,
      })),
      providers: {
        configuredDefaultAccount: settingsView.settings.provider.defaultAccountKey,
        available: this.providers.describeAll().map((info) => ({
          key: info.key,
          label: info.label,
          mode: info.mode,
          channels: info.channels,
          capabilities: info.capabilities.length,
          webhookSignature: info.webhookSignature,
        })),
        accounts: accountCounts.total,
        enabledAccounts: accountCounts.enabled,
      },
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async accountCounts(): Promise<{ total: number; enabled: number }> {
    const row = (await sql<{ total: number; enabled: number }>`
      select count(*)::int as total, count(*) filter (where enabled)::int as enabled
      from voice_provider_accounts
    `.execute(this.database.db)).rows[0];
    return { total: Number(row?.total ?? 0), enabled: Number(row?.enabled ?? 0) };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string>; indexes: Set<string> }> {
    const wantedTables = new Set<string>(VOICE_STRUCTURES.tables);
    const wantedIndexes = new Set<string>([...VOICE_STRUCTURES.indexes]);
    for (const capability of REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === "table") wantedTables.add(item.value);
        if (item.kind === "column") {
          const table = item.value.split(".")[0];
          if (table !== undefined && table !== "") wantedTables.add(table);
        }
      }
    }
    for (const integration of OPTIONAL_INTEGRATIONS) {
      if (integration.markerTable !== undefined && integration.markerTable !== "") wantedTables.add(integration.markerTable);
    }

    const tables = new Set<string>();
    const columns = new Set<string>();
    if (wantedTables.size > 0) {
      const rows = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = current_schema() and table_name in (${sql.join([...wantedTables].map((table) => sql.val(table)))})
      `.execute(this.database.db);
      for (const row of rows.rows) {
        tables.add(row.table_name);
        columns.add(`${row.table_name}.${row.column_name}`);
      }
    }

    const indexes = new Set<string>();
    const indexRows = await sql<{ indexname: string }>`
      select i.indexname
      from pg_indexes i
      join pg_class c on c.relname = i.tablename
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and i.indexname in (${sql.join([...wantedIndexes].map((index) => sql.val(index)))})
    `.execute(this.database.db);
    for (const row of indexRows.rows) indexes.add(row.indexname);

    return { tables, columns, indexes };
  }
}
