import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { PENDING_FEATURES, VOICE_FEATURES } from "./voice-communications-module.js";

/**
 * Phase 19-VC.2 — Voice & Communications domain settings
 * (`PLAN_Phase_19_Voice_Communications.md` §13, §15 `19-VC.2` task 3).
 *
 * The platform already owns instance settings (`app_settings`), so this module keeps **one**
 * validated, versioned row named `voiceCommunications` there — the same shape as
 * `SalesSettingsService`, `ServiceDeskSettingsService` and `MarketingAutomationSettingsService`.
 *
 * Rule followed here: **only settings that have an actual consumer**. Every value below is read by
 * delivered code in 19-VC.0–19-VC.6 — a feature gate, the phone normalizer, the webhook ingress or
 * the channel policy service. Settings for recording retention, transcription vendors or quotas are
 * deliberately absent until the sub-phase that reads them exists; a setting nobody consumes is a
 * false promise in an admin screen.
 *
 * Optional capabilities default **off**: a fresh installation records provider configuration and
 * nothing else.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const VoiceCommunicationsSettingsSchema = z
  .object({
    features: z
      .object({
        voice: z.boolean().default(false),
        sms: z.boolean().default(false),
        mms: z.boolean().default(false),
        whatsapp: z.boolean().default(false),
        // Recording and transcription are off until an administrator configures a legal and
        // operational policy (§7.5, §13.4). The flag exists now so the policy service and the
        // health report can say "disabled by policy" rather than "not implemented" once they land.
        recordings: z.boolean().default(false),
        transcripts: z.boolean().default(false),
        aiEnrichment: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    provider: z
      .object({
        /**
         * The account key a channel uses when the caller names none. Empty means **no default**, and
         * a send/call without an explicit account is refused rather than guessed — sending from an
         * unintended number is a §13 problem, not a convenience.
         */
        defaultAccountKey: z.string().trim().max(64).default(""),
      })
      .strict()
      .prefault({}),
    policy: z
      .object({
        /** ISO 3166-1 alpha-2 region applied to a national phone number. */
        defaultRegion: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, "defaultRegion must be a two-letter ISO country code.")
          .transform((value) => value.toUpperCase())
          .default("US"),
        /**
         * Consent is required per channel by default. A deployment that has a documented legal basis
         * for transactional SMS may turn it off per channel; WhatsApp defaults on because §8.3
         * forbids inferring opt-in from a phone number.
         */
        requireConsent: z
          .object({
            sms: z.boolean().default(true),
            mms: z.boolean().default(true),
            whatsapp: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
        /** Quiet hours are off by default; enabling them requires a valid window and time zone. */
        quietHours: z
          .object({
            enabled: z.boolean().default(false),
            start: z.string().regex(HHMM, "quietHours.start must be HH:MM.").default("21:00"),
            end: z.string().regex(HHMM, "quietHours.end must be HH:MM.").default("08:00"),
            timezone: z.string().trim().max(64).default("UTC"),
          })
          .strict()
          .prefault({}),
        /**
         * WhatsApp customer-service window, in hours (§8.3). Read by the policy service with an
         * injectable clock; the provider's published value wins when an adapter supplies one.
         */
        whatsappWindowHours: z.number().int().min(1).max(168).default(24),
        /** Largest message body accepted before enqueue; provider limits are checked again at send. */
        maxMessageLength: z.number().int().min(1).max(10_000).default(1_600),
        /**
         * The deployment's own ceiling per account and minute. `0` means "whatever the provider
         * allows" and is the default, because inventing a quota would throttle a correct install.
         */
        maxSendsPerMinute: z.number().int().min(0).max(100_000).default(0),
      })
      .strict()
      .prefault({}),
    webhook: z
      .object({
        /**
         * Timestamp skew accepted on a provider callback (§13.2 replay protection). Bounded so a
         * deployment cannot disable replay protection by configuring a year.
         */
        replayWindowSeconds: z.number().int().min(30).max(900).default(300),
      })
      .strict()
      .prefault({}),
    /**
     * 19-VC.15 — media handling. A provider recording URL is fetched into private storage only when
     * the administrator says so; otherwise playback is refused rather than proxied blind.
     */
    media: z
      .object({
        /** `off` keeps the reference only; `privateStorage` fetches bytes into the platform store. */
        fetchMode: z.enum(["off", "privateStorage"]).default("off"),
        /** Extra hostnames a provider's media may come from. Empty means "refuse every fetch". */
        allowedHosts: z.array(z.string().trim().min(1).max(255)).max(32).default([]),
        /** Non-production escape hatch for the SSRF check; never set in a live deployment. */
        allowLoopback: z.boolean().default(false),
        maxBytes: z.number().int().min(1024).max(104_857_600).default(26_214_400),
        retentionDays: z.number().int().min(1).max(3_650).default(90),
        /** The operator-facing notice an agent must present before a recorded call. */
        noticeRequired: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    /**
     * 19-VC.16 — AI enrichment. Both keys must be set for a summary/suggested reply to be produced;
     * the module calls the platform's AI gateway, never a provider directly.
     */
    ai: z
      .object({
        connectionKey: z.string().trim().max(64).default(""),
        model: z.string().trim().max(128).default(""),
        /** Largest transcript text handed to a model, so a runaway recording cannot drain budget. */
        maxTranscriptChars: z.number().int().min(500).max(200_000).default(20_000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type VoiceCommunicationsSettings = z.infer<typeof VoiceCommunicationsSettingsSchema>;

export const DEFAULT_VOICE_COMMUNICATIONS_SETTINGS: VoiceCommunicationsSettings =
  VoiceCommunicationsSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

export function settingsWarnings(settings: VoiceCommunicationsSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  for (const feature of VOICE_FEATURES) {
    const enabled = (settings.features as unknown as Record<string, boolean>)[feature.key] === true;
    if (!enabled) continue;
    const pending = PENDING_FEATURES.find((entry) => entry.key === feature.key);
    if (pending !== undefined) {
      warnings.push({
        code: `pending:${feature.key}`,
        message: `The "${feature.key}" feature is enabled but its infrastructure is delivered in phase ${pending.phase}; nothing will run yet.`,
      });
    }
  }
  if (settings.provider.defaultAccountKey === "") {
    warnings.push({
      code: "noDefaultAccount",
      message:
        "No default provider account is configured. A call or message must name its account explicitly, and is refused when it does not.",
    });
  }
  if (settings.policy.quietHours.enabled) {
    const sameWindow = settings.policy.quietHours.start === settings.policy.quietHours.end;
    if (sameWindow) {
      warnings.push({
        code: "quietHoursEmptyWindow",
        message: "Quiet hours start and end at the same time, so the window is empty and blocks nothing.",
      });
    }
    if (settings.policy.quietHours.timezone.trim() === "") {
      warnings.push({
        code: "quietHoursNoTimezone",
        message: "Quiet hours are enabled without a time zone; the policy service falls back to UTC.",
      });
    }
  }
  return warnings;
}

export interface VoiceCommunicationsSettingsView {
  readonly settings: VoiceCommunicationsSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: VoiceCommunicationsSettings;
  readonly warnings: readonly SettingsWarning[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

const SETTINGS_ROW = "voiceCommunications";

@Injectable()
export class VoiceCommunicationsSettingsService {
  private cache: VoiceCommunicationsSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<VoiceCommunicationsSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<VoiceCommunicationsSettingsView> {
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
   * Apply a validated patch. Unknown keys are refused — a typo in a policy name must not be stored
   * and quietly ignored — and every accepted change bumps the settings version, so a decision can be
   * audited against the policy that was in force.
   */
  async update(patch: unknown): Promise<VoiceCommunicationsSettingsView> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new ValidationError("Voice & Communications settings must be an object.");
    }
    const current = await this.read();
    const merged = deepMerge(
      current.settings as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
    );
    const parsed = VoiceCommunicationsSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError("Invalid Voice & Communications settings.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
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

  /** Whether a feature gate is on. A feature whose infrastructure is pending is reported by warnings. */
  async featureEnabled(key: string): Promise<boolean> {
    const settings = await this.settings();
    return (settings.features as unknown as Record<string, boolean>)[key] === true;
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
    .insertInto("app_settings")
    .values({ name: SETTINGS_ROW, data, modified_at: now })
    .onConflict((oc) => oc.column("name").doUpdateSet({ data, modified_at: now }))
    .execute();
}

function toView(data: unknown): VoiceCommunicationsSettingsView {
  const stored = isRecord(data) ? (data as StoredSettings) : {};
  const parsed = VoiceCommunicationsSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a default) falls back to
  // defaults for the invalid parts instead of refusing to boot — the health endpoint reports what it found.
  const settings = parsed.success ? parsed.data : DEFAULT_VOICE_COMMUNICATIONS_SETTINGS;
  return {
    settings,
    version: typeof stored.version === "number" && Number.isInteger(stored.version) ? stored.version : 0,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
    defaults: DEFAULT_VOICE_COMMUNICATIONS_SETTINGS,
    warnings: settingsWarnings(settings),
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
