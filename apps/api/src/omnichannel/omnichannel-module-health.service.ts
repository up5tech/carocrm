import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import {
  OMNICHANNEL_CAPABILITIES,
  OMNICHANNEL_DEPENDENCIES,
  OMNICHANNEL_FEATURES,
  OMNICHANNEL_MODULE,
  OMNICHANNEL_OPTIONAL_INTEGRATIONS,
} from './omnichannel-module.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelSettingsService } from './omnichannel-settings.service.js';

/**
 * Phase 19-OM.2 — module health and diagnostics (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`:
 * "module health/diagnostic hooks as appropriate"; the pattern `VoiceCommunicationsModuleHealthService`
 * and `ESignatureModuleHealthService` established).
 *
 * Every fact is read from the running platform — the metadata registry and `information_schema` —
 * never hard-coded `true`. The honest OM.2 answer to "can an agent work here?" is *no, and here is
 * exactly which pieces are missing*: the workspace depends on the VoiceCommunications records (D1)
 * and the queue engine (D2), and this view says whether they are in place, whether the module
 * switch is on, and which rights the caller holds.
 */

export interface OmnichannelDependencyView {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly required: boolean;
  readonly evidence: string;
}

export interface OmnichannelHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly loadOrder: number;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly frontendRoute: string;
    readonly implementedPhases: readonly string[];
    /** Owned tables — empty by decision D1; reported so the emptiness is visible, not implied. */
    readonly ownedTables: readonly string[];
  };
  readonly ok: boolean;
  readonly workspaceReady: boolean;
  readonly dependencies: readonly OmnichannelDependencyView[];
  readonly optionalIntegrations: readonly {
    readonly id: string;
    readonly label: string;
    readonly provides: string;
    readonly present: boolean;
  }[];
  readonly features: readonly {
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly settingsPath: string;
  }[];
  readonly callerRights: readonly { readonly key: string; readonly label: string; readonly granted: boolean }[];
  readonly settings: {
    readonly version: number;
    readonly updatedAt: string | null;
    readonly warnings: readonly string[];
  };
}

@Injectable()
export class OmnichannelModuleHealthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(OmnichannelSettingsService) private readonly settings: OmnichannelSettingsService,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
  ) {}

  async health(): Promise<OmnichannelHealthView> {
    const registered = new Set(this.metadata.registry.getEntities());
    const schema = await this.readSchemaFacts();
    const settingsView = await this.settings.read();

    const dependencies: OmnichannelDependencyView[] = OMNICHANNEL_DEPENDENCIES.map((dependency) => ({
      id: dependency.id,
      label: dependency.label,
      present: dependency.kind === 'entity' ? registered.has(dependency.value) : schema.has(dependency.value),
      required: dependency.required,
      evidence: `${dependency.kind}:${dependency.value}`,
    }));

    const optionalIntegrations = OMNICHANNEL_OPTIONAL_INTEGRATIONS.map((integration) => {
      // Marker by table where the domain has no metadata entity (Portal), marker by entity otherwise.
      const markerTable: string | undefined = 'markerTable' in integration ? integration.markerTable : undefined;
      const present = markerTable !== undefined && markerTable !== '' ? schema.has(markerTable) : registered.has(integration.markerEntity);
      return { id: integration.id, label: integration.label, provides: integration.provides, present };
    });

    const requiredPresent = dependencies.filter((dependency) => dependency.required).every((dependency) => dependency.present);
    const workspaceEnabled = settingsView.settings.features.workspace;

    const callerRights = [];
    for (const capability of OMNICHANNEL_CAPABILITIES) {
      callerRights.push({
        key: capability.key,
        label: capability.label,
        granted: await this.permissions.can(capability.key),
      });
    }

    return {
      module: {
        id: OMNICHANNEL_MODULE.id,
        name: OMNICHANNEL_MODULE.name,
        version: OMNICHANNEL_MODULE.version,
        loadOrder: OMNICHANNEL_MODULE.loadOrder,
        apiPrefix: OMNICHANNEL_MODULE.apiPrefix,
        webhookPrefix: OMNICHANNEL_MODULE.webhookPrefix,
        frontendRoute: OMNICHANNEL_MODULE.frontendRoute,
        implementedPhases: OMNICHANNEL_MODULE.implementedPhases,
        ownedTables: OMNICHANNEL_MODULE.ownedTables,
      },
      // The registration is healthy when the platform pieces it builds on are present; the *workspace*
      // additionally needs the module switch. They are reported separately so "installed but switched
      // off" and "foundation missing" are distinguishable from one answer.
      ok: requiredPresent,
      workspaceReady: requiredPresent && workspaceEnabled,
      dependencies,
      optionalIntegrations,
      features: OMNICHANNEL_FEATURES.map((feature) => ({
        key: feature.key,
        label: feature.label,
        enabled: settingsView.features[feature.key] === true,
        settingsPath: feature.settingsPath,
      })),
      callerRights,
      settings: {
        version: settingsView.version,
        updatedAt: settingsView.updatedAt,
        warnings: settingsView.warnings.map((warning) => warning.message),
      },
    };
  }

  private async readSchemaFacts(): Promise<Set<string>> {
    const rows = await sql<{ name: string }>`
      select table_name as name
      from information_schema.tables
      where table_schema = 'public'
    `.execute(this.database.db);
    return new Set(rows.rows.map((row) => row.name));
  }
}
