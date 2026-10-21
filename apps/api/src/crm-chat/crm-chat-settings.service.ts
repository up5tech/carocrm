import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { CRM_CHAT_FEATURES, type CRMChatFeatureKey } from './crm-chat-module.js';
import { CRM_CHAT_MENU_INVALIDATOR, type MenuInvalidator } from './crm-chat-tokens.js';

/**
 * Phase 19-CHAT.2 — the `crmChat` instance settings row
 * (PLAN_Phase_19_CRM_Chat.md §13, §17 `19-CHAT.2`).
 *
 * The platform owns `app_settings`, so the module keeps **one** validated, versioned row named
 * `crmChat` — the same shape `aiAgents`, Marketing, Sales and Service Desk use. Nothing here is a
 * second settings store, and nothing here duplicates provider/model configuration: that stays in
 * `AIAgents`, and Chat only stores the **key** of the agent profile that answers.
 *
 * Safe-by-default rules:
 *
 *  - `features.workspace` is the only flag that starts on; the shell performs no model call and no
 *    mutation, so it can be opened on a fresh install while everything that costs money or writes
 *    data stays off.
 *  - `features.actionProposals` additionally requires `safety.allowWrites`; enabling the feature
 *    without the write switch is reported as a warning and still refuses writes (§13 "separate
 *    read-only analytics and write-action features behind independent switches").
 *  - A flag that declares `requires` is only **effective** when its whole chain is on, so a
 *    deployment cannot end up with a flag that claims a capability its prerequisite cannot deliver.
 */

const CRMChatFeaturesSchema = z
  .object({
    workspace: z.boolean().default(true),
    readTools: z.boolean().default(false),
    helpRetrieval: z.boolean().default(false),
    actionProposals: z.boolean().default(false),
    feedback: z.boolean().default(false),
    conversationSearch: z.boolean().default(false),
  })
  .strict();

