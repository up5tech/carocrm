import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import {
  CASE_NUMBER_PADDING_MAX,
  CASE_NUMBER_PADDING_MIN,
  CASE_NUMBER_PREFIX_MAX,
  CASE_PRIORITIES,
  CASE_SOURCES,
  CASE_STATUSES,
  CASE_TYPES,
  DEFAULT_CASE_DEFAULTS,
  DEFAULT_CASE_NUMBERING,
  DEFAULT_RESOLUTION_CODES,
} from "./service-desk-domain.js";

/**
 * Phase 19-SD.2 — Service Desk domain settings
 * (PLAN_Phase_19_ServiceDesk.md §14.1).
 *
 * The platform already owns instance settings (`app_settings`, `POST /api/v1/Settings`), so this
 * module keeps one validated, versioned row named `serviceDesk` in the same table rather than a
 * second store — mirroring `SalesSettingsService` and `CustomerSuccessSettingsService`.
 *
 * Every value that changes behaviour is validated here, and a change bumps the version so a stored
 * decision can name the policy it was made under. Optional capabilities default to **off**: a fresh
 * installation gets case management, and nothing whose infrastructure lands in a later sub-phase.
 */

const StatusSchema = z.enum(CASE_STATUSES as unknown as [string, ...string[]]);
const PrioritySchema = z.enum(CASE_PRIORITIES as unknown as [string, ...string[]]);
const TypeSchema = z.enum(CASE_TYPES as unknown as [string, ...string[]]);
const SourceSchema = z.enum(CASE_SOURCES as unknown as [string, ...string[]]);

/** 1–16 characters, starting with a letter; letters/digits/dash afterwards. */
const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export const ServiceDeskSettingsSchema = z
  .object({
    features: z
      .object({
        caseManagement: z.boolean().default(true),
        queues: z.boolean().default(false),
        sla: z.boolean().default(false),
        emailToCase: z.boolean().default(false),
        portal: z.boolean().default(false),
        knowledgeBase: z.boolean().default(false),
        csat: z.boolean().default(false),
        notifications: z.boolean().default(false),
      })
      .strict()
      .default({}),
    numbering: z
      .object({
        prefix: z
          .string()
          .trim()
          .min(1)
          .max(CASE_NUMBER_PREFIX_MAX)
          .regex(PREFIX_PATTERN, "A case number prefix starts with a letter and contains only letters, digits or dashes.")
          .default(DEFAULT_CASE_NUMBERING.prefix),
        padding: z
          .number()
          .int()
          .min(CASE_NUMBER_PADDING_MIN)
          .max(CASE_NUMBER_PADDING_MAX)
          .default(DEFAULT_CASE_NUMBERING.padding),
      })
      .strict()
      .default({}),
    defaults: z
      .object({
        status: StatusSchema.default(DEFAULT_CASE_DEFAULTS.status),
        priority: PrioritySchema.default(DEFAULT_CASE_DEFAULTS.priority),
        type: TypeSchema.default(DEFAULT_CASE_DEFAULTS.type),
        source: SourceSchema.default(DEFAULT_CASE_DEFAULTS.source),
      })
      .strict()
      .default({}),
    resolution: z
      .object({
        requireCode: z.boolean().default(true),
        requireSummary: z.boolean().default(false),
        codes: z.array(z.string().trim().min(1).max(64)).max(50).default([...DEFAULT_RESOLUTION_CODES]),
        /** 0 = no limit on reopening a resolved/closed case (§14.1 "allowed reopen window"). */
        reopenWindowDays: z.number().int().min(0).max(3_650).default(0),
      })
      .strict()
      .default({}),
    assignment: z
      .object({
        /** Fallback queue for an unowned case when routing finds nothing else (§5.3). */
        defaultQueueId: z.string().trim().min(1).max(64).nullable().default(null),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ServiceDeskSettings = z.infer<typeof ServiceDeskSettingsSchema>;

export const DEFAULT_SERVICE_DESK_SETTINGS: ServiceDeskSettings = ServiceDeskSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * Honest configuration warnings: a feature an operator can switch on whose infrastructure is
 * delivered in a later sub-phase (SD.6–SD.12) is reported as pending rather than silently ignored.
 * `queues` left this list in SD.5, when the queue/routing infrastructure it names was delivered.
 */
const PENDING_FEATURES: readonly { readonly key: keyof ServiceDeskSettings["features"]; readonly phase: string }[] = [
  { key: "sla", phase: "19-SD.8" },
  { key: "portal", phase: "19-SD.11" },
  { key: "knowledgeBase", phase: "19-SD.10" },
  { key: "csat", phase: "19-SD.14" },
];

export function settingsWarnings(settings: ServiceDeskSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (!settings.features.caseManagement) {
    warnings.push({
      code: "caseManagementDisabled",
      message: "Case management is disabled; case create/edit commands are refused but existing cases remain readable.",
    });
  }
  for (const feature of PENDING_FEATURES) {
    if (settings.features[feature.key]) {
      warnings.push({
        code: `pending:${feature.key}`,
        message: `The "${feature.key}" feature is enabled but its infrastructure is delivered in phase ${feature.phase}; nothing will run yet.`,
      });
    }
  }
  return warnings;
}

export interface ServiceDeskSettingsView {
  readonly settings: ServiceDeskSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: ServiceDeskSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = "serviceDesk";

@Injectable()
export class ServiceDeskSettingsService {
  private cache: ServiceDeskSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<ServiceDeskSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<ServiceDeskSettingsView> {
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
   * and quietly ignored), and every accepted change bumps the settings version.
   */
  async update(patch: unknown): Promise<ServiceDeskSettingsView> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ValidationError("Service Desk settings must be an object.");
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = ServiceDeskSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError("Invalid Service Desk settings.", {
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
      .values({ name: SETTINGS_ROW, data: JSON.stringify(stored), modified_at: new Date() })
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

function toView(data: unknown): ServiceDeskSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = ServiceDeskSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a default) falls back to
  // defaults for the invalid parts instead of refusing to boot — the health endpoint reports it.
  const settings = parsed.success ? parsed.data : ServiceDeskSettingsSchema.parse({});
  return {
    settings,
    version:
      typeof stored.version === "number" && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
    defaults: DEFAULT_SERVICE_DESK_SETTINGS,
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
