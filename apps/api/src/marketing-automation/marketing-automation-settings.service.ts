import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { CAMPAIGN_TIMEZONE_MAX_LENGTH, isSupportedTimeZone } from "./marketing-automation-domain.js";
import { PENDING_FEATURES } from "./marketing-automation-module.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";

/**
 * Phase 19-MA.1/MA.2 — Marketing Automation domain settings
 * (PLAN_Phase_19_Marketing_Automation.md §13, §15 `19-MA.1` task 4, `19-MA.2` task 2).
 *
 * The platform already owns instance settings (`app_settings`), so this module keeps **one** validated,
 * versioned row named `marketingAutomation` in that table rather than a second store — the same shape as
 * `SalesSettingsService`, `CustomerSuccessSettingsService` and `ServiceDeskSettingsService`.
 *
 * §13's first line is the rule this file follows: **only settings that have an actual consumer**. Every
 * value below is read by delivered code today — a feature gate, a validation check, or the sendability gate.
 * The long §13 wish list (batch size, provider quotas, frequency caps, token lifetimes, retention periods,
 * bounce thresholds, attribution windows) is deliberately **absent** until the sub-phase that reads it exists;
 * a setting nobody consumes is a false promise in an admin screen.
 *
 * Optional capabilities default to **off**: a fresh installation gets campaign management and nothing whose
 * infrastructure lands in a later sub-phase.
 */

