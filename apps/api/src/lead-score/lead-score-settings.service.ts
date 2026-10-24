import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { LEADSCORE_SETTINGS_ROW } from './lead-score-domain.js';
import { LEADSCORE_FEATURES, LEADSCORE_PENDING_FEATURES, type LeadScoreFeatureDescriptor } from './lead-score-module.js';

/**
 * Phase 19-LS.1 — the `leadScore` settings document
 * (`PLAN_Phase_19_LeadScore.md` §15.2, §16 `19-LS.1`; audit §1, §9 D13).
 *
 * The platform already owns instance settings (`app_settings`), so this module adds no second store:
 * it keeps one validated, versioned row named `leadScore`, exactly like `Sales`, `CustomerSuccess`,
 * `MarketingAutomation` and `ESignature` do.
 *
 * **The document holds only what this build reads.** The module switch and the feature switches are
 * consumed by `LeadScoreFeatureGate`, the health view and the capability answer; nothing else has a
 * reader yet. A scoring scale, a batch size or a conversion target list stored now would be
 * configuration that lies — it would look administered while no code consulted it — so each later
 * phase adds the section it actually reads, in its own commit.
 *
 * Every accepted change bumps `version`, so a stored evaluation or a conversion operation can name the
 * policy it was produced under (the pattern plan §5.1 requires of a model version).
 */

const FeatureFlagsSchema = z
  .object({
    modelAdministration: z.boolean().default(false),
    scoringPreview: z.boolean().default(false),
    scoring: z.boolean().default(false),
    scoreExplanation: z.boolean().default(false),
    manualRecalculation: z.boolean().default(false),
    eventRecalculation: z.boolean().default(false),
    batchRecalculation: z.boolean().default(false),
    thresholdNotifications: z.boolean().default(false),
    engagementSignals: z.boolean().default(false),
    duplicateDetection: z.boolean().default(false),
    fieldMapping: z.boolean().default(false),
    conversionPreview: z.boolean().default(false),
    leadConversion: z.boolean().default(false),
    conversionRecovery: z.boolean().default(false),
    opportunityConversion: z.boolean().default(false),
    aiInsight: z.boolean().default(false),
  })
  .strict();

/**
 * The policy section 19-LS.5 and 19-LS.6 read: which published model a score is computed under, and how
 * long a Lead waits after a change before it is recomputed.
 *
 * Plan §5.1 and audit §5.1 choose **one active published model** rather than a per-lead or multi-model
 * policy, and the choice has to live somewhere an administrator can see and change — that is this key, not
 * a convention like "the newest published version", because publishing a version must not silently decide
 * what every future score means while somebody is mid-way through a revision (plan §6.1, §9.3).
 *
 * The id is validated on **read**, by the calculation service, which is the only thing that can answer
 * whether the row exists and is published. Checking it here would mean the settings document owning a
 * second copy of a fact the record store already holds — and a stale copy of that check would then let a
 * bad id be saved the moment a model was archived.
 *
 * `debounceSeconds` is plan §10.2's debounce, and it is the difference between one job per Lead and one
 * job per keystroke: a person correcting a Lead often saves three times in a minute. It is capped in
 * seconds because a window long enough to matter for a queue is also long enough to make a score arrive
 * after the call that was made about the Lead.
 */
const ScoringSectionSchema = z
  .object({
    activeModelId: z.string().trim().min(1).max(64).nullable().default(null),
    debounceSeconds: z.number().int().min(0).max(900).default(60),
  })
  .strict();

export const LeadScoreSettingsSchema = z
  .object({
    /**
     * The master switch. Off by default: plan §15.2 stage 1 is "deploy schema/metadata with scoring
     * disabled and conversion behavior unchanged", and the core Lead lifecycle must keep working
     * exactly as it does today whether or not this module is installed.
     */
    enabled: z.boolean().default(false),
    features: FeatureFlagsSchema.default({}),
    scoring: ScoringSectionSchema.default({}),
  })
  .strict();

export type LeadScoreSettings = z.infer<typeof LeadScoreSettingsSchema>;

export const DEFAULT_LEADSCORE_SETTINGS: LeadScoreSettings = LeadScoreSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

export interface LeadScoreSettingsView {
  readonly settings: LeadScoreSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: LeadScoreSettings;
  readonly warnings: readonly SettingsWarning[];
  /** Feature keys whose implementation lands in a later sub-phase, with that phase. */
  readonly pendingFeatures: readonly { readonly key: string; readonly phase: string }[];
  /** Enabled **and** implemented **and** its requirements met — what the gate and the UI read. */
  readonly effective: Record<string, boolean>;
}

