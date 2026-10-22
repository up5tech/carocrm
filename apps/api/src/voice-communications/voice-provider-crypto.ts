import { createHmac, timingSafeEqual } from "node:crypto";

import { stableStringify } from "./voice-communications-domain.js";

/**
 * Signature primitives shared by the provider adapters.
 *
 * A vendor signature is compared in constant time and the algorithm lives with the adapter that
 * owns it; nothing above the adapter boundary invents a signature scheme
 * (`PLAN_Phase_19_Voice_Communications.md` §11.4). The canonical-JSON rule is documented in
 * `docs/modules/voice-communications/providers.md`: HMAC-SHA256 over
 * `timestamp + "." + stable JSON`. It is used by the simulator and by the Asterisk event bridge.
 */
export function signCanonicalWebhook(secret: string, timestamp: string, body: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(`${timestamp}.${stableStringify(body)}`).digest("hex");
}

/**
 * Twilio's `X-Twilio-Signature`: HMAC-SHA1 over the absolute callback URL followed by every POST
 * parameter, sorted by name, as `name + value` with no separators. Twilio signs the form body it
 * sends, so a parsed body is sufficient; the exact URL matters and the adapter compares the
 * signature against both the reconstructed request URL and the account's configured `webhookUrl`.
 */
export function signTwilioWebhook(authToken: string, url: string, params: Readonly<Record<string, unknown>>): string {
  const material = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${twilioValue(params[key])}`, url);
  return createHmac("sha1", authToken).update(material, "utf8").digest("base64");
}

export function constantTimeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** `Basic` authorization for Twilio's REST API and for a self-hosted Asterisk ARI endpoint. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function twilioValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => twilioValue(entry)).join("");
  if (value === null || value === undefined) return "";
  return String(value);
}
