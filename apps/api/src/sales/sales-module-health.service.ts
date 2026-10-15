import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { SalesNumberingService } from './document/numbering.service.js';
import type { PlatformEvidence } from './sales-module.js';
import { OPTIONAL_INTEGRATIONS, REQUIRED_PLATFORM_CAPABILITIES, SALES_FEATURES, SALES_MODULE } from './sales-module.js';
import { SALES_ENTITY_TYPES } from './sales-records.js';
import { type SalesSettings,SalesSettingsService } from './sales-settings.service.js';

/**
 * Phase 19-S.1 — module health and diagnostics.
 *
 * "Unavailable optional integrations are reported, not fatal" (PLAN_Phase_19_Sales.md §3.3): the
 * module starts with none of Stripe, Accounting, Customer Success or a variant-enabled catalog
 * installed, and this endpoint is where an operator sees exactly that, together with the settings
 * warnings and the entity/numbering checks that decide whether the module can work at all.
 */

export interface ModuleDependencyView {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  /** Every declared fact, with the result of checking it in this running instance. */
  readonly evidence: readonly { readonly kind: string; readonly value: string; readonly present: boolean }[];
  readonly missing: readonly string[];
}

export interface OptionalIntegrationView {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly present: boolean;
  readonly status: 'available' | 'unavailable';
}

export interface ModuleFeatureView {
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
  readonly dependencies: readonly ModuleDependencyView[];
  readonly optionalIntegrations: readonly OptionalIntegrationView[];
  readonly features: readonly ModuleFeatureView[];
  readonly settings: { readonly version: number; readonly updatedAt: string | null; readonly warnings: readonly string[] };
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class SalesModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(SalesSettingsService) private readonly settings: SalesSettingsService,
    @Inject(SalesNumberingService) private readonly numbering: SalesNumberingService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
  ) {}

  async health(): Promise<ModuleHealthView> {
    const registered = new Set(this.metadata.registry.getEntities());
    const settings = await this.settings.read();
    const schema = await this.readSchemaFacts();
    const phases = new Set<string>(this.hooks.phases());

    const present = (item: PlatformEvidence): boolean => {
      switch (item.kind) {
        case 'entity':
          return registered.has(item.value);
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

    const dependencies: ModuleDependencyView[] = REQUIRED_PLATFORM_CAPABILITIES.map((capability) => {
      const evidence = capability.evidence.map((item) => ({ kind: item.kind, value: item.value, present: present(item) }));
      const missing = evidence.filter((item) => !item.present).map((item) => `${item.kind}:${item.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const optionalIntegrations: OptionalIntegrationView[] = OPTIONAL_INTEGRATIONS.map((integration) => {
      const present = registered.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present,
        status: present ? 'available' : 'unavailable',
      };
    });

    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const missingSalesEntities = SALES_ENTITY_TYPES.filter((entity) => !registered.has(entity));
    checks.push({
      name: 'entity-metadata',
      ok: missingSalesEntities.length === 0,
      detail: missingSalesEntities.length === 0 ? `${SALES_ENTITY_TYPES.length} Sales entities are registered.` : `Missing: ${missingSalesEntities.join(', ')}.`,
    });

    try {
      const series = await this.numbering.list();
      checks.push({
        name: 'numbering',
        ok: series.length > 0,
        detail: series.length === 0 ? 'No document number series are provisioned.' : `${series.length} number series are available.`,
      });
    } catch (error: unknown) {
      checks.push({
        name: 'numbering',
        ok: false,
        detail: error instanceof Error ? error.message : 'Number series could not be read.',
      });
    }

    return {
      module: {
        id: SALES_MODULE.id,
        name: SALES_MODULE.name,
        version: SALES_MODULE.version,
        minPlatformVersion: SALES_MODULE.minPlatformVersion,
        loadOrder: SALES_MODULE.loadOrder,
        apiPrefix: SALES_MODULE.apiPrefix,
        implementedPhases: SALES_MODULE.implementedPhases,
      },
      ok: dependencies.every((dependency) => dependency.present) && checks.every((check) => check.ok),
      dependencies,
      optionalIntegrations,
      features: SALES_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: featureEnabled(settings.settings, feature.key),
        settingsPath: feature.settingsPath,
        requires: feature.requires,
      })),
      settings: {
        version: settings.version,
        updatedAt: settings.updatedAt,
        warnings: settings.warnings.map((warning) => warning.message),
      },
      checks,
    };
  }

  /**
   * The tables and columns the capability facts name, read once from `information_schema`.
   * The names come from the descriptor (never from a request) and are bound as parameters; a
   * missing table is reported as missing evidence rather than failing the whole endpoint.
   */
  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wanted = new Set<string>();
    for (const capability of REQUIRED_PLATFORM_CAPABILITIES) {
      for (const item of capability.evidence) {
        if (item.kind === 'table') wanted.add(item.value);
        if (item.kind === 'column') {
          const table = item.value.split('.')[0];
          if (table !== undefined && table !== '') wanted.add(table);
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

function featureEnabled(settings: SalesSettings, key: string): boolean {
  const features: Record<string, boolean> = settings.features as unknown as Record<string, boolean>;
  return features[key] === true;
}
