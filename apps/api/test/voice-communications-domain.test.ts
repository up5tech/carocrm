import { describe, expect, it } from "vitest";

import {
  callingCodeForRegion,
  LibPhoneNumberNormalizer,
  normalizePhone,
  phoneDigits,
  phoneMatchKeys,
} from "../src/voice-communications/phone-number.js";
import {
  advanceMessageState,
  CALL_STATES,
  callControlCapabilityFor,
  callControlTargetState,
  callEventFor,
  canControlCall,
  canTransitionCall,
  canTransitionConversation,
  CONVERSATION_STATES,
  conversationStateAfterInbound,
  DOMAIN_EVENTS,
  errorMessageFor,
  isCallTerminal,
  isMessageTerminal,
  isRetryableError,
  isWhatsAppWindowOpen,
  mapCallStatus,
  mapMessageStatus,
  MESSAGE_STATES,
  messageEventFor,
  payloadDigest,
  POLICY_REFUSAL_CODES,
  policyRefusalMessage,
  redactPayload,
  stableStringify,
  WEBHOOK_REPLAY_WINDOW_MS,
  webhookDedupKey,
} from "../src/voice-communications/voice-communications-domain.js";

/**
 * Phase 19-VC.1 / 19-VC.6 — pure domain contracts.
 *
 * These suites boot nothing: no database, no Nest, no network. They are the fixtures the plan asks
 * for (§15 `19-VC.1` acceptance: "state machine and event contracts are documented and tested with
 * representative fixtures").
 */

describe("call state machine", () => {
  it("moves forward through a normal outbound call", () => {
    expect(canTransitionCall("requested", "initiated")).toBe(true);
    expect(canTransitionCall("initiated", "ringing")).toBe(true);
    expect(canTransitionCall("ringing", "in_progress")).toBe(true);
    expect(canTransitionCall("in_progress", "completed")).toBe(true);
  });

  it("never regresses a terminal call from a duplicate or late callback", () => {
    for (const terminal of ["completed", "missed", "busy", "no_answer", "failed", "cancelled"] as const) {
      expect(isCallTerminal(terminal)).toBe(true);
      expect(canTransitionCall(terminal, "ringing")).toBe(false);
      expect(canTransitionCall(terminal, "in_progress")).toBe(false);
      expect(canTransitionCall(terminal, terminal)).toBe(true);
    }
  });

  it("lets reconciliation settle an unknown call but not restart it", () => {
    expect(canTransitionCall("unknown", "completed")).toBe(true);
    expect(canTransitionCall("unknown", "failed")).toBe(true);
    expect(canTransitionCall("unknown", "ringing")).toBe(false);
  });

  it("maps vendor statuses without inventing success", () => {
    expect(mapCallStatus("in-progress")).toBe("in_progress");
    expect(mapCallStatus("answered")).toBe("in_progress");
    expect(mapCallStatus("no_answer")).toBe("no_answer");
    expect(mapCallStatus("call-cancelled")).toBe("cancelled");
    expect(mapCallStatus("something-new")).toBe("unknown");
    expect(mapCallStatus("")).toBe("unknown");
  });

  it("announces an event only for states that have one", () => {
    expect(callEventFor("initiated")).toBe("voiceCommunications.call.initiated");
    expect(callEventFor("in_progress")).toBe("voiceCommunications.call.answered");
    expect(callEventFor("completed")).toBe("voiceCommunications.call.completed");
    expect(callEventFor("unknown")).toBeNull();
    expect(callEventFor("requested")).toBeNull();
  });
});

describe("message state machine", () => {
  it("is monotonic under out-of-order callbacks", () => {
    expect(advanceMessageState("sent", "delivered")).toBe("delivered");
    // A late "sent" must not undo "delivered".
    expect(advanceMessageState("delivered", "sent")).toBe("delivered");
    expect(advanceMessageState("read", "delivered")).toBe("read");
  });

  it("lets a hard failure override an earlier delivery claim", () => {
    expect(advanceMessageState("delivered", "failed")).toBe("failed");
    expect(advanceMessageState("delivered", "undelivered")).toBe("undelivered");
  });

  it("keeps a known state when an unknown callback arrives", () => {
    expect(advanceMessageState("delivered", "unknown")).toBe("delivered");
    expect(advanceMessageState("queued", "unknown")).toBe("unknown");
  });

  it("marks delivery states terminal and queued states not", () => {
    expect(isMessageTerminal("delivered")).toBe(true);
    expect(isMessageTerminal("read")).toBe(true);
    expect(isMessageTerminal("failed")).toBe(true);
    expect(isMessageTerminal("sent")).toBe(false);
  });

  it("maps provider statuses, defaulting to unknown", () => {
    expect(mapMessageStatus("accepted")).toBe("submitted");
    expect(mapMessageStatus("delivered")).toBe("delivered");
    expect(mapMessageStatus("read")).toBe("read");
    expect(mapMessageStatus("rejected")).toBe("failed");
    expect(mapMessageStatus("what-is-this")).toBe("unknown");
  });

  it("announces a failed or undelivered message as message.failed", () => {
    expect(messageEventFor("failed")).toBe("voiceCommunications.message.failed");
    expect(messageEventFor("undelivered")).toBe("voiceCommunications.message.failed");
    expect(messageEventFor("submitted")).toBeNull();
  });
});

