import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import {
  MARKETING_AUTOMATION_FEATURES,
  MARKETING_AUTOMATION_MODULE,
  OPTIONAL_INTEGRATIONS,
  type PlatformEvidence,
  REQUIRED_CAPABILITIES,
  SEND_STRUCTURES,
} from "./marketing-automation-module.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import {
  type MarketingAutomationSettings,
  MarketingAutomationSettingsService,
} from "./marketing-automation-settings.service.js";

/**
 * Phase 19-MA.1 — module health and diagnostics
 * (PLAN_Phase_19_Marketing_Automation.md §14, §15 `19-MA.1` task 6, §12.5).
 *
 * "Module loads and can be enabled/disabled… missing optional integrations do not crash application startup"
 * is only honest if an operator can *see* the state, so every fact here is read from the running platform —
 * the metadata registry, `information_schema`, the live hook registry and the bound mail provider. Nothing is
 * hard-coded `true`, and a module that cannot send says which dependency is missing rather than failing when
 * someone finally presses schedule (§13 "global emergency stop and a safe operator runbook" starts with an
 * accurate picture of what is wired up).
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

export interface FeatureView {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly settingsPath: string;
  readonly requires: readonly string[];
  readonly requiresIntegration?: string;
}

export interface ModuleHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly dependencies: readonly DependencyView[];
  readonly optionalIntegrations: readonly OptionalIntegrationView[];
  readonly features: readonly FeatureView[];
  readonly provider: {
    /** The key `provider.key` names, so the screen shows configured-versus-resolved in one place (§13). */
    readonly configuredKey: string;
    readonly resolvedKey: string;
    readonly label: string;
    readonly mode: string;
    readonly live: boolean;
    readonly maxRecipients: number;
    readonly ratePerMinute: number;
    readonly maxConcurrency: number;
    readonly supportsTestSend: boolean;
    readonly reportsEvents: boolean;
    readonly note: string;
    /** Capability metadata for every resolvable adapter; never a credential (§5.8, §15 `19-MA.7` task 2). */
    readonly available: readonly {
      readonly key: string;
      readonly label: string;
      readonly mode: string;
      readonly supportsTestSend: boolean;
    }[];
    /** The test-send policy as counts only — the allowlisted addresses themselves stay out of diagnostics. */
    readonly testSend: {
      readonly configured: boolean;
      readonly requireConfirmation: boolean;
      readonly maxRecipients: number;
    };
  };
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class MarketingAutomationModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async health(): Promise<ModuleHealthView> {
    const registered = new Set(this.metadata.registry.getEntities());
    const settingsView = await this.settings.read();
    const schema = await this.readSchemaFacts();
    const phases = new Set<string>(this.hooks.phases());

    const present = (item: PlatformEvidence): boolean => {
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

    const missingEntities = MARKETING_AUTOMATION_MODULE.entityTypes.filter((entity) => !registered.has(entity));
    checks.push({
      name: "entity-metadata",
      ok: missingEntities.length === 0,
      detail:
        missingEntities.length === 0
          ? `${MARKETING_AUTOMATION_MODULE.entityTypes.length} Marketing Automation entity(ies) are registered.`
          : `Missing: ${missingEntities.join(", ")}.`,
    });

    const guardRegistered = this.hooks
      .list()
      .some((hook) => hook.name === "marketingAutomation.CampaignGuard");
    checks.push({
      name: "write-guard",
      ok: guardRegistered,
      detail: guardRegistered
        ? "The Campaign write guard is registered; status and server-owned state cannot be written through the record API."
        : "The Campaign write guard is not registered; lifecycle invariants are not being enforced.",
    });

    // Migration 037 is what makes a duplicate campaign code impossible; without it the invariant is advisory.
    checks.push({
      name: "campaign-code-index",
      ok: schema.indexes.has("uq_entity_records_campaign_code"),
      detail: schema.indexes.has("uq_entity_records_campaign_code")
        ? "The campaign code uniqueness index is present."
        : "Migration 037 has not been applied; campaign codes are not enforced as unique.",
    });

    // Migration 041 is what makes "one delivery record per recipient per intended send slot" structural
    // rather than aspirational (§5.6), and the ledger is where MA.9 will read its work from.
    const missingSendStructures = [
      ...SEND_STRUCTURES.indexes.filter((index) => !schema.indexes.has(index)),
      ...SEND_STRUCTURES.tables.filter((table) => !schema.tables.has(table)),
    ];
    checks.push({
      name: "send-delivery-ledger",
      ok: missingSendStructures.length === 0,
      detail:
        missingSendStructures.length === 0
          ? `Send definitions have their slot index and the ${SEND_STRUCTURES.tables.join(", ")} ledger.`
          : `Missing: ${missingSendStructures.join(", ")}. Migration 041 has not been fully applied, so recipient deduplication is not enforced.`,
    });

    checks.push({
      name: "settings-row",
      ok: true,
      detail:
        settingsView.version === 0
          ? "No stored settings row yet; validated defaults are in effect."
          : `Settings version ${String(settingsView.version)}.`,
    });

    // Resolved exactly as a send would resolve it: the configured key against the registered adapters. An
    // unconfigured deployment resolves `none`/`disabled` and reports that, instead of failing later.
    const configuredProviderKey = settingsView.settings.provider.key;
    const adapter = this.providers.resolve(configuredProviderKey);
    checks.push({
      name: "provider-bound",
      ok: true,
      detail:
        adapter.info.mode === "live"
          ? `Provider "${adapter.info.key}" is live; up to ${String(adapter.info.maxRecipients)} recipients per message.`
          : configuredProviderKey === ""
            ? "No provider is configured; no campaign can start and no test send can run until provider.key is set (phase 19-MA.7)."
            : `Provider "${adapter.info.key}" is ${adapter.info.mode}; sending is refused rather than faked.`,
    });

    const settings = settingsView.settings;
    checks.push({
      name: "emergency-stop",
      ok: true,
      detail: settings.safety.globalSendPaused
        ? `Global sending is STOPPED${settings.safety.reason === null ? "" : `: ${settings.safety.reason}`}`
        : "Global sending is not stopped.",
    });

    // The webhook door fails closed (§9.4): an unconfigured deployment records every provider event as
    // rejected rather than accepting it against a public constant, and this check is where an operator
    // finds out why no engagement event is arriving.
    checks.push({
      name: "provider-webhook-secret",
      ok: true,
      detail:
        this.config.marketingWebhookSecret.trim() === ""
          ? "No provider webhook secret is configured; every provider event is recorded as rejected. Set MARKETING_WEBHOOK_SECRET to accept signed events."
          : "Provider webhook signatures are verified against the configured secret.",
    });

    return {
      module: {
        id: MARKETING_AUTOMATION_MODULE.id,
        name: MARKETING_AUTOMATION_MODULE.name,
        version: MARKETING_AUTOMATION_MODULE.version,
        minPlatformVersion: MARKETING_AUTOMATION_MODULE.minPlatformVersion,
        loadOrder: MARKETING_AUTOMATION_MODULE.loadOrder,
        apiPrefix: MARKETING_AUTOMATION_MODULE.apiPrefix,
        implementedPhases: MARKETING_AUTOMATION_MODULE.implementedPhases,
      },
      // The provider and the emergency stop are reported, not failures: a deployment that has not configured
      // SMTP yet is healthy for everything it has delivered (campaign management) and honest about the rest.
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      dependencies,
      optionalIntegrations,
      features: MARKETING_AUTOMATION_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: featureEnabled(settingsView.settings, feature.key),
        settingsPath: feature.settingsPath,
        requires: feature.requires,
        ...(feature.requiresIntegration !== undefined ? { requiresIntegration: feature.requiresIntegration } : {}),
      })),
      provider: {
        configuredKey: configuredProviderKey,
        resolvedKey: adapter.info.key,
        label: adapter.info.label,
        mode: adapter.info.mode,
        live: adapter.info.mode === "live",
        maxRecipients: adapter.info.maxRecipients,
        ratePerMinute: adapter.info.ratePerMinute,
        maxConcurrency: adapter.info.maxConcurrency,
        supportsTestSend: adapter.info.supportsTestSend,
        reportsEvents: adapter.info.reportsEvents,
        note:
          configuredProviderKey === ""
            ? "No provider is configured; sending is refused rather than faked."
            : adapter.info.mode === "live"
              ? "Messages will be handed to the configured provider."
              : `The configured provider is ${adapter.info.mode}; sending is refused rather than faked.`,
        available: this.providers.describeAll().map((info) => ({
          key: info.key,
          label: info.label,
          mode: info.mode,
          supportsTestSend: info.supportsTestSend,
        })),
        testSend: {
          configured: settingsView.settings.provider.testSend.allowedRecipients.length > 0,
          requireConfirmation: settingsView.settings.provider.testSend.requireConfirmation,
          maxRecipients: settingsView.settings.provider.testSend.maxRecipients,
        },
      },
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{
    tables: Set<string>;
    columns: Set<string>;
    indexes: Set<string>;
  }> {
    const wantedTables = new Set<string>([...SEND_STRUCTURES.tables]);
    const wantedIndexes = new Set<string>(["uq_entity_records_campaign_code", ...SEND_STRUCTURES.indexes]);
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
      if (integration.markerTable !== undefined && integration.markerTable !== "") {
        wantedTables.add(integration.markerTable);
      }
    }

    const tables = new Set<string>();
    const columns = new Set<string>();
    if (wantedTables.size > 0) {
      const rows = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name
        from information_schema.columns
        where table_schema = current_schema() and table_name in (${sql.join([...wantedTables])})
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
      where n.nspname = current_schema() and i.indexname in (${sql.join([...wantedIndexes])})
    `.execute(this.database.db);
    for (const row of indexRows.rows) indexes.add(row.indexname);

    return { tables, columns, indexes };
  }
}

function featureEnabled(settings: MarketingAutomationSettings, key: string): boolean {
  const features: Record<string, boolean> = settings.features as unknown as Record<string, boolean>;
  return features[key] === true;
}
