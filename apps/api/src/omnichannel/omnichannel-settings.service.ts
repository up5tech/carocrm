import { FeatureDisabledError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { OMNICHANNEL_FEATURES } from './omnichannel-module.js';

/**
 * Phase 19-OM.2 — the `omnichannel` instance settings row (plan §14 OM.2 feature flags; the shape
 * `crmChat` and `eSignature` use — one validated, versioned document in the platform's
 * `app_settings`, never a second settings store).
 *
 * OM.2 adds exactly one flag: `features.workspace`, the switch the navigation gate and the control
 * plane read. Flags with real infrastructure (web chat, AI drafts, routing policy) arrive with
 * their own sub-phase and default off, so a fresh install cannot accidentally surface a surface
 * that has no implementation behind it.
 */

export type MenuInvalidator = () => void;

/**
 * The kernel must not import a domain module, so `AppModule` binds this token to a lazy
 * `NavigationService` resolver — the same wiring as `CRM_CHAT_MENU_INVALIDATOR`, so a flag write
 * drops the per-user menu cache instead of waiting for the TTL.
 */
export const OMNICHANNEL_MENU_INVALIDATOR = Symbol('OMNICHANNEL_MENU_INVALIDATOR');

/** Default binding for isolated boots; `AppModule` overrides the token with the real resolver. */
export const noopMenuInvalidator: MenuInvalidator = () => {
  /* no menu to drop outside the full application */
};

const OmnichannelFeaturesSchema = z
  .object({
    workspace: z.boolean().default(true),
  })
  .strict();

/**
 * 19-OM.9 — the website chat channel (contract §7). Defaults are closed: the widget serves nothing
 * until an operator switches it on **and** names the origins allowed to embed it. `allowedOrigins`
 * empty means every browser request carrying an `Origin` header is refused (fail closed); a
 * server-to-server call without an Origin header is still allowed so tests and uptime checks work.
 */
const WebChatSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    requireConsent: z.boolean().default(true),
    consentText: z
      .string()
      .trim()
      .max(2000)
      .default('I agree that this chat is stored so the team can reply.'),
    consentVersion: z.string().trim().min(1).max(20).default('1'),
    allowedOrigins: z.array(z.string().trim().url().max(300)).max(20).default([]),
    sessionHours: z.number().int().min(1).max(168).default(24),
    /** New sessions one client address may create per hour (abuse control; resumed sessions excluded). */
    maxSessionsPerHour: z.number().int().min(1).max(1_000).default(30),
    maxMessagesPerMinute: z.number().int().min(1).max(120).default(20),
    maxBodyChars: z.number().int().min(100).max(20_000).default(2_000),
  })
  .strict()
  .prefault({});

/**
 * 19-OM.18 — retention for the artefacts this module owns (drafts, visitor sessions). Message,
 * media and webhook-payload retention belong to their owners (`voice_media.retention_at` sweep in
 * VoiceCommunications; the message-body/webhook classes are documented in
 * `docs/omnichannel/consent-and-retention.md`) — Omnichannel does not duplicate those settings.
 */
const RetentionSettingsSchema = z
  .object({
    /** Stale per-agent drafts are removed after this many days (default 7). */
    staleDraftDays: z.number().int().min(1).max(3_650).default(7),
    /** Expired visitor sessions are removed after this many days past expiry (default 30). */
    expiredSessionDays: z.number().int().min(1).max(3_650).default(30),
  })
  .strict()
  .prefault({});

/**
 * 19-OM.19 — the AI posture. Suggestions are **drafts only**: Omnichannel calls AIAgents' run
 * service with its own typed input and never sends, creates Cases or changes ownership by itself.
 * `agentId` names the published agent profile the operator approved for this use; unset means the
 * assistant is off and every AI endpoint answers an actionable refusal.
 */
const AiSettingsSchema = z
  .object({
    agentId: z.string().trim().max(120).default(''),
    /** Maximum customer-visible messages included in a suggestion prompt. */
    maxContextMessages: z.number().int().min(1).max(50).default(10),
  })
  .strict()
  .prefault({});

export const OmnichannelSettingsSchema = z
  .object({
    features: OmnichannelFeaturesSchema.prefault({}),
    webChat: WebChatSettingsSchema,
    retention: RetentionSettingsSchema,
    ai: AiSettingsSchema,
  })
  .strict();

export type OmnichannelSettings = z.infer<typeof OmnichannelSettingsSchema>;

export const DEFAULT_OMNICHANNEL_SETTINGS: OmnichannelSettings = OmnichannelSettingsSchema.parse({});