describe("conversation states", () => {
  it("keeps conversation state separate and explicit", () => {
    expect(canTransitionConversation("open", "resolved")).toBe(true);
    expect(canTransitionConversation("closed", "pending_customer")).toBe(false);
    expect(canTransitionConversation("spam", "open")).toBe(true);
  });

  it("reopens a resolved conversation on inbound traffic but not a closed one", () => {
    expect(conversationStateAfterInbound("resolved")).toBe("open");
    expect(conversationStateAfterInbound("closed")).toBe("closed");
    expect(conversationStateAfterInbound("open")).toBe("open");
  });
});

describe("taxonomy constants", () => {
  it("declares every state exactly once", () => {
    expect(new Set(CALL_STATES).size).toBe(CALL_STATES.length);
    expect(new Set(MESSAGE_STATES).size).toBe(MESSAGE_STATES.length);
    expect(new Set(CONVERSATION_STATES).size).toBe(CONVERSATION_STATES.length);
  });

  it("uses the repository's camelCase event namespace", () => {
    for (const name of DOMAIN_EVENTS) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$/);
      expect(name.startsWith("voiceCommunications.")).toBe(true);
    }
  });

  it("classifies retryable errors only", () => {
    expect(isRetryableError("rate_limit")).toBe(true);
    expect(isRetryableError("timeout")).toBe(true);
    expect(isRetryableError("provider_unavailable")).toBe(true);
    expect(isRetryableError("consent_required")).toBe(false);
    expect(isRetryableError("suppressed")).toBe(false);
    expect(isRetryableError("invalid_recipient")).toBe(false);
  });

  it("gives every policy refusal an operator sentence", () => {
    for (const code of POLICY_REFUSAL_CODES) {
      expect(policyRefusalMessage(code).length).toBeGreaterThan(10);
    }
    expect(errorMessageFor("timeout")).toContain("uncertain");
  });
});

