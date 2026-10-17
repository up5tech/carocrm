import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  DEFAULT_LIFECYCLE_TRANSITIONS,
  DEFAULT_RENEWAL_WINDOWS,
  HEALTH_STATUSES,
  type HealthThresholdBand,
  LIFECYCLE_REASON_REQUIRED,
  LIFECYCLE_STAGES,
  MISSING_DATA_POLICIES,
  ROUNDING_POLICIES,
  validateHealthThresholds,
} from "./customer-success-domain.js";

/**
 * Phase 19-CS.1 / 19-CS.4 — Customer Success domain settings
 * (PLAN_Phase_19_Customer_Success.md §5.13).
 *
 * The platform already owns instance settings (`app_settings`, `POST /api/v1/Settings`), so this
 * module does not introduce a second store: it keeps one validated, versioned row named
 * `customerSuccess` in the same table, mirroring `SalesSettingsService`. Every value that changes a
 * calculation is validated here, and a change bumps the version so a stored health snapshot can name
 * the policy it was produced under (§5.4.3 "store the configuration version used on the snapshot").
 */

const DEFAULT_SIGNAL_FRESHNESS_DAYS = 90;

const LifecycleStageSchema = z.enum(
  LIFECYCLE_STAGES as unknown as [string, ...string[]],
);

const HealthBandSchema = z
  .object({
    status: z.enum(
      HEALTH_STATUSES.filter((status) => status !== "unknown") as unknown as [
        string,
        ...string[],
      ],
    ),
    min: z.number().int().min(0).max(100),
    max: z.number().int().min(0).max(100),
  })
  .strict();

const SignalConfigSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    weight: z.number().min(0).max(1000),
    enabled: z.boolean().default(true),
    freshnessDays: z.number().int().min(1).max(3650).default(DEFAULT_SIGNAL_FRESHNESS_DAYS),
  })
  .strict();

export const CustomerSuccessSettingsSchema = z
  .object({
    features: z
      .object({
        healthScoring: z.boolean().default(true),
        healthHistory: z.boolean().default(true),
        successPlans: z.boolean().default(true),
        goals: z.boolean().default(true),
        risks: z.boolean().default(true),
        onboarding: z.boolean().default(true),
        playbooks: z.boolean().default(true),
        reviews: z.boolean().default(true),
        renewalReadiness: z.boolean().default(true),
        notifications: z.boolean().default(false),
        automation: z.boolean().default(false),
        /** Adoption signals need an external connector; off until one exists (§12.7). */
        adoptionSignal: z.boolean().default(false),
      })
      .strict()
      .default({}),
    lifecycle: z
      .object({
        stages: z
          .array(
            z
              .object({
                key: LifecycleStageSchema,
                label: z.string().trim().min(1).max(64),
                order: z.number().int().min(0).max(1000),
              })
              .strict(),
          )
          .default(
            LIFECYCLE_STAGES.map((key, index) => ({
              key,
              label: key,
              order: index * 10,
            })),
          ),
        transitions: z
          .record(z.string(), z.array(z.string()))
          .default(
            Object.fromEntries(
              Object.entries(DEFAULT_LIFECYCLE_TRANSITIONS).map(([key, value]) => [key, [...value]]),
            ),
          ),
        reasonRequired: z
          .array(z.string())
          .default([...LIFECYCLE_REASON_REQUIRED]),
      })
      .strict()
      .default({}),
    segments: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    assignment: z
      .object({
        /** `unassigned` leaves a new profile without a CSM; `accountOwner` copies the Account owner. */
        defaultPolicy: z.enum(["unassigned", "accountOwner"]).default("unassigned"),
      })
      .strict()
      .default({}),
    health: z
      .object({
        thresholds: z.array(HealthBandSchema).default([...DEFAULT_HEALTH_THRESHOLDS]),
        /** Minimum share (0–1) of configured weight that must be valid to produce a score. */
        minimumCoverage: z.number().min(0).max(1).default(0.5),
        missingDataPolicy: z.enum(MISSING_DATA_POLICIES).default("excludeAndRenormalize"),
        rounding: z.enum(ROUNDING_POLICIES).default("round"),
        /** A stored override with no explicit expiry expires after this many days. */
        overrideExpiryDays: z.number().int().min(1).max(3650).default(90),
        /** Whether a manual override must be reviewed before it can be cleared. */
        overrideRequiresReview: z.boolean().default(false),
        signals: z
          .array(SignalConfigSchema)
          .default([
            { key: "engagement", weight: 25, enabled: true, freshnessDays: 90 },
            { key: "successPlan", weight: 20, enabled: true, freshnessDays: 90 },
            { key: "relationship", weight: 15, enabled: true, freshnessDays: 180 },
            { key: "onboarding", weight: 15, enabled: true, freshnessDays: 180 },
            { key: "risks", weight: 15, enabled: true, freshnessDays: 90 },
            { key: "renewal", weight: 10, enabled: true, freshnessDays: 180 },
            { key: "adoption", weight: 0, enabled: false, freshnessDays: 90 },
            { key: "support", weight: 0, enabled: false, freshnessDays: 90 },
          ]),
      })
      .strict()
      .default({}),
    renewal: z
      .object({
        windows: z.array(z.number().int().min(1).max(3650)).max(12).default([...DEFAULT_RENEWAL_WINDOWS]),
        /** `manualFirst` keeps a typed renewal date unless a source is explicitly preferred. */
        sourcePrecedence: z.enum(["manualFirst", "sourceFirst"]).default("manualFirst"),
      })
      .strict()
      .default({}),
    touchpoints: z
      .object({
        recencyDays: z.number().int().min(1).max(3650).default(30),
      })
      .strict()
      .default({}),
    playbooks: z
      .object({
        autoTriggersEnabled: z.boolean().default(false),
        maxStepsPerRun: z.number().int().min(1).max(500).default(200),
        /** Whether starting a playbook derives a deterministic idempotency key per account+template. */
        enforceIdempotency: z.boolean().default(true),
      })
      .strict()
      .default({}),
    notifications: z
      .object({
        /** Whether the module writes in-app notification rows from its jobs. */
        enabled: z.boolean().default(false),
        /** Minimum days between two notifications for the same condition. */
        cadenceDays: z.number().int().min(1).max(365).default(7),
      })
      .strict()
      .default({}),
    jobs: z
      .object({
        batchSize: z.number().int().min(1).max(1000).default(200),
        /** Profiles not recalculated within this many days are due for a refresh. */
        refreshIntervalDays: z.number().int().min(1).max(365).default(7),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of validateHealthThresholds(
      value.health.thresholds as HealthThresholdBand[],
    )) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["health", "thresholds"], message: issue });
    }
    const keys = new Set<string>();
    for (const [index, signal] of value.health.signals.entries()) {
      if (keys.has(signal.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["health", "signals", index, "key"],
          message: `Signal "${signal.key}" is configured more than once.`,
        });
      }
      keys.add(signal.key);
    }
    const stageKeys = new Set<string>();
    for (const [index, stage] of value.lifecycle.stages.entries()) {
      if (stageKeys.has(stage.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", "stages", index, "key"],
          message: `Lifecycle stage "${stage.key}" is defined more than once.`,
        });
      }
      stageKeys.add(stage.key);
    }
  });

