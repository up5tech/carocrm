import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { PROVIDER_KEY_DOCUSIGN } from './esignature-domain.js';
import {
  DOCUSIGN_PROVIDER_CAPABILITIES,
  ESIGNATURE_FEATURES,
  ESIGNATURE_MODULE,
  ESIGNATURE_SETTINGS_KEY,
  ESIGNATURE_TABLES,
  type ESignaturePlatformEvidence,
  OPTIONAL_INTEGRATIONS,
  PENDING_FEATURES,
  REQUIRED_CAPABILITIES,
} from './esignature-module.js';
import { ESignatureOperationsService } from './esignature-operations.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { type SignatureProviderDescriptor, SignatureProviderRegistry } from './providers/signature-provider.registry.js';

/**
 * Phase 19-ES.1 — module health and the security contract, readable
 * (`PLAN_Phase_19_ESignature.md` §13.5, §14, §18 `19-ES.1`; audit §2).
 *
 * "The module is registered and disabled cleanly when unconfigured" is only honest if an operator
 * can *see* the state, so every fact here is read from the running system: the metadata registry,
 * `information_schema`, the settings row, and the same gate that refuses a provider call. Nothing is
 * hard-coded `true`.
 *
 * Two answers are kept apart on purpose. `ok` says the **platform foundation** this module needs is
 * present — that is what a broken installation would fail. `gate.ready` says whether a provider
 * operation is admitted *today*, and it is `false` in ES.1 for the right reason: no connection
 * exists yet. A module that cannot send anything must say which dependency is missing rather than
 * fail when someone finally presses Send.
 *
 * Nothing in this view is a secret: no credential, no provider body, no integration key value.
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

export interface ESignatureHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly minPlatformVersion: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly frontendRoute: string;
    readonly providerKeys: readonly string[];
    readonly implementedPhases: readonly string[];
  };
  /** The platform foundation this module builds on. */
  readonly ok: boolean;
  readonly dependencies: readonly HealthDependency[];
  readonly optionalIntegrations: readonly HealthIntegration[];
  readonly features: readonly {
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly implemented: boolean;
    readonly effective: boolean;
    readonly settingsPath: string;
    readonly requires: readonly string[];
    readonly pendingPhase: string | null;
  }[];
  /** What the first provider adapter commits to, per operation (plan §5.2). */
  readonly providerCapabilities: Readonly<Record<string, boolean>>;
  /** The adapters actually bound in this build, and in which mode (plan §9.4, ES.3). */
  readonly providerAdapters: readonly SignatureProviderDescriptor[];
  readonly structures: readonly { readonly name: string; readonly present: boolean }[];
  readonly settings: {
    readonly key: string;
    readonly version: number;
    readonly updatedAt: string | null;
    readonly updatedBy: string | null;
    readonly warnings: readonly { code: string; message: string }[];
  };
  /** The single gate in front of every provider call, reported rather than recomputed here. */
  readonly gate: Awaited<ReturnType<ESignatureConnectionGate['assessment']>>;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

@Injectable()
export class ESignatureModuleHealthService {
  constructor(
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(ESignatureConnectionGate) private readonly gate: ESignatureConnectionGate,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(SignatureProviderRegistry) private readonly providers: SignatureProviderRegistry,
    @Inject(ESignatureOperationsService) private readonly operations: ESignatureOperationsService,
  ) {}