describe("webhook idempotency", () => {
  it("prefers the provider event id", () => {
    expect(webhookDedupKey({ providerEventId: "evt-1", eventType: "delivered" })).toBe("id:evt-1");
  });

  it("derives a stable digest when no id exists", () => {
    const a = webhookDedupKey({ eventType: "delivered", externalId: "SM1", occurredAt: "2026-01-01T00:00:00Z" });
    const b = webhookDedupKey({ eventType: "DELIVERED", externalId: "SM1", occurredAt: "2026-01-01T00:00:00Z" });
    expect(a).toBe(b);
    expect(a.startsWith("digest:")).toBe(true);
  });

  it("digests key order-independently", () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(stableStringify({ b: [2, { d: 4, c: 3 }], a: 1 })).toBe('{"a":1,"b":[2,{"c":3,"d":4}]}');
  });

  it("redacts credential-like fields at any depth", () => {
    const redacted = redactPayload({
      type: "delivered",
      secret: "nope",
      nested: { token: "nope", ok: "yes" },
      apiKey: "nope",
    });
    expect(redacted).toEqual({ type: "delivered", nested: { ok: "yes" } });
  });

  it("uses a five-minute replay window", () => {
    expect(WEBHOOK_REPLAY_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe("phone normalization", () => {
  it("normalizes international input", () => {
    expect(normalizePhone("+1 (415) 555-0100").e164).toBe("+14155550100");
    expect(normalizePhone("0044 20 7946 0958").e164).toBe("+442079460958");
  });

  it("applies the default region and drops a trunk prefix", () => {
    expect(normalizePhone("0912 345 678", "VN").e164).toBe("+84912345678");
    expect(normalizePhone("(415) 555-0100", "US").e164).toBe("+14155550100");
    expect(normalizePhone("020 7946 0958", "GB").e164).toBe("+442079460958");
  });

  it("rejects input it cannot normalize instead of guessing", () => {
    expect(normalizePhone("")).toMatchObject({ valid: false, reason: "empty" });
    expect(normalizePhone("not a phone")).toMatchObject({ valid: false, reason: "invalid_characters" });
    expect(normalizePhone("12345", "US")).toMatchObject({ valid: false, reason: "too_short" });
    expect(normalizePhone("+1234567890123456")).toMatchObject({ valid: false, reason: "too_long" });
    expect(normalizePhone("0912345678", "ZZ")).toMatchObject({ valid: false, reason: "unknown_region" });
  });

  it("exposes the match keys the resolver needs", () => {
    const us = normalizePhone("+14155550100");
    expect(phoneMatchKeys(us)).toEqual(["14155550100", "4155550100"]);
    expect(phoneDigits("(415) 555-0100")).toBe("4155550100");
  });

  it("knows the calling codes it claims", () => {
    expect(callingCodeForRegion("vn")).toBe("84");
    expect(callingCodeForRegion("GB")).toBe("44");
    expect(callingCodeForRegion("ZZ")).toBeNull();
  });
});

describe("libphonenumber normalizer (default implementation)", () => {
  const normalizer = new LibPhoneNumberNormalizer();

  it("applies numbering-plan metadata for a national number", () => {
    expect(normalizer.normalize("0912 345 678", "VN")).toMatchObject({
      valid: true,
      e164: "+84912345678",
      nationalDigits: "912345678",
      callingCode: "84",
    });
    expect(normalizer.normalize("(415) 555-0100", "US")).toMatchObject({
      valid: true,
      e164: "+14155550100",
      nationalDigits: "4155550100",
      callingCode: "1",
    });
  });

  it("accepts an international number without a region", () => {
    expect(normalizer.normalize("+44 20 7946 0958")).toMatchObject({ valid: true, e164: "+442079460958" });
  });

  it("rejects a number the numbering plan does not assign", () => {
    // Structurally plausible E.164, but not a valid US number — the conservative normalizer would
    // accept it, which is exactly why the metadata-backed implementation is the default.
    const result = normalizer.normalize("+10000000000");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_number");
    expect(normalizePhone("+10000000000").valid).toBe(true);
  });

  it("rejects non-numeric input and an unsupported region", () => {
    expect(normalizer.normalize("not a phone", "US")).toMatchObject({ valid: false, reason: "invalid_characters" });
    expect(normalizer.normalize("0912345678", "ZZ")).toMatchObject({ valid: false, reason: "unknown_region" });
    expect(normalizer.normalize("", "US")).toMatchObject({ valid: false, reason: "empty" });
  });

  it("produces the same match keys the resolver compares", () => {
    expect(phoneMatchKeys(normalizer.normalize("+14155550100"))).toEqual(["14155550100", "4155550100"]);
  });
});

describe("WhatsApp service window", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("is open inside the window and closed outside it", () => {
    expect(isWhatsAppWindowOpen("2026-01-01T00:00:00Z", now)).toBe(true);
    expect(isWhatsAppWindowOpen("2025-12-30T00:00:00Z", now)).toBe(false);
  });

  it("is closed when the customer never wrote", () => {
    expect(isWhatsAppWindowOpen(null, now)).toBe(false);
  });

  it("honours an injectable window length", () => {
    expect(isWhatsAppWindowOpen("2026-01-01T00:00:00Z", now, 6)).toBe(false);
    expect(isWhatsAppWindowOpen("2026-01-01T00:00:00Z", now, 24)).toBe(true);
  });
});

describe("call control (19-VC.9)", () => {
  it("names the capability each control needs", () => {
    expect(callControlCapabilityFor("answer")).toBe("voice.callAnswer");
    expect(callControlCapabilityFor("hangup")).toBe("voice.callHangup");
  });

  it("offers a control only while the call can still take it", () => {
    expect(canControlCall("ringing", "answer")).toBe(true);
    expect(canControlCall("in_progress", "answer")).toBe(false);
    expect(canControlCall("ringing", "hangup")).toBe(true);
    expect(canControlCall("in_progress", "hangup")).toBe(true);
    for (const state of CALL_STATES.filter(isCallTerminal)) {
      expect(canControlCall(state, "answer")).toBe(false);
      expect(canControlCall(state, "hangup")).toBe(false);
    }
  });

  it("ends a answered call and a declined call differently", () => {
    expect(callControlTargetState("ringing", "answer")).toBe("in_progress");
    expect(callControlTargetState("in_progress", "hangup")).toBe("completed");
    expect(callControlTargetState("ringing", "hangup")).toBe("cancelled");
    // Every control target is a legal transition, so a control can never regress the machine.
    expect(canTransitionCall("ringing", callControlTargetState("ringing", "answer"))).toBe(true);
    expect(canTransitionCall("in_progress", callControlTargetState("in_progress", "hangup"))).toBe(true);
    expect(canTransitionCall("ringing", callControlTargetState("ringing", "hangup"))).toBe(true);
  });
});