export type CustomerSuccessSettings = z.infer<typeof CustomerSuccessSettingsSchema>;

export const DEFAULT_CUSTOMER_SUCCESS_SETTINGS: CustomerSuccessSettings =
  CustomerSuccessSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

export function settingsWarnings(settings: CustomerSuccessSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  const enabledSignals = settings.health.signals.filter((signal) => signal.enabled && signal.weight > 0);
  if (settings.features.healthScoring && enabledSignals.length === 0) {
    warnings.push({
      code: "noEnabledSignals",
      message: "Health scoring is enabled but no weighted signal is enabled; every score will be unknown.",
    });
  }
  if (!settings.features.healthScoring) {
    warnings.push({
      code: "healthScoringDisabled",
      message: "Health scoring is disabled; profiles keep their last stored score and are not refreshed.",
    });
  }
  if (!settings.features.playbooks && settings.features.onboarding) {
    warnings.push({
      code: "onboardingWithoutPlaybooks",
      message: "Onboarding is enabled but playbooks are disabled; onboarding must be tracked manually.",
    });
  }
  if (settings.features.automation && !settings.playbooks.autoTriggersEnabled) {
    warnings.push({
      code: "automationWithoutTriggers",
      message: "Automation is enabled while playbook auto-triggers are off; nothing will start automatically.",
    });
  }
  if (settings.features.notifications && !settings.notifications.enabled) {
    warnings.push({
      code: "notificationsDisabled",
      message: "Notification features are enabled but notification writing is off; no alerts will be raised.",
    });
  }
  const windows = [...settings.renewal.windows].sort((a, b) => a - b);
  if (windows.length === 0 && settings.features.renewalReadiness) {
    warnings.push({
      code: "noRenewalWindows",
      message: "Renewal readiness is enabled but no renewal window is configured.",
    });
  }
  return warnings;
}

export interface CustomerSuccessSettingsView {
  readonly settings: CustomerSuccessSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: CustomerSuccessSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = "customerSuccess";

@Injectable()
export class CustomerSuccessSettingsService {
  private cache: CustomerSuccessSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for calculation paths; defaults when the row is absent. */
  async settings(): Promise<CustomerSuccessSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<CustomerSuccessSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db
      .selectFrom("app_settings")
      .select("data")
      .where("name", "=", SETTINGS_ROW)
      .executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /**
   * Apply a validated patch. Unknown keys are refused (a typo in a policy name must not be stored
   * and silently ignored), and every accepted change bumps the settings version.
   */
  async update(patch: unknown): Promise<CustomerSuccessSettingsView> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ValidationError("Customer Success settings must be an object.");
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = CustomerSuccessSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError("Invalid Customer Success settings.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const next = parsed.data;
    const version = current.version + 1;
    const updatedAt = new Date().toISOString();
    const updatedBy = this.scope.principal?.userName ?? this.scope.userId ?? null;
    const stored: StoredSettings = { version, settings: next, updatedAt, updatedBy };
    await this.database.db
      .insertInto("app_settings")
      .values({
        name: SETTINGS_ROW,
        data: JSON.stringify(stored),
        modified_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({ data: JSON.stringify(stored), modified_at: new Date() }),
      )
      .execute();
    this.cache = toView(stored);
    return this.cache;
  }

  /** Only tests and explicit reloads call this; the row cache is otherwise write-through. */
  invalidate(): void {
    this.cache = undefined;
  }
}

function toView(data: unknown): CustomerSuccessSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = CustomerSuccessSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a policy) falls back to
  // defaults for the invalid parts instead of refusing to boot — health reports the mismatch.
  const settings = parsed.success ? parsed.data : CustomerSuccessSettingsSchema.parse({});
  return {
    settings,
    version:
      typeof stored.version === "number" && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
    defaults: DEFAULT_CUSTOMER_SUCCESS_SETTINGS,
    warnings: settingsWarnings(settings),
  };
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) merged[key] = deepMerge(current, value);
    else merged[key] = value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
