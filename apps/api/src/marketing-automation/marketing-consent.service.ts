import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig,CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  type CampaignPurpose,
  checkConsentTransition,
  CONSENT_CHANNELS,
  type ConsentChannel,
  type ConsentSource,
  type ConsentStatus,
  isConsentStatus,
  MARKETING_CONSENT_ENTITY,
  MARKETING_CONSENT_EVENT_ENTITY,
  normalizeEmailAddress,
} from "./marketing-automation-domain.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { emailIdentity } from "./marketing-identity.js";

/**
 * Phase 19-MA.5 — consent state and its audit trail
 * (PLAN_Phase_19_Marketing_Automation.md §5.3, §6.3, §7.1 `MarketingConsentService`).
 *
 * Consent is the gate everything else stands on, so the rules this service enforces are the plan's, not
 * conveniences:
 *
 *  - **one live decision per (address identity, channel, purpose)** — the unique index in migration 038 and
 *    the lookup here agree, so two records can never hold contradictory states for the same person;
 *  - **a mutation always writes history** (§5.3 invariant 9): actor, source, prior state, new state, reason
 *    and timestamp, in the same transaction as the state change;
 *  - **missing evidence is never consent** (§5.3 invariant 5): no record means `Unknown`, and `Unknown`
 *    blocks. There is no code path here that infers a grant;
 *  - **re-consent is affirmative and attributable** (§5.3.2, invariant 7): moving out of `OptedOut` or
 *    `Suppressed` requires a new basis and a reason naming the evidence, so a preference change cannot
 *    silently re-subscribe someone;
 *  - **an address change does not carry consent over** (§5.3 invariant 7): the identity is a digest of the
 *    normalised address, so a person who moves to `new@example.com` starts at `Unknown` there by
 *    construction, and the old address keeps whatever state it had.
 *
 * The public paths (an unsubscribe link, a preference centre) have no logged-in user, so they run under the
 * documented service identity — the same narrow mechanism every other Phase 19 domain uses (§9.2), never a
 * human session and never an all-powerful bypass: it writes consent and history, and nothing else.
 */

export interface ConsentMutation {
  readonly emailAddress?: string | undefined;
  readonly emailHash?: string | undefined;
  readonly channel?: ConsentChannel | undefined;
  readonly purpose: CampaignPurpose;
  readonly to: ConsentStatus;
  readonly basis?: string | undefined;
  readonly source: ConsentSource;
  readonly reason?: string | undefined;
  readonly policyVersion?: string | undefined;
  readonly locale?: string | undefined;
  readonly captureContext?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly targetListId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly leadId?: string | undefined;
  readonly subjectType?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly confirmedTokenId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ConsentView {
  readonly consentId: string;
  readonly emailHash: string;
  readonly channel: ConsentChannel;
  readonly purpose: string;
  readonly status: ConsentStatus;
  readonly basis: string | null;
  readonly source: string | null;
  readonly consentedAt: string | null;
  readonly confirmedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly policyVersion: string | null;
  readonly locale: string | null;
}

export interface ConsentEventView {
  readonly id: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly source: string | null;
  readonly basis: string | null;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly occurredAt: string | null;
}

@Injectable()
export class MarketingConsentService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** The identity this platform uses for an address, or null when the value cannot be one. */
  identity(address: unknown): string | null {
    return emailIdentity(address, this.config.encryptionKey)?.hash ?? null;
  }