  async health(): Promise<ESignatureHealthView> {
    const schema = await this.readSchemaFacts();
    const settingsView = await this.settings.read();
    const entities = new Set(this.metadata.registry.getEntities());
    const phases = new Set<string>(this.hooks.phases());

    const present = (item: ESignaturePlatformEvidence): boolean => {
      switch (item.kind) {
        case 'entity':
          return entities.has(item.value);
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
      const evidence = capability.evidence.map((item) => ({ kind: item.kind, value: item.value, present: present(item) }));
      const missing = evidence.filter((item) => !item.present).map((item) => `${item.kind}:${item.value}`);
      return { id: capability.id, label: capability.label, present: missing.length === 0, evidence, missing };
    });

    const optionalIntegrations: HealthIntegration[] = OPTIONAL_INTEGRATIONS.map((integration) => {
      const found =
        integration.markerTable !== undefined && integration.markerTable !== ''
          ? schema.tables.has(integration.markerTable)
          : integration.markerEntity !== undefined && entities.has(integration.markerEntity);
      return {
        id: integration.id,
        label: integration.label,
        provides: integration.provides,
        present: found,
        status: found ? 'available' : 'unavailable',
      };
    });

    const features = ESIGNATURE_FEATURES.map((feature) => {
      const pending = PENDING_FEATURES.find((entry) => entry.key === feature.key);
      const enabled = (settingsView.settings.features as unknown as Record<string, boolean>)[feature.key] === true;
      return {
        key: feature.key,
        label: feature.label,
        enabled,
        implemented: pending === undefined,
        effective: settingsView.effective[feature.key] === true,
        settingsPath: feature.settingsPath,
        requires: feature.requires,
        pendingPhase: pending?.phase ?? null,
      };
    });

    const structures = ESIGNATURE_TABLES.map((name) => ({ name, present: schema.tables.has(name) }));
    const missingStructures = structures.filter((entry) => !entry.present).map((entry) => entry.name);

    const gate = await this.gate.assessment();
    // The bound adapter answers for the capability surface once one exists; the declared contract is
    // what is reported until then, so an operator never reads "supported" for code that is not there.
    const boundAdapter = this.providers.resolve(PROVIDER_KEY_DOCUSIGN);
    const boundCapabilities = boundAdapter?.capabilities ?? null;
    const adapterMode = boundAdapter?.mode ?? 'none';

    const checks: { name: string; ok: boolean; detail: string }[] = [
      {
        // ES.2 owns the schema, so a missing table is now a real fault: without it, a request cannot
        // be stored and a provider answer has nowhere to land.
        name: 'schema',
        ok: missingStructures.length === 0,
        detail:
          missingStructures.length === 0
            ? `${String(ESIGNATURE_TABLES.length)} signature tables are present.`
            : `Missing: ${missingStructures.join(', ')}. Apply migrations 064_phase19_esignature.sql and 065_phase19_esignature_oauth.sql.`,
      },
      {
        name: 'secret-encryption',
        ok: gate.encryptionConfigured,
        detail: gate.encryptionConfigured
          ? 'ENCRYPTION_KEY is configured, so a provider credential can be stored encrypted.'
          : 'ENCRYPTION_KEY is not configured; no provider credential can be stored or read, so no connection can be used.',
      },
      {
        // Since ES.4 a live DocuSign adapter is bound in production; outside it the fake answers, and
        // saying so is the point — an operator who reads "live" while a fake is bound would believe a
        // connection test contacted a provider. `none` means nothing can be attempted.
        name: 'provider-adapter',
        ok: adapterMode !== 'none',
        detail:
          adapterMode === 'none'
            ? 'No signature provider adapter is bound, so no provider operation can be attempted.'
            : `A "${adapterMode}" adapter is bound for "${PROVIDER_KEY_DOCUSIGN}" (${boundAdapter?.adapterVersion ?? ''}, API ${boundAdapter?.providerApiVersion ?? ''}). A fake adapter can never sign a real contract.`,
      },
      {
        name: 'connection-gate',
        ok: true,
        detail: gate.ready
          ? 'The gate is open: an authorized operation would reach the provider.'
          : `The gate is closed (${gate.reason}). ${gate.detail}`,
      },
      {
        name: 'hmac-policy',
        ok: settingsView.settings.webhooks.requireHmac,
        detail: settingsView.settings.webhooks.requireHmac
          ? 'Connect deliveries must carry a verified account HMAC signature before they can change anything.'
          : 'Connect deliveries are accepted without signature verification. Only a deliberate debugging choice, never a production setting.',
      },
      {
        name: 'embedded-signing',
        ok: !settingsView.settings.features.embeddedSigning || settingsView.settings.signing.embeddedReturnHosts.length > 0,
        detail: settingsView.settings.signing.embeddedReturnHosts.length > 0
          ? `Recipient views may only return to ${String(settingsView.settings.signing.embeddedReturnHosts.length)} allowlisted host(s).`
          : 'No return-host allowlist is configured, so an embedded signing view cannot be generated.',
      },
    ];
    // ES.20: token refresh, Connect secret, recent provider failure, inbox backlog and credential age.
    // These read stored stamps and credential metadata only; a provider outage cannot make this
    // endpoint fail or slow down, and no check calls the provider.
    checks.push(...(await this.operations.healthChecks()));

    return {
      module: {
        id: ESIGNATURE_MODULE.id,
        name: ESIGNATURE_MODULE.name,
        version: ESIGNATURE_MODULE.version,
        minPlatformVersion: ESIGNATURE_MODULE.minPlatformVersion,
        loadOrder: ESIGNATURE_MODULE.loadOrder,
        apiPrefix: ESIGNATURE_MODULE.apiPrefix,
        webhookPrefix: ESIGNATURE_MODULE.webhookPrefix,
        frontendRoute: ESIGNATURE_MODULE.frontendRoute,
        providerKeys: ESIGNATURE_MODULE.providerKeys,
        implementedPhases: ESIGNATURE_MODULE.implementedPhases,
      },
      ok: dependencies.every((dependency) => dependency.present),
      dependencies,
      optionalIntegrations,
      features,
      providerCapabilities: boundCapabilities ?? DOCUSIGN_PROVIDER_CAPABILITIES,
      providerAdapters: this.providers.report(),
      structures,
      settings: {
        key: ESIGNATURE_SETTINGS_KEY,
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        updatedBy: settingsView.updatedBy,
        warnings: settingsView.warnings,
      },
      gate,
      checks,
    };
  }

  private async readSchemaFacts(): Promise<{ tables: Set<string>; columns: Set<string> }> {
    const wantedTables = new Set<string>([...ESIGNATURE_TABLES]);
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
      if (integration.markerTable !== undefined && integration.markerTable !== '') wantedTables.add(integration.markerTable);
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