interface StoredSettings {
  enabled?: unknown;
  features?: unknown;
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

@Injectable()
export class LeadScoreSettingsService {
  private cache: LeadScoreSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for calculation paths; defaults when the row is absent. */
  async settings(): Promise<LeadScoreSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<LeadScoreSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', LEADSCORE_SETTINGS_ROW)
      .executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /** The module switch on its own — the cheapest question the gate and the menu both ask. */
  async enabled(): Promise<boolean> {
    return (await this.settings()).enabled;
  }

  /**
   * Whether a feature may run *today*: the switch is on, its requirements are satisfied, and its
   * implementing sub-phase has shipped. A pending flag is never effective.
   */
  async featureEnabled(key: string): Promise<boolean> {
    const view = await this.read();
    return view.effective[key] === true;
  }

  /**
   * Apply a validated patch. Unknown keys are refused and every accepted change bumps the version, so
   * an operator can tell which policy was in force when a score or a conversion was produced.
   */
  async update(patch: unknown): Promise<LeadScoreSettingsView> {
    if (!isRecord(patch)) {
      throw new ValidationError('Lead Score settings must be an object.');
    }
    const current = await this.read();
    const merged = deepMerge(current.settings as unknown as Record<string, unknown>, patch);
    const parsed = LeadScoreSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid Lead Score settings.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const version = current.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = this.scope.principal?.userName ?? this.scope.userId ?? null;
    const stored: StoredSettings = { version, settings: parsed.data, updatedAt, updatedBy };
    await this.database.db
      .insertInto('app_settings')
      .values({ name: LEADSCORE_SETTINGS_ROW, data: JSON.stringify(stored), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify(stored), modified_at: new Date() }))
      .execute();
    this.cache = toView(stored);
    return this.cache;
  }

  /** Only tests and explicit reloads call this; the row cache is otherwise write-through. */
  invalidate(): void {
    this.cache = undefined;
  }
}

function toView(data: unknown): LeadScoreSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = LeadScoreSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a switch name) falls back to
  // defaults rather than refusing to boot; the health view reports the feature state it derived.
  const settings = parsed.success ? parsed.data : DEFAULT_LEADSCORE_SETTINGS;
  const pending = new Map(LEADSCORE_PENDING_FEATURES.map((entry) => [entry.key, entry.phase]));
  const effective: Record<string, boolean> = {};
  for (const feature of LEADSCORE_FEATURES) {
    effective[feature.key] = settings.enabled === true && isEffective(feature, settings, pending);
  }
  return {
    settings,
    version: typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_LEADSCORE_SETTINGS,
    warnings: settingsWarnings(settings, effective, pending),
    pendingFeatures: LEADSCORE_PENDING_FEATURES,
    effective,
  };
}

function isEffective(feature: LeadScoreFeatureDescriptor, settings: LeadScoreSettings, pending: Map<string, string>): boolean {
  if (pending.has(feature.key)) return false;
  if (settings.features[feature.key as keyof LeadScoreSettings['features']] !== true) return false;
  return feature.requires.every((key) => {
    const dependency = LEADSCORE_FEATURES.find((entry) => entry.key === key);
    if (dependency === undefined) return false;
    return isEffective(dependency, settings, pending);
  });
}

function settingsWarnings(
  settings: LeadScoreSettings,
  effective: Record<string, boolean>,
  pending: Map<string, string>,
): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (!settings.enabled) {
    warnings.push({
      code: 'moduleDisabled',
      message: 'Lead Score is off: no score is calculated and the Lead lifecycle is the core one, unchanged.',
    });
  }
  for (const [key, phase] of pending) {
    if (settings.features[key as keyof LeadScoreSettings['features']] !== true) continue;
    warnings.push({
      code: 'phasePending',
      message: `The "${key}" switch is on but its implementation arrives in ${phase}, so nothing reads it yet.`,
    });
  }
  for (const feature of LEADSCORE_FEATURES) {
    if (pending.has(feature.key)) continue;
    if (settings.features[feature.key as keyof LeadScoreSettings['features']] !== true) continue;
    for (const required of feature.requires) {
      if (effective[required] === true) continue;
      warnings.push({
        code: 'requirementUnmet',
        message: `"${feature.key}" is enabled while "${required}" is off or unimplemented; the dependent behavior stays inactive.`,
      });
    }
  }
  return warnings;
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
