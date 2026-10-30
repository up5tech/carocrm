import { ValidationError } from '@carocrm/core/errors/index.js';
import { deepMerge, isObject } from '@carocrm/core/utils/object.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { ADVANCED_INTEGRATIONS_SETTINGS_KEY } from './advanced-integrations-module.js';

/**
 * Phase 19-INT.2 — the module's settings
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.2; `19-INT.2`).
 *
 * The platform already owns instance settings (`app_settings`), so this module keeps **one**
 * validated, versioned row named `AdvancedIntegrations` there — the same shape as
 * `VoiceCommunicationsSettingsService`, `SalesSettingsService` and the rest.
 *
 * Rule followed here: **only settings that have an actual consumer**. Every value below is read by
 * delivered code in 19-INT.2–19-INT.5 — the connection service, the OAuth flow or the reauthorization
 * notice. A setting nobody consumes is a false promise in an admin screen.
 *
 * Optional capabilities default **off**: a fresh installation has no connector, so the OAuth flow
 * is off and the module reports exactly that.
 */

export const AdvancedIntegrationsSettingsSchema = z
  .object({
    features: z
      .object({
        /**
         * The connection control plane. On by default: creating a draft connection is harmless and
         * the registry is empty until a connector is registered.
         */
        connections: z.boolean().default(true),
        /**
         * The OAuth flow. **Off** by default: no connector is registered yet, so an authorization
         * could not be completed. A deployment that registers an OAuth connector turns this on.
         */
        oauth: z.boolean().default(false),
        /**
         * The reauthorization notice. Off by default; it needs the scheduled job that 19-INT.5
         * registers, and a deployment opts in once that job runs.
         */
        expiryNotices: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    oauth: z
      .object({
        /**
         * How long an authorization request stays valid, in seconds. The state is single-use and
         * bound to the initiating principal and the connection; the window bounds how long a
         * leaked authorization URL is useful.
         */
        stateTtlSeconds: z.number().int().min(60).max(3600).default(600),
        /**
         * Whether PKCE is sent. Enabled by default where the provider supports it; a provider that
         * does not may turn it off, and the flow then relies on the state binding alone.
         */
        pkce: z.boolean().default(true),
        /**
         * Whether a connection may reach `connected` without holding every scope its provider
         * declares as required. On by default: a connection that is missing a scope must not look
         * usable.
         */
        requireScopes: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    notifications: z
      .object({
        /**
         * How many days before a credential expires the operator is warned. Zero means "warn only
         * on the day it expires".
         */
        reauthorizationWarningDays: z.number().int().min(0).max(90).default(7),
      })
      .strict()
      .prefault({}),
    /**
     * The retention policy (plan §14.3, §16.3).
     *
     * **Off by default.** A purge deletes rows, and a deployment must decide — deliberately, with
     * its own legal and operational policy — that a diagnostic row may be discarded. The default
     * is therefore "keep everything", and the operator turns the purge on.
     *
     * The purge never touches a CRM record. It removes the module's own diagnostics: the redacted
     * payload of an operation, the raw provider payload of a delivery, a resolved conflict, a
     * discarded dead letter, an old run, a decided enrichment result and an old audit row.
     */
    retention: z
      .object({
        /** Whether the scheduled purge runs at all. */
        enabled: z.boolean().default(false),
        /** How long a sync operation's redacted payload is kept. */
        syncOperationsDays: z.number().int().min(1).max(3650).default(30),
        /** How long a webhook delivery's payload is kept. */
        webhookDeliveriesDays: z.number().int().min(1).max(3650).default(14),
        /** How long a resolved conflict is kept. */
        conflictsDays: z.number().int().min(1).max(3650).default(90),
        /** How long a discarded or replayed dead letter is kept. */
        deadLettersDays: z.number().int().min(1).max(3650).default(90),
        /** How long a finished sync run is kept. */
        syncRunsDays: z.number().int().min(1).max(3650).default(90),
        /** How long a decided enrichment result is kept. */
        enrichmentResultsDays: z.number().int().min(1).max(3650).default(30),
        /** How long an audit row is kept. The trail is the longest-lived thing the module writes. */
        auditLogDays: z.number().int().min(1).max(3650).default(365),
        /** How many rows one purge pass removes per table. A bounded pass cannot lock a table. */
        batchSize: z.number().int().min(1).max(10_000).default(1000),
      })
      .strict()
      .prefault({}),
    /**
     * The controlled debug mode (plan §16.2).
     *
     * *"Provide controlled debug mode with expiry, explicit admin authorization, and additional
     * redaction; do not expose debug mode to ordinary users."*
     *
     * So the mode is **off by default**, it **expires** — a forgotten debug mode must not stay on
     * forever — and it never exposes a raw payload. It adds *redacted* diagnostics: the digests,
     * the field names and the error codes that a full payload would have carried. Only an
     * administrator with the module's diagnostic capability may turn it on.
     */
    debug: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * When the debug mode stops working. Null means "no expiry", which the health report
         * flags as a warning — a debug mode without an expiry is a debug mode nobody turns off.
         */
        expiresAt: z.string().datetime().nullish().default(null),
      })
      .strict()
      .prefault({}),
    /**
     * The health thresholds (plan §16.1, §16.3).
     *
     * A connection is not broken because a run failed once. These are the thresholds at which the
     * connection detail starts saying so.
     */
    health: z
      .object({
        /** How old a connection's last successful sync may be before it is reported as lagging. */
        syncLagWarningSeconds: z.number().int().min(60).max(2_592_000).default(86_400),
        /** How many consecutive failed runs are reported as a problem. */
        consecutiveFailureWarning: z.number().int().min(1).max(100).default(3),
        /** How many rejected webhook deliveries are reported as a signature problem. */
        webhookFailureWarning: z.number().int().min(1).max(1000).default(10),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type AdvancedIntegrationsSettings = z.infer<typeof AdvancedIntegrationsSettingsSchema>;

export const DEFAULT_ADVANCED_INTEGRATIONS_SETTINGS: AdvancedIntegrationsSettings =
  AdvancedIntegrationsSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

export function settingsWarnings(settings: AdvancedIntegrationsSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (settings.features.oauth && settings.oauth.pkce === false) {
    warnings.push({
      code: 'oauthWithoutPkce',
      message:
        'PKCE is disabled. Only a provider that does not support PKCE should run without it; the authorization code then relies on the state binding alone.',
    });
  }
  if (settings.features.oauth && settings.oauth.requireScopes === false) {
    warnings.push({
      code: 'oauthWithoutScopeCheck',
      message:
        'Required-scope verification is disabled. A connection may reach "connected" while missing a scope its provider declares as required.',
    });
  }
  if (settings.features.expiryNotices && settings.notifications.reauthorizationWarningDays === 0) {
    warnings.push({
      code: 'expiryNoticeSameDay',
      message: 'Reauthorization warnings are sent only on the day a credential expires.',
    });
  }
  if (settings.debug.enabled && settings.debug.expiresAt === null) {
    warnings.push({
      code: 'debugWithoutExpiry',
      message:
        'The debug mode has no expiry. A debug mode nobody switches off is a debug mode that stays on; set an expiry.',
    });
  }
  if (settings.debug.enabled && settings.debug.expiresAt !== null) {
    const expiresAt = Date.parse(settings.debug.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      warnings.push({
        code: 'debugExpired',
        message: 'The debug mode has expired. It no longer adds any diagnostics.',
      });
    }
  }
  if (settings.retention.enabled && settings.retention.auditLogDays < settings.retention.conflictsDays) {
    warnings.push({
      code: 'auditRetentionShorterThanConflicts',
      message:
        'The audit trail is retained for less time than the conflicts it explains. An operator may need the trail after the conflict is gone.',
    });
  }
  return warnings;
}

/**
 * Whether the debug mode is currently in force.
 *
 * It is on only when it was enabled **and** it has not expired. An expired mode is off, not
 * "on until somebody notices".
 */
export function debugModeActive(settings: AdvancedIntegrationsSettings, now: number = Date.now()): boolean {
  if (!settings.debug.enabled) return false;
  if (settings.debug.expiresAt === null || settings.debug.expiresAt === undefined) return true;
  const expiresAt = Date.parse(settings.debug.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > now;
}

export interface AdvancedIntegrationsSettingsView {
  readonly settings: AdvancedIntegrationsSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: AdvancedIntegrationsSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

@Injectable()
export class AdvancedIntegrationsSettingsService {
  private cache: AdvancedIntegrationsSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<AdvancedIntegrationsSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<AdvancedIntegrationsSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', ADVANCED_INTEGRATIONS_SETTINGS_KEY)
      .executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /**
   * Apply a validated patch. Unknown keys are refused — a typo in a feature name must not be
   * stored and quietly ignored — and every accepted change bumps the settings version, so a
   * decision can be audited against the policy that was in force.
   */
  async update(patch: unknown): Promise<AdvancedIntegrationsSettingsView> {
    if (!isObject(patch)) {
      throw new ValidationError('Advanced Integrations settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = AdvancedIntegrationsSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid Advanced Integrations settings.', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const stored: StoredSettings = {
      version: current.version + 1,
      settings: parsed.data,
      updatedAt: new Date().toISOString(),
      updatedBy: this.scope.principal?.userName ?? this.scope.userId ?? null,
    };
    await writeRow(this.database, stored);
    this.cache = toView(stored);
    return this.cache;
  }

  /** Only tests and explicit reloads call this; the row cache is otherwise write-through. */
  invalidate(): void {
    this.cache = undefined;
  }
}

async function writeRow(database: DatabaseService, stored: StoredSettings): Promise<void> {
  const data = JSON.stringify(stored);
  const now = new Date();
  await database.db
    .insertInto('app_settings')
    .values({ name: ADVANCED_INTEGRATIONS_SETTINGS_KEY, data, modified_at: now })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data, modified_at: now }))
    .execute();
}

function toView(data: unknown): AdvancedIntegrationsSettingsView {
  const stored = isObject(data) ? (data as StoredSettings) : {};
  const parsed = AdvancedIntegrationsSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a default) falls back to
  // defaults for the invalid parts instead of refusing to boot — the health endpoint reports what it found.
  const settings = parsed.success ? parsed.data : DEFAULT_ADVANCED_INTEGRATIONS_SETTINGS;
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_ADVANCED_INTEGRATIONS_SETTINGS,
    warnings: settingsWarnings(settings),
  };
}
