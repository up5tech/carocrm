/**
 * Phase 19-VC.6 — phone-number normalization behind an adapter seam
 * (`PLAN_Phase_19_Voice_Communications.md` §7.1, §15 `19-VC.6` task 1).
 *
 * Two implementations share one interface:
 *
 *  - `LibPhoneNumberNormalizer` — the default. Backed by `libphonenumber-js`, it applies real
 *    numbering-plan metadata, so `isValid()` means the number is assigned for its region, not merely
 *    plausible. This is the maintained library the plan asks for.
 *  - `ConservativePhoneNormalizer` — a dependency-free fallback used by tests that exercise the
 *    contract without metadata. It accepts `+`/`00`/national input and rejects what it cannot
 *    normalize; it never claims carrier-grade validation.
 *
 * The services depend on the `PhoneNormalizer` interface through the `PHONE_NORMALIZER` token, so a
 * deployment can swap the implementation without touching the resolver, consent or policy code.
 */

import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";

export type PhoneInvalidReason =
  | "empty"
  | "invalid_characters"
  | "too_short"
  | "too_long"
  | "unknown_region"
  | "invalid_prefix"
  /** Parseable but not a valid number for its region (numbering-plan metadata rejected it). */
  | "invalid_number";

export interface PhoneNormalizationResult {
  /** True only when the input produced a plausible E.164 value. */
  readonly valid: boolean;
  /** `+<calling code><national number>`, or null when the input was rejected. */
  readonly e164: string | null;
  /** Digits only, without the country calling code — what a legacy `phoneNumber` field usually stores. */
  readonly nationalDigits: string | null;
  /** Digits only, with the calling code, for equality matching. */
  readonly internationalDigits: string | null;
  /** The calling code that was applied (from the input or the default region). */
  readonly callingCode: string | null;
  /** Why the input was rejected; absent when `valid`. */
  readonly reason?: PhoneInvalidReason;
}

export interface PhoneNormalizer {
  normalize(input: string, defaultRegion?: string): PhoneNormalizationResult;
}

/** DI token for the active implementation. Services depend on this, never on a concrete class. */
export const PHONE_NORMALIZER = Symbol("VOICE_PHONE_NORMALIZER");

/**
 * ISO 3166-1 alpha-2 → ITU calling code for the regions this deployment is likely to operate in.
 * This is deliberately a small table, not a numbering-plan database: it exists so a national
 * number can be turned into E.164, not to validate that the number is assigned.
 */
const CALLING_CODES: Readonly<Record<string, string>> = {
  US: "1",
  CA: "1",
  GB: "44",
  IE: "353",
  DE: "49",
  FR: "33",
  ES: "34",
  IT: "39",
  NL: "31",
  BE: "32",
  CH: "41",
  AT: "43",
  SE: "46",
  NO: "47",
  DK: "45",
  FI: "358",
  PL: "48",
  PT: "351",
  CZ: "420",
  GR: "30",
  RU: "7",
  TR: "90",
  UA: "380",
  VN: "84",
  TH: "66",
  MY: "60",
  SG: "65",
  ID: "62",
  PH: "63",
  IN: "91",
  CN: "86",
  HK: "852",
  TW: "886",
  JP: "81",
  KR: "82",
  AU: "61",
  NZ: "64",
  BR: "55",
  MX: "52",
  AR: "54",
  CL: "56",
  CO: "57",
  ZA: "27",
  NG: "234",
  KE: "254",
  EG: "20",
  AE: "971",
  SA: "966",
  IL: "972",
};

/** E.164 allows at most 15 digits, and no assigned number is shorter than 7. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

export function callingCodeForRegion(region: string): string | null {
  return CALLING_CODES[region.trim().toUpperCase()] ?? null;
}

/** Digits only. Used for matching a stored, human-formatted value against a normalized one. */
export function phoneDigits(value: string): string {
  return value.replace(/\D+/g, "");
}

function rejected(reason: PhoneInvalidReason, callingCode: string | null = null): PhoneNormalizationResult {
  return { valid: false, e164: null, nationalDigits: null, internationalDigits: null, callingCode, reason };
}

/**
 * Normalize `input` to E.164.
 *
 * Rules, in order:
 *  1. Trim. Empty input is `empty`, never a valid number.
 *  2. Reject anything that is not digits, spaces, `+`, `-`, `.`, `(`, `)` or `/`.
 *  3. `+…` → international, calling code read from the digits.
 *  4. `00…` → international with the leading zeros replaced by `+`.
 *  5. Otherwise → national, prefixed with `defaultRegion`'s calling code (default `US`).
 *  6. Reject fewer than 7 or more than 15 digits after normalization.
 *
 * A leading `0` in a national number is trunk-prefix notation and is dropped before the calling
 * code is applied (the common European/Vietnamese convention). This is a heuristic, not a
 * numbering-plan rule; it is documented rather than hidden.
 */