export const CRMChatSettingsSchema = z
  .object({
    features: CRMChatFeaturesSchema.default({}),
    assistant: z
      .object({
        /**
         * Stable agent key of the published profile that answers. Empty means "not configured": the
         * workspace renders a setup state instead of a composer. The module never guesses which agent
         * to run — that would route CRM data to whichever profile happened to exist first.
         */
        agentKey: z.string().trim().max(120).default(''),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        /**
         * `queue` hands the run to the durable BullMQ worker, the production default.
         * `inline` starts the same run in the API process right after the turn is accepted, so a
         * single-process development install answers without a separate worker. The run row, lease,
         * quotas and audit trail are identical in both modes.
         */
        mode: z.enum(['queue', 'inline']).default('queue'),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        maxMessageChars: z.number().int().min(1).max(20_000).default(8_000),
        maxContextRefs: z.number().int().min(0).max(20).default(5),
        maxActiveTurnsPerUser: z.number().int().min(1).max(5).default(1),
        maxConversationsPerUser: z.number().int().min(1).max(2_000).default(200),
        turnTimeoutSeconds: z.number().int().min(10).max(600).default(180),
        heartbeatSeconds: z.number().int().min(5).max(60).default(15),
        /** Maximum number of concurrent cross-module queries per user */
        maxConcurrentQueries: z.number().int().min(1).max(10).default(3),
        /** Rate limit: maximum turns per minute per user */
        maxTurnsPerMinute: z.number().int().min(1).max(60).default(10),
        /** Maximum records returned by a single query */
        maxQueryResults: z.number().int().min(1).max(1000).default(100),
      })
      .strict()
      .default({}),
    retention: z
      .object({
        /** Instance ceiling. The `AIAgents` sweeper remains the only retention executor. */
        conversationsDays: z.number().int().min(1).max(3_650).default(30),
      })
      .strict()
      .default({}),
    safety: z
      .object({
        /** Independent write switch. A proposal feature flag alone never authorises a mutation. */
        allowWrites: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

export type CRMChatSettings = z.infer<typeof CRMChatSettingsSchema>;

export const DEFAULT_CRM_CHAT_SETTINGS: CRMChatSettings = CRMChatSettingsSchema.parse({});

export interface CRMChatSettingsWarning {
  readonly code: string;
  readonly message: string;
}

export interface CRMChatSettingsView {
  readonly settings: CRMChatSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: CRMChatSettings;
  readonly warnings: readonly CRMChatSettingsWarning[];
  /** Raw flags as stored. */
  readonly features: Record<CRMChatFeatureKey, boolean>;
  /** Flags after their `requires` chain, which is what behaviour and the UI must use. */
  readonly effectiveFeatures: Record<CRMChatFeatureKey, boolean>;
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = 'crmChat';

/** Every flag with its raw stored value, in descriptor order. */
export function rawFeatureFlags(settings: CRMChatSettings): Record<CRMChatFeatureKey, boolean> {
  const out = {} as Record<CRMChatFeatureKey, boolean>;
  for (const feature of CRM_CHAT_FEATURES) out[feature.key] = settings.features[feature.key];
  return out;
}

/**
 * Resolve the `requires` chain. A flag is effective only when it and every prerequisite are on, so a
 * dependency the UI cannot enforce is enforced here, once.
 */
export function effectiveFeatureFlags(settings: CRMChatSettings): Record<CRMChatFeatureKey, boolean> {
  const raw = rawFeatureFlags(settings);
  const resolved = {} as Record<CRMChatFeatureKey, boolean>;
  const byKey = new Map(CRM_CHAT_FEATURES.map((feature) => [feature.key, feature]));
  const visit = (key: CRMChatFeatureKey, seen: Set<CRMChatFeatureKey>): boolean => {
    const cached = resolved[key];
    if (cached !== undefined) return cached;
    if (seen.has(key)) return false; // a cycle can only come from a descriptor edit; fail closed.
    seen.add(key);
    const feature = byKey.get(key);
    if (feature === undefined) return false;
    if (!raw[key]) {
      resolved[key] = false;
      return false;
    }
    for (const requirement of feature.requires) {
      if (!visit(requirement, seen)) {
        resolved[key] = false;
        return false;
      }
    }
    resolved[key] = true;
    return true;
  };
  for (const feature of CRM_CHAT_FEATURES) visit(feature.key, new Set());
  return resolved;
}

export function crmChatSettingsWarnings(settings: CRMChatSettings): CRMChatSettingsWarning[] {
  const warnings: CRMChatSettingsWarning[] = [];
  const effective = effectiveFeatureFlags(settings);
  if (!settings.features.workspace) {
    warnings.push({
      code: 'workspaceDisabled',
      message: 'The Chat workspace is disabled: the menu entry is hidden and every Chat endpoint answers 403.',
    });
  }
  for (const feature of CRM_CHAT_FEATURES) {
    if (feature.requires.length > 0 && settings.features[feature.key] && !effective[feature.key]) {
      warnings.push({
        code: 'featurePrerequisiteOff',
        message: `"${feature.label}" is on but ${feature.requires.join(', ')} is off, so it stays inactive.`,
      });
    }
  }
  if (settings.features.actionProposals && !settings.safety.allowWrites) {
    warnings.push({
      code: 'writesDisabled',
      message:
        'Action proposals are enabled but safety.allowWrites is off; every write is refused until an administrator enables it.',
    });
  }
  if (settings.assistant.agentKey === '') {
    warnings.push({
      code: 'assistantNotConfigured',
      message: 'No assistant agent is configured. The workspace opens but cannot answer until an agent key is set.',
    });
  }
  return warnings;
}

@Injectable()
export class CRMChatSettingsService {
  private cache: CRMChatSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(CRM_CHAT_MENU_INVALIDATOR) private readonly invalidateMenu: MenuInvalidator,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<CRMChatSettings> {
    return (await this.read()).settings;
  }

  /** Whether one flag is actually in force (its whole `requires` chain resolved). */
  async isFeatureEffective(key: CRMChatFeatureKey): Promise<boolean> {
    return effectiveFeatureFlags(await this.settings())[key];
  }

  async read(): Promise<CRMChatSettingsView> {
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
   * Apply a validated patch. Unknown keys are refused by the strict schema, and every accepted change
   * bumps the version so a decision can be attributed to the policy in force.
   */
  async update(patch: unknown): Promise<CRMChatSettingsView> {
    // Defence in depth: the controller checks `admin`, and the service refuses a direct internal
    // caller without it. A settings write is never authorised by the caller's UI.
    await this.acl.assertAccess('CRMChatAdmin', 'edit');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new ValidationError('CRM Chat settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = CRMChatSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid CRM Chat settings.', {
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
    // The menu is cached per user; a flag write must be visible on the next render (documented in
    // `docs/admin/navigation.md`, which requires a cache drop rather than a TTL wait).
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

function toView(data: unknown): CRMChatSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = CRMChatSettingsSchema.safeParse(stored.settings ?? {});
  // A row written by an older version that no longer validates falls back to defaults rather than
  // refusing to boot; the health view reports the version and warnings it found.
  const settings = parsed.success ? parsed.data : DEFAULT_CRM_CHAT_SETTINGS;
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_CRM_CHAT_SETTINGS,
    warnings: crmChatSettingsWarnings(settings),
    features: rawFeatureFlags(settings),
    effectiveFeatures: effectiveFeatureFlags(settings),
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
