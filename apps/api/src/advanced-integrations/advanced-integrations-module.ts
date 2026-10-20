import type { AclAction } from '@carocrm/acl/types/index.js';

import {
  INTEGRATION_CONNECTION_PERMISSION_ENTITY,
  INTEGRATION_CREDENTIAL_PERMISSION_ENTITY,
  INTEGRATION_PERMISSION_ENTITY,
  INTEGRATION_PROVIDER_PERMISSION_ENTITY,
  INTEGRATION_SETTINGS_PERMISSION_ENTITY,
} from './advanced-integrations-domain.js';

/**
 * Phase 19-INT.2 — the module manifest
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.2, §14.1; `19-INT.2`).
 *
 * One place declares what the module is allowed to do and who may do it. The manifest is *code*,
 * not configuration: a capability that is not declared here cannot be checked, and a capability
 * that is declared here is checked by exactly one service
 * (`AdvancedIntegrationsPermissionService`), so a route cannot drift from the matrix.
 *
 * The platform has one authorization engine. A module right is an ACL **resource** evaluated by
 * `AclApiService`, so the request-scoped role snapshot, the `sysAdmin` bypass and the wildcard
 * rule apply unchanged — the pattern `apps/api/src/ai-agents/ai-agents-permission.service.ts`
 * established. This module creates **no roles**: `sysAdmin` holds the platform wildcard `*` and
 * therefore every capability, the default user role holds `{}` and therefore none.
 */

export type AdvancedIntegrationsCapabilityKey =
  | 'use'
  | 'providerAdmin'
  | 'connectionAdmin'
  | 'credentialAdmin'
  | 'authorize'
  | 'settingsAdmin';

export interface AdvancedIntegrationsCapabilityDefinition {
  readonly key: AdvancedIntegrationsCapabilityKey;
  readonly label: string;
  readonly description: string;
  /** The ACL resource the capability is evaluated against. */
  readonly resource: string;
  readonly action: AclAction;
}

export const ADVANCED_INTEGRATIONS_CAPABILITIES: readonly AdvancedIntegrationsCapabilityDefinition[] = [
  {
    key: 'use',
    label: 'Use Advanced Integrations',
    description: 'See the module, its health and the connectors it offers.',
    resource: INTEGRATION_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'providerAdmin',
    label: 'Provider administration',
    description: 'Read the connector catalog and each connector’s capabilities and setup requirements.',
    resource: INTEGRATION_PROVIDER_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'connectionAdmin',
    label: 'Connection administration',
    description: 'Create, configure, pause, resume and delete connections.',
    resource: INTEGRATION_CONNECTION_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'credentialAdmin',
    label: 'Credential administration',
    description: 'Rotate, revoke and remove the credentials a connection holds.',
    resource: INTEGRATION_CREDENTIAL_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'authorize',
    label: 'Authorization administration',
    description: 'Start an OAuth flow, reconnect a connection and revoke a provider grant.',
    resource: INTEGRATION_CONNECTION_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'settingsAdmin',
    label: 'Settings administration',
    description: 'Change the module’s own settings.',
    resource: INTEGRATION_SETTINGS_PERMISSION_ENTITY,
    action: 'edit',
  },
];

/**
 * The module’s settings row in `app_settings`.
 *
 * One validated JSON document per module, the pattern
 * `VoiceCommunicationsSettingsService` established.
 */
export const ADVANCED_INTEGRATIONS_SETTINGS_KEY = 'AdvancedIntegrations';

/**
 * The settings document's shape version.
 *
 * Bumped when the stored document changes shape. A stored document of an unknown version is
 * refused rather than partially interpreted.
 */
export const ADVANCED_INTEGRATIONS_SETTINGS_VERSION = 1;
