import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN,type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { DATA_CLASSES, type DataClass, EFFECT_CLASSES,type EffectClass } from './ai-agents-module.js';

/**
 * Phase 19-AI.2 — the `aiAgents` instance settings row
 * (PLAN_Phase_19_AI_Agents.md §5.1, §12, §19, §20 `19-AI.2`).
 *
 * The platform already owns `app_settings`, so the module keeps **one** validated, versioned row
 * named `aiAgents` — the same shape Marketing Automation, Sales and Service Desk use. Nothing here
 * is a second settings store.
 *
 * Safe-by-default rules:
 *
 *  - `features.execution` is **false** on a fresh installation (§19.2 "install database migrations
 *    and code with global execution disabled by default").
 *  - `safety.globalExecutionPaused` is an operator kill switch; it blocks new runs and high-impact
 *    tool calls without deleting configuration or history (§8.5).
 *  - `dataPolicy.logPrompts` is false: a provider request ledger stores hashes and counters, not
 *    prompts or completions (§16.2).
 */

const EffectClassSchema = z.enum(['read', 'low_write', 'material_write', 'high_impact']);
const DataClassSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);

export const AIAgentsSettingsSchema = z
  .object({
    features: z
      .object({
        definitions: z.boolean().default(true),
        execution: z.boolean().default(false),
        memory: z.boolean().default(false),
        evaluations: z.boolean().default(false),
        eventTriggers: z.boolean().default(false),
        scheduledTriggers: z.boolean().default(false),
        portalAssistant: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    provider: z
      .object({
        /**
         * The connection a new agent starts from. Empty means the administrator must choose one
         * explicitly; the module never infers a provider from whichever connection happens to exist.
         */
        defaultKey: z.string().trim().max(64).default(''),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        /** Finite ceilings every run must respect (§8.3). A published agent cannot raise them. */
        maxSteps: z.number().int().min(1).max(16).default(8),
        maxModelCalls: z.number().int().min(1).max(16).default(8),
        maxToolCalls: z.number().int().min(0).max(32).default(8),
        maxTokens: z.number().int().min(1).max(200_000).default(20_000),
        maxCostUsd: z.number().min(0).max(100).default(1),
        maxElapsedSeconds: z.number().int().min(1).max(600).default(120),
        maxRetries: z.number().int().min(0).max(5).default(2),
        maxConcurrency: z.number().int().min(1).max(20).default(2),
        maxResultBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
      })
      .strict()
      .prefault({}),
    approval: z
      .object({
        /** Effect classes that always require a human decision (§9.2). */
        requireFor: z.array(EffectClassSchema).default(['material_write', 'high_impact']),
        /** How long a pending approval stays actionable; an expired request cannot execute. */
        ttlMinutes: z.number().int().min(1).max(1_440).default(60),
      })
      .strict()
      .prefault({}),
    retention: z
      .object({
        runEventsDays: z.number().int().min(1).max(3650).default(90),
        providerRequestsDays: z.number().int().min(1).max(3650).default(30),
        conversationsDays: z.number().int().min(1).max(3650).default(30),
        evaluationsDays: z.number().int().min(1).max(3650).default(180),
      })
      .strict()
      .prefault({}),
    safety: z
      .object({
        globalExecutionPaused: z.boolean().default(false),
        reason: z.string().trim().max(500).nullable().default(null),
      })
      .strict()
      .prefault({}),
    tools: z
      .object({
        /**
         * Tool keys an administrator has switched off globally (§7.1 `enabled`). A disabled tool is
         * refused at publication and is not offered to a model even if a published version granted it.
         */
        disabled: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
      })
      .strict()
      .prefault({}),
    dataPolicy: z
      .object({
        /**
         * Data classes an external provider may receive. A connection also declares its own
         * allowlist; the intersection is what the gateway enforces (§11.4).
         */
        allowedExternalDataClasses: z.array(DataClassSchema).default(['public', 'internal']),
        /** Off by default; diagnostic capture needs its own retention and permission story. */
        logPrompts: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type AIAgentsSettings = z.infer<typeof AIAgentsSettingsSchema>;
export type { DataClass, EffectClass };

export const DEFAULT_AI_AGENTS_SETTINGS: AIAgentsSettings = AIAgentsSettingsSchema.parse({});

export interface AIAgentsSettingsWarning {
  readonly code: string;
  readonly message: string;
}

export function aiAgentsSettingsWarnings(settings: AIAgentsSettings): AIAgentsSettingsWarning[] {
  const warnings: AIAgentsSettingsWarning[] = [];
  if (!settings.features.definitions) {
    warnings.push({
      code: 'definitionsDisabled',
      message: 'Agent definitions are disabled; draft and version commands are refused but history stays readable.',
    });
  }
  if (!settings.features.execution) {
    warnings.push({
      code: 'executionDisabled',
      message: 'Agent execution is disabled. New runs are refused until an administrator enables features.execution.',
    });
  }
  if (settings.safety.globalExecutionPaused) {
    warnings.push({
      code: 'globalExecutionPaused',
      message: 'Agent execution is stopped globally. No new run may start and no high-impact tool may execute.',
    });
  }
  if (settings.provider.defaultKey === '') {
    warnings.push({
      code: 'providerNotConfigured',
      message: 'No default provider is configured. An agent must name an enabled provider connection before it can publish.',
    });
  }
  if (settings.limits.maxSteps < settings.limits.maxModelCalls) {
    warnings.push({
      code: 'limitMismatch',
      message: 'maxModelCalls is larger than maxSteps, so the step ceiling will stop a run before its model-call budget is used.',
    });
  }
  return warnings;
}

export interface AIAgentsSettingsView {
  readonly settings: AIAgentsSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: AIAgentsSettings;
  readonly warnings: readonly AIAgentsSettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = 'aiAgents';

@Injectable()
export class AIAgentsSettingsService {
  private cache: AIAgentsSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<AIAgentsSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<AIAgentsSettingsView> {
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
   * Apply a validated patch. Unknown keys are refused by the strict schema, and every accepted
   * change bumps the version so a decision can be attributed to the policy in force.
   */
  async update(patch: unknown): Promise<AIAgentsSettingsView> {
    // Defence in depth: the controller checks `policyAdmin`, and the service refuses a direct
    // internal caller without it. A settings write is never authorised by the caller's UI.
    await this.acl.assertAccess('AIAgentPolicy', 'edit');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new ValidationError('AI Agents settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = AIAgentsSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid AI Agents settings.', {
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

  /**
   * The emergency stop, as a named operation instead of a patch an operator has to compose. Pausing
   * and resuming both bump the version and record who did it.
   */
  async setGlobalExecutionPaused(paused: boolean, reason?: string): Promise<AIAgentsSettingsView> {
    return this.update({
      safety: {
        globalExecutionPaused: paused,
        ...(reason === undefined ? {} : { reason }),
      },
    });
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

function toView(data: unknown): AIAgentsSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = AIAgentsSettingsSchema.safeParse(stored.settings ?? {});
  // A row written by an older version that no longer validates falls back to defaults rather than
  // refusing to boot; the health view reports the version and warnings it found.
  const settings = parsed.success ? parsed.data : DEFAULT_AI_AGENTS_SETTINGS;
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_AI_AGENTS_SETTINGS,
    warnings: aiAgentsSettingsWarnings(settings),
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

/** Explicitly referenced so a future narrowing of the enums fails typecheck here, not in the UI. */
export const SETTINGS_EFFECT_CLASSES: readonly EffectClass[] = EFFECT_CLASSES;
export const SETTINGS_DATA_CLASSES: readonly DataClass[] = DATA_CLASSES;
