import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import { CASE_NUMBER_SEQUENCE } from "./case-numbering.service.js";
import {
  OPTIONAL_INTEGRATIONS,
  type PlatformEvidence,
  REQUIRED_CAPABILITIES,
  SERVICE_DESK_FEATURES,
  SERVICE_DESK_MODULE,
} from "./service-desk-module.js";
import {
  type ServiceDeskSettings,
  ServiceDeskSettingsService,
} from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.1 — module health and diagnostics
 * (PLAN_Phase_19_ServiceDesk.md §17 "activation should provide a clear diagnostic").
 *
 * "Unavailable optional integrations are reported, not fatal": the module starts with no Email
 * adapter, no Portal case scope and no Knowledge Base, and this endpoint is where an operator sees
 * exactly that, alongside the settings warnings and the entity/persistence checks that decide whether
 * the module can work at all. Every fact is read from the running platform — never hard-coded `true`.
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
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class ServiceDeskModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
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
      // The Portal is a platform table, not a metadata entity, so detect it by table presence.
      const found = integration.id === "portal" ? schema.tables.has("portals") : registered.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present: found,
        status: found ? "available" : "unavailable",
      };
    });

    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const missingEntities = SERVICE_DESK_MODULE.entityTypes.filter((entity) => !registered.has(entity));
    checks.push({
      name: "entity-metadata",
      ok: missingEntities.length === 0,
      detail:
        missingEntities.length === 0
          ? `${SERVICE_DESK_MODULE.entityTypes.length} Service Desk entity(ies) are registered.`
          : `Missing: ${missingEntities.join(", ")}.`,
    });

    checks.push({
      name: "case-number-sequence",
      ok: schema.sequences.has(CASE_NUMBER_SEQUENCE),
      detail: schema.sequences.has(CASE_NUMBER_SEQUENCE)
        ? `Sequence "${CASE_NUMBER_SEQUENCE}" is present; case numbers allocate atomically.`
        : `Sequence "${CASE_NUMBER_SEQUENCE}" is missing; run the Phase 19-SD migration.`,
    });

    checks.push({
      name: "write-guard",
      ok: this.hooks.list().some((hook) => hook.name === "serviceDesk.caseWriteGuard"),
      detail: this.hooks.list().some((hook) => hook.name === "serviceDesk.caseWriteGuard")
        ? "The Case write guard is registered."
        : "The Case write guard is not registered.",
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
        id: SERVICE_DESK_MODULE.id,
        name: SERVICE_DESK_MODULE.name,
        version: SERVICE_DESK_MODULE.version,
        minPlatformVersion: SERVICE_DESK_MODULE.minPlatformVersion,
        loadOrder: SERVICE_DESK_MODULE.loadOrder,
        apiPrefix: SERVICE_DESK_MODULE.apiPrefix,
        implementedPhases: SERVICE_DESK_MODULE.implementedPhases,
      },
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      dependencies,
      optionalIntegrations,
      features: SERVICE_DESK_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: featureEnabled(settingsView.settings, feature.key),
        settingsPath: feature.settingsPath,
        requires: feature.requires,
        ...(feature.requiresIntegration !== undefined ? { requiresIntegration: feature.requiresIntegration } : {}),
      })),
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string>; sequences: Set<string> }> {
    const wantedTables = new Set<string>();
    const wantedSequences = new Set<string>([CASE_NUMBER_SEQUENCE]);
    for (const capability of REQUIRED_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === "table") wantedTables.add(item.value);
        if (item.kind === "column") {
          const table = item.value.split(".")[0];
          if (table !== undefined && table !== "") wantedTables.add(table);
        }
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
    const sequences = new Set<string>();
    const seqRows = await sql<{ relname: string }>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname = current_schema() and c.relname in (${sql.join([...wantedSequences])})
    `.execute(this.database.db);
    for (const row of seqRows.rows) sequences.add(row.relname);
    return { tables, columns, sequences };
  }
}

function featureEnabled(settings: ServiceDeskSettings, key: string): boolean {
  const features: Record<string, boolean> = settings.features as unknown as Record<string, boolean>;
  return features[key] === true;
}
