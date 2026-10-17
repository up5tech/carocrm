import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import {
  CUSTOMER_SUCCESS_FEATURES,
  CUSTOMER_SUCCESS_MODULE,
  OPTIONAL_INTEGRATIONS,
  type PlatformEvidence,
  REQUIRED_CAPABILITIES,
} from "./customer-success-module.js";
import {
  type CustomerSuccessSettings,
  CustomerSuccessSettingsService,
} from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.1 / 19-CS.14 — module health and diagnostics (PLAN_Phase_19_Customer_Success.md §8.2).
 *
 * "Unavailable optional integrations are reported, not fatal": the module starts with no Service
 * Desk and no adoption connector, and this endpoint is where an operator sees exactly that, together
 * with the settings warnings and the entity checks that decide whether the module can work at all.
 * Every fact is read from the running platform — never hard-coded `true`.
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
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class CustomerSuccessModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
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
      const found = registered.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present: found,
        status: found ? "available" : "unavailable",
      };
    });

    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const missingEntities = CUSTOMER_SUCCESS_MODULE.entityTypes.filter((entity) => !registered.has(entity));
    checks.push({
      name: "entity-metadata",
      ok: missingEntities.length === 0,
      detail:
        missingEntities.length === 0
          ? `${CUSTOMER_SUCCESS_MODULE.entityTypes.length} Customer Success entities are registered.`
          : `Missing: ${missingEntities.join(", ")}.`,
    });

    // The Sales marker contract (§12.8): the exact entity name must be present for the shipped
    // Sales integration to report `available`.
    checks.push({
      name: "sales-integration-marker",
      ok: registered.has("CustomerSuccessProfile"),
      detail: registered.has("CustomerSuccessProfile")
        ? "CustomerSuccessProfile is registered; Sales reports the integration as available."
        : "CustomerSuccessProfile is missing; Sales reports the integration as unavailable.",
    });

    const enabledSignals = settingsView.settings.health.signals.filter((signal) => signal.enabled && signal.weight > 0);
    checks.push({
      name: "health-configuration",
      ok: !settingsView.settings.features.healthScoring || enabledSignals.length > 0,
      detail:
        enabledSignals.length === 0
          ? "No weighted health signal is enabled."
          : `${enabledSignals.length} weighted health signal(s) enabled.`,
    });

    checks.push({
      name: "settings-row",
      ok: true,
      detail:
        settingsView.version === 0
          ? "No stored settings row yet; validated defaults are in effect."
          : `Settings version ${String(settingsView.version)}.`,
    });

    return {
      module: {
        id: CUSTOMER_SUCCESS_MODULE.id,
        name: CUSTOMER_SUCCESS_MODULE.name,
        version: CUSTOMER_SUCCESS_MODULE.version,
        minPlatformVersion: CUSTOMER_SUCCESS_MODULE.minPlatformVersion,
        loadOrder: CUSTOMER_SUCCESS_MODULE.loadOrder,
        apiPrefix: CUSTOMER_SUCCESS_MODULE.apiPrefix,
        implementedPhases: CUSTOMER_SUCCESS_MODULE.implementedPhases,
      },
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      dependencies,
      optionalIntegrations,
      features: CUSTOMER_SUCCESS_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: featureEnabled(settingsView.settings, feature.key),
        settingsPath: feature.settingsPath,
        requires: feature.requires,
      })),
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wanted = new Set<string>();
    for (const capability of REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === "table") wanted.add(item.value);
        if (item.kind === "column") {
          const table = item.value.split(".")[0];
          if (table !== undefined && table !== "") wanted.add(table);
        }
      }
    }
    const names = [...wanted];
    if (names.length === 0) return { tables: new Set(), columns: new Set() };
    const rows = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema() and table_name in (${sql.join(names)})
    `.execute(this.database.db);
    const tables = new Set<string>();
    const columns = new Set<string>();
    for (const row of rows.rows) {
      tables.add(row.table_name);
      columns.add(`${row.table_name}.${row.column_name}`);
    }
    return { tables, columns };
  }
}

function featureEnabled(settings: CustomerSuccessSettings, key: string): boolean {
  const features: Record<string, boolean> = settings.features as unknown as Record<string, boolean>;
  return features[key] === true;
}
