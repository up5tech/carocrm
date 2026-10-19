import { Inject, Injectable } from "@nestjs/common";

import { PHONE_NORMALIZER, type PhoneNormalizer } from "./phone-number.js";
import {
  isWhatsAppWindowOpen,
  POLICY_REFUSAL_CODES,
  type PolicyRefusalCode,
  policyRefusalMessage,
  sendCapabilityFor,
  type VoiceChannel,
} from "./voice-communications-domain.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { type ConsentState, type SuppressionView, VoiceConsentService } from "./voice-consent.service.js";
import { effectiveCapabilities, VoiceProviderRegistry } from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";

/**
 * Phase 19-VC.6 — channel policy evaluation
 * (`PLAN_Phase_19_Voice_Communications.md` §8.4, §9.2, §13.4, §15 `19-VC.6`).
 *
 * One function decides whether an outbound operation may proceed, and it is the only place that
 * decision is made (§8.4's eight checks). Every refusal carries a code from
 * `POLICY_REFUSAL_CODES` and a sentence, so a block is explainable rather than a bare 403.
 *
 * The policy is evaluated **again immediately before dispatch** in later sub-phases, not only when a
 * user composes a message (§8.4 "recheck eligibility immediately before actual provider dispatch").
 * This service is therefore cheap, side-effect free and safe to call on every attempt.
 *
 * Consent is consulted only when the channel requires it. Voice calls default to no consent
 * requirement (a call is a deliberate human action and recording consent is a separate policy);
 * SMS/MMS/WhatsApp default to required and are configurable per channel.
 */

export interface PolicyRefusal {
  readonly code: PolicyRefusalCode;
  readonly message: string;
}

export interface PolicyInput {
  readonly channel: VoiceChannel;
  readonly address: string;
  /** Consent is scoped by purpose; `service` is the one-to-one service conversation default. */
  readonly purpose?: string | undefined;
  /** Explicit account, or the configured default when absent. */
  readonly accountKey?: string | undefined;
  /** The service window input. When omitted, the policy derives it from inbound traffic. */
  readonly lastInboundAt?: string | null | undefined;
  /** Body length, checked against the configured maximum. */
  readonly messageLength?: number | undefined;
  /** An approved template key; its presence satisfies the WhatsApp window rule. */
  readonly templateKey?: string | null | undefined;
  /** Injectable clock so window and quiet-hour decisions are testable (§15 `19-VC.6`). */
  readonly now?: Date | undefined;
}

export interface PolicyEvaluation {
  readonly allowed: boolean;
  readonly channel: VoiceChannel;
  /** The normalized E.164 address, or null when it was invalid. */
  readonly address: string | null;
  readonly accountKey: string | null;
  readonly refusals: readonly PolicyRefusal[];
  readonly consent: ConsentState | null;
  readonly suppression: SuppressionView | null;
  readonly window: {
    readonly applicable: boolean;
    readonly open: boolean;
    readonly requiresTemplate: boolean;
    readonly lastInboundAt: string | null;
  };
  readonly checkedAt: string;
}