  /** Current state for an address identity. No record is `Unknown`, never an assumption of consent. */
  async statusFor(
    emailHash: string,
    purpose: CampaignPurpose,
    channel: ConsentChannel = "Email",
  ): Promise<{ status: ConsentStatus; consentId: string | null }> {
    const rows = await this.records.findByAttrs(
      MARKETING_CONSENT_ENTITY,
      { emailHash, channel, purpose },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return { status: "Unknown", consentId: null };
    const status = isConsentStatus(row.data["status"]) ? row.data["status"] : "Unknown";
    return { status, consentId: row.id };
  }

  /**
   * Record a consent decision. Idempotent: the same `idempotencyKey` returns the original result, and a
   * mutation that would not change the state is a no-op rather than a new history row (§5.3 invariant 10).
   */
  async record(input: ConsentMutation): Promise<{
    consent: ConsentView;
    changed: boolean;
    idempotent: boolean;
  }> {
    const channel = input.channel ?? "Email";
    if (!(CONSENT_CHANNELS as readonly string[]).includes(channel)) {
      throw new ValidationError("Only the Email channel is supported for consent in this release (§3.2).", {
        channel,
      });
    }
    const emailHash = this.resolveIdentity(input);
    const existing = await this.records.findByAttrs(
      MARKETING_CONSENT_ENTITY,
      { emailHash, channel, purpose: input.purpose },
      { limit: 1 },
    );
    const current = existing[0];
    const fromStatus = current === undefined
      ? "Unknown"
      : isConsentStatus(current.data["status"])
        ? current.data["status"]
        : "Unknown";

    if (input.idempotencyKey !== undefined && input.idempotencyKey.trim() !== "") {
      const prior = await this.findEventByKey(current?.id, input.idempotencyKey.trim());
      if (prior !== undefined) {
        return {
          consent: current !== undefined ? toConsentView(current.id, current.data) : {
            consentId: "",
            emailHash,
            channel,
            purpose: input.purpose,
            status: fromStatus,
            basis: null,
            source: null,
            consentedAt: null,
            confirmedAt: null,
            withdrawnAt: null,
            policyVersion: null,
            locale: null,
          },
          changed: false,
          idempotent: true,
        };
      }
    }

    const check = checkConsentTransition(fromStatus, input.to);
    if (!check.allowed) {
      throw new ValidationError(check.message ?? "Invalid consent transition.", {
        code: check.code ?? "CONSENT_TRANSITION_NOT_ALLOWED",
        emailHash,
        purpose: input.purpose,
      });
    }
    if (fromStatus === input.to && current !== undefined) {
      return { consent: toConsentView(current.id, current.data), changed: false, idempotent: false };
    }
    this.assertReconsentEvidence(fromStatus, input);

    const actor = this.scope.principal;
    await this.acl.assertAccess(MARKETING_CONSENT_ENTITY, current === undefined ? "create" : "edit");

    const now = new Date();
    const data = buildConsentData({
      emailHash,
      channel,
      purpose: input.purpose,
      status: input.to,
      basis: input.basis,
      source: input.source,
      policyVersion: input.policyVersion,
      locale: input.locale,
      captureContext: input.captureContext,
      campaignId: input.campaignId,
      targetListId: input.targetListId,
      contactId: input.contactId,
      leadId: input.leadId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      confirmedTokenId: input.confirmedTokenId,
      actorUserId: actor?.userId ?? "system",
      now,
    });

    const consentId = await runInTransaction(this.database.db, async (tx) => {
      // The caller's own permission was asserted above; the row write then runs under the module identity so
      // a public unsubscribe (no principal) and a marketer's manual record take the same path.
      const saved = current === undefined
        ? await runAsMarketingSystem(this.scope, "consentWrite", () => this.entities.create(MARKETING_CONSENT_ENTITY, data))
        : await runAsMarketingSystem(this.scope, "consentWrite", () => this.entities.update(MARKETING_CONSENT_ENTITY, current.id, data));
      const id = String(saved["id"]);
      await runAsMarketingSystem(this.scope, "consentHistory", () =>
        this.entities.create(MARKETING_CONSENT_EVENT_ENTITY, {
          name: `${input.purpose} · ${fromStatus} → ${input.to}`,
          consentId: id,
          emailHash,
          channel,
          purpose: input.purpose,
          fromStatus,
          toStatus: input.to,
          source: input.source,
          basis: input.basis ?? null,
          reason: input.reason ?? null,
          policyVersion: input.policyVersion ?? null,
          actorUserId: actor?.userId ?? "system",
          actorType: actor?.userType ?? "system",
          campaignId: input.campaignId ?? null,
          targetListId: input.targetListId ?? null,
          occurredAt: now.toISOString(),
          idempotencyKey: input.idempotencyKey?.trim() || null,
        }),
      );
      await this.events.dispatch(tx, {
        type: "marketingAutomation.consent.changed",
        payload: {
          schemaVersion: 1,
          occurredAt: now.toISOString(),
          consentId: id,
          purpose: input.purpose,
          channel,
          from: fromStatus,
          to: input.to,
          source: input.source,
          actorUserId: actor?.userId ?? "system",
          // The digest only: §7.3 forbids personal data in an event payload, and a hash of a normalised
          // address is already an identifier we do not want duplicated into every consumer's store.
        },
      });
      return id;
    });

    const row = await this.records.byId(MARKETING_CONSENT_ENTITY, consentId);
    if (row === undefined) throw new NotFoundError("Consent record could not be read back after writing.");
    return { consent: toConsentView(row.id, row.data), changed: true, idempotent: false };
  }

  /** The recorded history of one consent decision, oldest first. */
  async history(consentId: string): Promise<{ list: ConsentEventView[] }> {
    const row = await this.records.byId(MARKETING_CONSENT_ENTITY, consentId);
    if (row === undefined) throw new NotFoundError(`Consent "${consentId}" does not exist.`);
    await this.acl.assertAccess(MARKETING_CONSENT_ENTITY, "read");
    const events = await this.records.findByAttrs(MARKETING_CONSENT_EVENT_ENTITY, { consentId });
    const list = events
      .map((event) => toEventView(event.id, event.data))
      .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
    return { list };
  }

  /** Read one consent record the caller is allowed to see. */
  async get(consentId: string): Promise<ConsentView> {
    const row = await this.records.byId(MARKETING_CONSENT_ENTITY, consentId);
    if (row === undefined) throw new NotFoundError(`Consent "${consentId}" does not exist.`);
    await this.acl.assertAccess(MARKETING_CONSENT_ENTITY, "read");
    return toConsentView(row.id, row.data);
  }

  /**
   * §5.3 invariant 7: a person who opted out is only re-subscribed by an affirmative act with evidence.
   * `basis` names what that evidence is, and `reason` is kept in history, so the decision is auditable
   * rather than a status edit.
   */
  private assertReconsentEvidence(fromStatus: ConsentStatus, input: ConsentMutation): void {
    if (fromStatus !== "OptedOut" && fromStatus !== "Suppressed") return;
    if (input.to !== "Consented") return;
    const basis = input.basis?.trim() ?? "";
    const reason = input.reason?.trim() ?? "";
    if (basis === "" || reason === "") {
      throw new ValidationError(
        `Re-subscribing an address that is "${fromStatus}" requires a consent basis and a reason naming the evidence; a preference change alone cannot undo an opt-out (§5.3.2).`,
        { code: "CONSENT_RECONSENT_EVIDENCE_REQUIRED", purpose: input.purpose },
      );
    }
  }

  private resolveIdentity(input: ConsentMutation): string {
    const direct = input.emailHash?.trim() ?? "";
    if (direct !== "") {
      if (!/^[0-9a-f]{64}$/.test(direct)) {
        throw new ValidationError("An address identity must be the 64-character digest this platform computes.", {
          field: "emailHash",
        });
      }
      return direct;
    }
    const normalized = normalizeEmailAddress(input.emailAddress);
    if (normalized === "") {
      throw new ValidationError("A consent decision needs an email address or its identity.", {
        code: "CONSENT_ADDRESS_REQUIRED",
      });
    }
    const identity = emailIdentity(normalized, this.config.encryptionKey);
    if (identity === null) {
      throw new ValidationError("That value is not an email address.", { code: "CONSENT_ADDRESS_INVALID" });
    }
    return identity.hash;
  }

  private async findEventByKey(
    consentId: string | undefined,
    idempotencyKey: string,
  ): Promise<{ id: string } | undefined> {
    const rows = await this.records.findByAttrs(MARKETING_CONSENT_EVENT_ENTITY, { idempotencyKey }, { limit: 5 });
    // The key is scoped to the caller's operation; a match on any consent row of this address is a replay.
    return rows.find((row) => consentId === undefined || row.data["consentId"] === consentId);
  }
}

function buildConsentData(input: {
  emailHash: string;
  channel: ConsentChannel;
  purpose: CampaignPurpose;
  status: ConsentStatus;
  basis?: string | undefined;
  source: ConsentSource;
  policyVersion?: string | undefined;
  locale?: string | undefined;
  captureContext?: string | undefined;
  campaignId?: string | undefined;
  targetListId?: string | undefined;
  contactId?: string | undefined;
  leadId?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  confirmedTokenId?: string | undefined;
  actorUserId: string;
  now: Date;
}): Record<string, unknown> {
  const at = input.now.toISOString();
  const granting = input.status === "Consented";
  const withdrawing = input.status === "OptedOut" || input.status === "Suppressed";
  return {
    name: `${input.purpose} · ${input.channel}`,
    emailHash: input.emailHash,
    channel: input.channel,
    purpose: input.purpose,
    status: input.status,
    basis: input.basis ?? null,
    source: input.source,
    policyVersion: input.policyVersion ?? null,
    locale: input.locale ?? null,
    captureContext: input.captureContext ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    contactId: input.contactId ?? null,
    leadId: input.leadId ?? null,
    campaignId: input.campaignId ?? null,
    targetListId: input.targetListId ?? null,
    confirmedTokenId: input.confirmedTokenId ?? null,
    actorUserId: input.actorUserId,
    // Derived stamps: the guard refuses a client that writes these, so they always describe a real
    // transition rather than a typed-in date (§5.3 invariant 9).
    consentedAt: granting ? at : null,
    confirmedAt: granting ? at : null,
    withdrawnAt: withdrawing ? at : null,
  };
}

function toConsentView(id: string, data: Record<string, unknown>): ConsentView {
  return {
    consentId: id,
    emailHash: text(data["emailHash"]) ?? "",
    channel: "Email",
    purpose: text(data["purpose"]) ?? "",
    status: isConsentStatus(data["status"]) ? data["status"] : "Unknown",
    basis: text(data["basis"]) ?? null,
    source: text(data["source"]) ?? null,
    consentedAt: text(data["consentedAt"]) ?? null,
    confirmedAt: text(data["confirmedAt"]) ?? null,
    withdrawnAt: text(data["withdrawnAt"]) ?? null,
    policyVersion: text(data["policyVersion"]) ?? null,
    locale: text(data["locale"]) ?? null,
  };
}

function toEventView(id: string, data: Record<string, unknown>): ConsentEventView {
  return {
    id,
    fromStatus: text(data["fromStatus"]) ?? null,
    toStatus: text(data["toStatus"]) ?? "Unknown",
    source: text(data["source"]) ?? null,
    basis: text(data["basis"]) ?? null,
    reason: text(data["reason"]) ?? null,
    actorUserId: text(data["actorUserId"]) ?? null,
    actorType: text(data["actorType"]) ?? "system",
    occurredAt: text(data["occurredAt"]) ?? null,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