export const MarketingAutomationSettingsSchema = z
  .object({
    features: z
      .object({
        campaigns: z.boolean().default(true),
        audience: z.boolean().default(false),
        // "Recipient context and preview" (§5.4): the placeholder renderer, content preview and the
        // immutable template revisions it seals. Off until an instance opts in, like `audience`.
        templates: z.boolean().default(false),
      })
      .strict()
      .default({}),
    defaults: z
      .object({
        /**
         * Applied when a campaign leaves `timezone` empty. There is **no** default `purpose`: §5.1 requires a
         * campaign's communication purpose to be a deliberate classification, and a prefilled exemption is how
         * a promotional send becomes a "service notice".
         */
        timezone: z
          .string()
          .trim()
          .max(CAMPAIGN_TIMEZONE_MAX_LENGTH)
          .refine(isSupportedTimeZone, "Default timezone must be a time zone identifier this runtime understands.")
          .default("UTC"),
      })
      .strict()
      .default({}),
    sender: z
      .object({
        /**
         * Fallback sending account (`email_accounts.id`) for a campaign that names none. `null` means the
         * platform's own default account is used, and no default is set means a campaign cannot pass
         * validation — a campaign that silently sends from an unintended address is a §9.4 problem, not a
         * convenience.
         */
        defaultEmailAccountId: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .nullable()
          .default(null),
      })
      .strict()
      .default({}),
    limits: z
      .object({
        /**
         * How many records one audience resolution may read (§5.2 "enforce query cost/time limits and
         * pagination"). A preview and a snapshot both stop at this ceiling and say so, rather than
         * materialising an unbounded cross-entity read because somebody saved a criteria that matches
         * everybody.
         */
        maxResolveRecords: z.number().int().min(1).max(200_000).default(10_000),
      })
      .strict()
      .default({}),
    provider: z
      .object({
        /**
         * The adapter key this deployment sends through; the empty string means **no provider**, which is the
         * default (§1.2 safe by default). §13 lists "default sender/provider reference" as a setting, and it is
         * read by the send-readiness gate, the health report and the test-send command — never inferred from
         * whichever adapter happened to register first (§7.1 `MarketingProviderRegistry`).
         */
        key: z.string().trim().max(64).default(""),
        /**
         * The deployment's own ceiling over a provider that publishes none (§13 "provider- or sender-level
         * rate limits and quotas"). `ratePerMinute: 0` means "whatever the provider allows" and is the default,
         * because inventing a quota here would throttle a correctly configured installation.
         */
        limits: z
          .object({
            ratePerMinute: z.number().int().min(0).max(100_000).default(0),
            maxConcurrency: z.number().int().min(1).max(50).default(1),
          })
          .strict()
          .default({}),
        /**
         * The safe test send (§10.5, §15 `19-MA.7` task 3). A test send is a manufacturing-safety device:
         * it may only reach addresses an administrator listed here, and an empty list means **no test send at
         * all** — a mis-click can otherwise mail a live audience. Confirmation is required by default (§10.2
         * "show test/preview state clearly").
         */
        testSend: z
          .object({
            allowedRecipients: z.array(z.string().trim().email().max(320)).max(50).default([]),
            requireConfirmation: z.boolean().default(true),
            maxRecipients: z.number().int().min(1).max(20).default(5),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    safety: z
      .object({
        /**
         * The §13 global emergency stop. Read by `checkCampaignSendable` on **every** path that could put a
         * message on the wire, and by scheduling today, so an operator can stop marketing sends without
         * touching 40 campaign records — and without a campaign author being able to undo it (§13: "a campaign
         * author must not exceed global rate/volume limits").
         */
        globalSendPaused: z.boolean().default(false),
        /** Recorded so the stop is attributable; never a secret and never free-form marketing copy. */
        reason: z.string().trim().max(500).nullable().default(null),
      })
      .strict()
      .default({}),
  })
  .strict();

export type MarketingAutomationSettings = z.infer<typeof MarketingAutomationSettingsSchema>;

export const DEFAULT_MARKETING_AUTOMATION_SETTINGS: MarketingAutomationSettings =
  MarketingAutomationSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

export function settingsWarnings(settings: MarketingAutomationSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (!settings.features.campaigns) {
    warnings.push({
      code: "campaignsDisabled",
      message:
        "Campaign management is disabled; campaign create/edit and lifecycle commands are refused but existing campaigns remain readable.",
    });
  }
  for (const feature of PENDING_FEATURES) {
    const features = settings.features as unknown as Record<string, boolean>;
    if (features[feature.key] === true) {
      warnings.push({
        code: `pending:${feature.key}`,
        message: `The "${feature.key}" feature is enabled but its infrastructure is delivered in phase ${feature.phase}; nothing will run yet.`,
      });
    }
  }
  if (settings.safety.globalSendPaused) {
    warnings.push({
      code: "globalSendPaused",
      message: "Marketing sending is stopped globally. No message may be queued or sent until it is resumed.",
    });
  }
  if (settings.provider.key === "") {
    warnings.push({
      code: "providerNotConfigured",
      message:
        "No marketing provider is configured, so no campaign can start and no test send can run. Set provider.key to a registered adapter (for example `platform-mail`).",
    });
  }
  if (settings.provider.testSend.allowedRecipients.length === 0) {
    warnings.push({
      code: "testSendNotConfigured",
      message:
        "No test-send recipient is allowlisted, so the test-send command is refused. Add internal mailboxes under provider.testSend.allowedRecipients.",
    });
  }
  return warnings;
}

export interface MarketingAutomationSettingsView {
  readonly settings: MarketingAutomationSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: MarketingAutomationSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = "marketingAutomation";

@Injectable()
export class MarketingAutomationSettingsService {
  private cache: MarketingAutomationSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(MarketingProviderRegistry) private readonly providers: MarketingProviderRegistry,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<MarketingAutomationSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<MarketingAutomationSettingsView> {
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
   * Apply a validated patch. Unknown keys are refused — a typo in a policy name must not be stored and
   * quietly ignored — and every accepted change bumps the settings version, so a decision can be audited
   * against the policy that was in force (§13 "audit sensitive settings changes").
   */
  async update(patch: unknown): Promise<MarketingAutomationSettingsView> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ValidationError("Marketing Automation settings must be an object.");
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = MarketingAutomationSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError("Invalid Marketing Automation settings.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    // A provider key that resolves to nothing must be refused here, at the write, rather than silently
    // disabling sending later (§13) — the registry still fails closed at send time for anything stored before
    // an adapter was removed.
    const requestedProvider = isRecord(patch) ? patch["provider"] : undefined;
    const requestedKey = isRecord(requestedProvider) ? requestedProvider["key"] : undefined;
    if (typeof requestedKey === "string" && requestedKey.trim() !== "" && !this.providers.has(requestedKey)) {
      throw new ValidationError(`Unknown marketing provider "${requestedKey.trim()}".`, {
        code: "PROVIDER_UNKNOWN",
        known: this.providers.keys(),
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

  /**
   * The §13 global emergency stop, as a named operation rather than a patch an operator has to compose.
   * Pausing is available to whoever can write settings; resuming records the reason it was lifted so the
   * runbook ("how to resume without duplicate messages") has an audit trail to read.
   */
  async setGlobalSendPaused(paused: boolean, reason?: string): Promise<MarketingAutomationSettingsView> {
    return this.update({ safety: { globalSendPaused: paused, ...(reason !== undefined ? { reason } : {}) } });
  }
}

async function writeRow(database: DatabaseService, stored: StoredSettings): Promise<void> {
  const data = JSON.stringify(stored);
  const now = new Date();
  await database.db
    .insertInto("app_settings")
    .values({ name: SETTINGS_ROW, data, modified_at: now })
    .onConflict((oc) => oc.column("name").doUpdateSet({ data, modified_at: now }))
    .execute();
}

function toView(data: unknown): MarketingAutomationSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = MarketingAutomationSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a default) falls back to defaults
  // for the invalid parts instead of refusing to boot — the health endpoint reports the version it found.
  const settings = parsed.success ? parsed.data : DEFAULT_MARKETING_AUTOMATION_SETTINGS;
  return {
    settings,
    version:
      typeof stored.version === "number" && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
    defaults: DEFAULT_MARKETING_AUTOMATION_SETTINGS,
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