export function normalizePhone(input: string, defaultRegion = "US"): PhoneNormalizationResult {
  const raw = input.trim();
  if (raw === "") return rejected("empty");
  if (!/^[0-9+\-().\s/]+$/.test(raw)) return rejected("invalid_characters");

  const region = defaultRegion.trim().toUpperCase();
  const regionCode = callingCodeForRegion(region);

  let international: string;
  let callingCode: string | null;

  if (raw.startsWith("+")) {
    const digits = phoneDigits(raw);
    if (digits === "") return rejected("too_short");
    callingCode = matchCallingCode(digits);
    international = digits;
  } else if (raw.startsWith("00")) {
    const digits = phoneDigits(raw).replace(/^00/, "");
    if (digits === "") return rejected("too_short");
    callingCode = matchCallingCode(digits);
    international = digits;
  } else {
    if (regionCode === null) return rejected("unknown_region");
    const digits = phoneDigits(raw).replace(/^0+/, "");
    if (digits === "") return rejected("too_short");
    callingCode = regionCode;
    international = `${regionCode}${digits}`;
  }

  if (international.length < MIN_DIGITS) return rejected("too_short", callingCode);
  if (international.length > MAX_DIGITS) return rejected("too_long", callingCode);

  const nationalDigits =
    callingCode !== null && international.startsWith(callingCode)
      ? international.slice(callingCode.length)
      : international;

  return {
    valid: true,
    e164: `+${international}`,
    nationalDigits,
    internationalDigits: international,
    callingCode,
  };
}

/**
 * The longest known calling code that prefixes `digits`. Checking longest-first matters: `1` (US)
 * must not win over `1` for a `+1…` number, but `84` (VN) must not lose to `8` (no such code).
 */
function matchCallingCode(digits: string): string | null {
  const codes = [...new Set(Object.values(CALLING_CODES))].sort((a, b) => b.length - a.length);
  return codes.find((code) => digits.startsWith(code)) ?? null;
}

/**
 * Values a stored `phoneNumber` field might contain for the same number: the international digits
 * and the national digits. The resolver compares digit-normalized stored values against these,
 * which is what lets a formatted CRM value match a provider's E.164 address.
 */
export function phoneMatchKeys(result: PhoneNormalizationResult): readonly string[] {
  if (!result.valid || result.internationalDigits === null) return [];
  const keys = new Set<string>([result.internationalDigits]);
  if (result.nationalDigits !== null && result.nationalDigits !== result.internationalDigits) {
    keys.add(result.nationalDigits);
  }
  return [...keys];
}

/** The default implementation. Stateless, so it can be shared across requests. */
export class ConservativePhoneNormalizer implements PhoneNormalizer {
  normalize(input: string, defaultRegion = "US"): PhoneNormalizationResult {
    return normalizePhone(input, defaultRegion);
  }
}

/**
 * The maintained implementation, backed by `libphonenumber-js`.
 *
 * `isValid()` is the important difference from the conservative fallback: it consults the region's
 * numbering plan, so a structurally plausible but unassigned number is rejected. That is what keeps
 * a wrong Contact from being matched to an inbound call (§7.2 "do not silently select a potentially
 * wrong Contact").
 *
 * `defaultRegion` must be a supported ISO 3166-1 alpha-2 country; anything else is `unknown_region`
 * rather than a silent guess. A `+`-prefixed input parses without the region, as expected.
 */
export class LibPhoneNumberNormalizer implements PhoneNormalizer {
  normalize(input: string, defaultRegion = "US"): PhoneNormalizationResult {
    const raw = input.trim();
    if (raw === "") return rejected("empty");

    const region = defaultRegion.trim().toUpperCase();
    if (!isSupportedCountry(region)) return rejected("unknown_region");

    try {
      const parsed = parsePhoneNumberFromString(raw, region);
      if (parsed === undefined) return rejected("invalid_characters");
      if (!parsed.isValid()) {
        return rejected("invalid_number", parsed.countryCallingCode ?? null);
      }
      const e164 = parsed.number;
      return {
        valid: true,
        e164,
        nationalDigits: parsed.nationalNumber,
        internationalDigits: e164.replace(/^\+/, ""),
        callingCode: parsed.countryCallingCode,
      };
    } catch (error) {
      // libphonenumber throws for an unparseable country rather than returning undefined.
      const message = error instanceof Error ? error.message : "";
      if (message.includes("TOO_SHORT")) return rejected("too_short");
      if (message.includes("TOO_LONG")) return rejected("too_long");
      if (message.includes("INVALID_COUNTRY")) return rejected("unknown_region");
      if (message.includes("NOT_A_NUMBER")) return rejected("invalid_characters");
      return rejected("invalid_number");
    }
  }
}