@Injectable()
export class VoicePolicyService {
  constructor(
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceConsentService) private readonly consent: VoiceConsentService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  async evaluate(input: PolicyInput): Promise<PolicyEvaluation> {
    const settings = await this.settings.settings();
    const now = input.now ?? new Date();
    const refusals: PolicyRefusal[] = [];
    const refuse = (code: PolicyRefusalCode): void => {
      refusals.push({ code, message: policyRefusalMessage(code) });
    };

    // 1. The channel must be enabled for this deployment.
    const featureOn = (settings.features as unknown as Record<string, boolean>)[input.channel] === true;
    if (!featureOn) refuse("channel_disabled");

    // 2. The account must exist, be enabled and have passed its last health check.
    const accountKey = (input.accountKey ?? settings.provider.defaultAccountKey).trim();
    let accountCapabilities: readonly string[] = [];
    if (accountKey === "") {
      refuse("account_missing");
    } else {
      try {
        const { account, lastHealthStatus } = await this.accounts.resolveForPolicy(accountKey);
        if (!account.enabled) refuse("account_disabled");
        if (lastHealthStatus === "unhealthy") refuse("account_unhealthy");
        const adapter = this.registry.resolve(account.providerKey);
        accountCapabilities = effectiveCapabilities(adapter.info, account.capabilities);
      } catch {
        refuse("account_missing");
      }
    }

    // 3. The adapter must declare the capability the operation needs.
    const capability = sendCapabilityFor(input.channel);
    if (capability === null || !accountCapabilities.includes(capability)) refuse("capability_missing");

    // 4. The address must normalize; an invalid number is never matched to a record or sent to.
    const normalized = this.phones.normalize(input.address, settings.policy.defaultRegion);
    if (!normalized.valid || normalized.e164 === null) {
      refuse("invalid_address");
    }

    const address = normalized.e164;

    // 5–6. Consent and suppression, only once the address is usable. A consent lookup on a malformed
    // address would throw and turn an explainable refusal into a 500.
    let consentState: ConsentState | null = null;
    let suppression: SuppressionView | null = null;
    if (address !== null) {
      const purpose = (input.purpose ?? "service").trim();
      const requiresConsent = consentRequiredFor(settings, input.channel);
      if (requiresConsent) {
        consentState = await this.consent.state(input.channel, address, purpose);
        if (consentState.status !== "granted") refuse("consent_required");
      }
      suppression = await this.consent.isSuppressed(input.channel, address);
      if (suppression !== null) refuse("suppressed");
    }

    // 7. Quiet hours, when the deployment configured them.
    if (settings.policy.quietHours.enabled) {
      const inside = isWithinQuietHours(now, settings.policy.quietHours);
      if (inside) refuse("quiet_hours");
    }

    // 8. The WhatsApp service window. Outside it a free-form message is refused and an approved
    // template is required; the policy never assumes a window from a phone number's existence.
    let windowOpen = false;
    let lastInboundAt: string | null = null;
    if (input.channel === "whatsapp" && address !== null) {
      lastInboundAt =
        input.lastInboundAt !== undefined
          ? input.lastInboundAt
          : await this.consent.lastInboundAt(input.channel, address);
      windowOpen = isWhatsAppWindowOpen(lastInboundAt, now, settings.policy.whatsappWindowHours);
      const hasTemplate = (input.templateKey ?? "").trim() !== "";
      if (!windowOpen && !hasTemplate) refuse("template_required");
    }

    // 9. Payload shape.
    if (input.messageLength !== undefined && input.messageLength > settings.policy.maxMessageLength) {
      refuse("payload_invalid");
    }

    return {
      allowed: refusals.length === 0,
      channel: input.channel,
      address,
      accountKey: accountKey === "" ? null : accountKey,
      refusals,
      consent: consentState,
      suppression,
      window: {
        applicable: input.channel === "whatsapp",
        open: windowOpen,
        requiresTemplate: input.channel === "whatsapp" && !windowOpen,
        lastInboundAt,
      },
      checkedAt: now.toISOString(),
    };
  }
}

function consentRequiredFor(
  settings: { readonly policy: { readonly requireConsent: { readonly sms: boolean; readonly mms: boolean; readonly whatsapp: boolean } } },
  channel: VoiceChannel,
): boolean {
  switch (channel) {
    case "sms":
      return settings.policy.requireConsent.sms;
    case "mms":
      return settings.policy.requireConsent.mms;
    case "whatsapp":
      return settings.policy.requireConsent.whatsapp;
    case "voice":
      return false;
  }
}

/**
 * Quiet hours as a local-time window. An overnight window (`21:00`–`08:00`) wraps midnight. Equal
 * start and end is an empty window (reported as a settings warning), not "all day".
 */
export function isWithinQuietHours(
  now: Date,
  window: { readonly start: string; readonly end: string; readonly timezone: string },
): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return false;
  const local = localMinutes(now, window.timezone);
  if (local === null) return false;
  if (start < end) return local >= start && local < end;
  return local >= start || local < end;
}

function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinutes(now: Date, timezone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone.trim() === "" ? "UTC" : timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    // An invalid time zone must not break a send decision; the settings warning already names it.
    return null;
  }
}

/** Exported for the health report and tests: the ordered policy checklist in one place. */
export const POLICY_CHECKLIST = POLICY_REFUSAL_CODES;