export interface OmnichannelSettingsWarning {
  readonly code: string;
  readonly message: string;
}

export interface OmnichannelSettingsView {
  readonly settings: OmnichannelSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: OmnichannelSettings;
  readonly warnings: readonly OmnichannelSettingsWarning[];
  readonly features: Record<string, boolean>;
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = 'omnichannel';

export function omnichannelSettingsWarnings(settings: OmnichannelSettings): OmnichannelSettingsWarning[] {
  const warnings: OmnichannelSettingsWarning[] = [];
  if (!settings.features.workspace) {
    warnings.push({
      code: 'workspaceDisabled',
      message:
        'The Omnichannel workspace is disabled: the menu entry is hidden and the workspace endpoints answer 403. Health, capabilities, navigation, the settings document and the retention purge stay reachable, so an administrator can still inspect the module and switch it back on.',
    });
  }
  if (settings.webChat.enabled && settings.webChat.allowedOrigins.length === 0) {
    warnings.push({
      code: 'webChatNoOrigins',
      message: 'Website chat is enabled but no allowed origin is configured: browser widgets will be refused until an origin is named.',
    });
  }
  if (settings.webChat.enabled && !settings.features.workspace) {
    warnings.push({
      code: 'webChatWithoutWorkspace',
      message: 'Website chat is enabled while the workspace is switched off: nobody could answer the visitors.',
    });
  }
  return warnings;
}

@Injectable()
export class OmnichannelSettingsService {
  private cache: OmnichannelSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(OMNICHANNEL_MENU_INVALIDATOR) private readonly invalidateMenu: MenuInvalidator,
  ) {}

  async settings(): Promise<OmnichannelSettings> {
    return (await this.read()).settings;
  }

  /** Whether a feature flag is in force (its `requires` chain is trivial until more flags exist). */
  async isFeatureEnabled(key: string): Promise<boolean> {
    const feature = OMNICHANNEL_FEATURES.find((candidate) => candidate.key === key);
    if (feature === undefined) return false;
    return (await this.settings()).features[key as keyof OmnichannelSettings['features']] === true;
  }

  /** The effective answer behaviour paths use: off entirely when the module switch is off. */
  async workspaceEnabled(): Promise<boolean> {
    return this.isFeatureEnabled('workspace');
  }

  /**
   * The module switch, as a gate. The workspace surface is dead while it is off: every agent-facing
   * route answers 403, exactly as the settings warning says. The control plane — health,
   * capabilities, navigation, the settings document itself and the retention purge — stays
   * reachable, so an administrator can always inspect the module and switch it back on.
   */
  async assertWorkspace(): Promise<void> {
    if (!(await this.workspaceEnabled())) throw new FeatureDisabledError('Omnichannel workspace');
  }

  async read(): Promise<OmnichannelSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', SETTINGS_ROW)
      .executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /**
   * Apply a validated patch. Unknown keys are refused by the strict schema; every accepted change
   * bumps the version so a decision can be attributed to the policy in force.
   */
  async update(patch: unknown): Promise<OmnichannelSettingsView> {
    // Defence in depth: the controller checks the capability, and the service refuses a direct
    // internal caller without it. A settings write is never authorised by the caller's UI.
    await this.acl.assertAccess('OmnichannelSettings', 'edit');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new ValidationError('Omnichannel settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = OmnichannelSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid Omnichannel settings.', {
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
    this.invalidateMenu();
    return this.cache;
  }

  /** Only tests and explicit reloads need this; the row cache is write-through. */
  invalidate(): void {
    this.cache = undefined;
  }
}

async function writeRow(database: DatabaseService, stored: StoredSettings): Promise<void> {
  const data = JSON.stringify(stored);
  const now = new Date();
  await database.db
    .insertInto('app_settings')
    .values({ name: SETTINGS_ROW, data, modified_at: now })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data, modified_at: now }))
    .execute();
}

function toView(data: unknown): OmnichannelSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = OmnichannelSettingsSchema.safeParse(stored.settings ?? {});
  // A row an older build wrote that no longer validates falls back to defaults rather than
  // refusing to boot; the view still reports the stored version and who set it.
  const settings = parsed.success ? parsed.data : DEFAULT_OMNICHANNEL_SETTINGS;
  const features: Record<string, boolean> = {};
  for (const feature of OMNICHANNEL_FEATURES) {
    features[feature.key] = settings.features[feature.key as keyof OmnichannelSettings['features']] === true;
  }
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_OMNICHANNEL_SETTINGS,
    warnings: omnichannelSettingsWarnings(settings),
    features,
  };
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) merged[key] = deepMerge(current, value);
    else merged[key] = value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
