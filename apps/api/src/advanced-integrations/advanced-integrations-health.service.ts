import { Inject, Injectable } from '@nestjs/common';

import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';

/**
 * Phase 19-INT.2 — module health and diagnostics
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14; `19-INT.2`).
 *
 * "The module loads cleanly" is only honest if an operator can *see* the state, so every fact here
 * is read from the running platform — the bound connectors, the live settings row and the
 * configured encryption key. Nothing is hard-coded `true`.
 *
 * The report also states the module's own **limits**: which provider families it does not implement
 * yet, so an operator is never left believing a connector exists because the module is healthy.
 */

export interface DependencyView {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly detail: string;
}

export interface ModuleHealthView {
  readonly module: {
    readonly id: string;
    readonly name: string;
    readonly apiPrefix: string;
    readonly webhookPrefix: string;
    readonly implementedPhases: readonly string[];
  };
  readonly ok: boolean;
  readonly dependencies: readonly DependencyView[];
  readonly providers: readonly {
    readonly providerKey: string;
    readonly displayName: string;
    readonly status: string;
    readonly category: string;
    readonly executable: boolean;
    readonly objects: number;
    readonly authentication: string;
  }[];
  readonly features: readonly {
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
  }[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export const ADVANCED_INTEGRATIONS_MODULE = {
  id: 'AdvancedIntegrations',
  name: 'Advanced Integrations',
  apiPrefix: '/api/v1/AdvancedIntegrations',
  webhookPrefix: '/api/v1/integrations/advanced-integrations',
  implementedPhases: [
    '19-INT.1',
    '19-INT.2',
    '19-INT.3',
    '19-INT.4',
    '19-INT.5',
    '19-INT.6',
    '19-INT.7',
    '19-INT.8',
    '19-INT.9',
    '19-INT.10',
    '19-INT.11',
    '19-INT.12',
    '19-INT.13',
    '19-INT.14',
    '19-INT.15',
    '19-INT.16',
    '19-INT.17',
    '19-INT.18',
    '19-INT.19',
    '19-INT.20',
    '19-INT.21',
    '19-INT.22',
    '19-INT.23',
    '19-INT.24',
  ],
} as const;

@Injectable()
export class AdvancedIntegrationsHealthService {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(IntegrationRegistry) private readonly registry: IntegrationRegistry,
    @Inject(AdvancedIntegrationsSettingsService) private readonly settings: AdvancedIntegrationsSettingsService,
    @Inject(AdvancedIntegrationsPermissionService) private readonly permissions: AdvancedIntegrationsPermissionService,
  ) {}

  async health(): Promise<ModuleHealthView> {
    const settings = await this.settings.read();
    const encryptionKeyPresent = this.config.encryptionKey.trim() !== '';

    const dependencies: DependencyView[] = [
      {
        id: 'encryptionKey',
        label: 'ENCRYPTION_KEY',
        present: encryptionKeyPresent,
        detail: encryptionKeyPresent
          ? 'Credentials are encrypted at rest.'
          : 'ENCRYPTION_KEY is not configured, so no credential can be stored. The module refuses to store one.',
      },
      {
        id: 'oauthFeature',
        label: 'OAuth flow',
        present: settings.settings.features.oauth,
        detail: settings.settings.features.oauth
          ? 'The OAuth flow is enabled.'
          : 'The OAuth flow is disabled. No connector can be authorized until it is enabled.',
      },
    ];

    const providers = this.registry.describeAll().map((provider) => ({
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      status: provider.status,
      category: provider.category,
      executable: provider.executable,
      objects: provider.capabilities.objects.length,
      authentication: provider.capabilities.authentication,
    }));

    const warnings = [...settings.warnings];
    if (providers.length === 0) {
      warnings.push({
        code: 'noProviders',
        message:
          'No connector is registered yet. The control plane is available, but nothing can be connected until a connector phase delivers one.',
      });
    }

    return {
      module: ADVANCED_INTEGRATIONS_MODULE,
      ok: encryptionKeyPresent && providers.length > 0,
      dependencies,
      providers,
      features: [
        { key: 'connections', label: 'Connections', enabled: settings.settings.features.connections },
        { key: 'oauth', label: 'OAuth', enabled: settings.settings.features.oauth },
        { key: 'expiryNotices', label: 'Expiry notices', enabled: settings.settings.features.expiryNotices },
      ],
      warnings,
    };
  }

  /** The provider catalog, for the admin UI. */
  async catalog(): Promise<readonly {
    readonly providerKey: string;
    readonly displayName: string;
    readonly description: string;
    readonly category: string;
    readonly status: string;
    readonly executable: boolean;
  }[]> {
    const visible = await this.permissions.can('providerAdmin');
    if (!visible) return [];
    return this.registry.describeAll().map((provider) => ({
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      description: provider.description,
      category: provider.category,
      status: provider.status,
      executable: provider.executable,
    }));
  }
}
