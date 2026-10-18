import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  type CampaignPurpose,
  type ConsentChannel,
  type ConsentStatus,
  isCampaignPurpose,
  MARKETING_CONSENT_ENTITY,
  MARKETING_PUBLIC_TOKEN_ENTITY,
  PUBLIC_TOKEN_SCOPES,
  PUBLIC_TOKEN_TTL_DAYS,
  type PublicTokenScope,
} from "./marketing-automation-domain.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { hashToken, issueToken,PUBLIC_TOKEN_INVALID_MESSAGE } from "./marketing-identity.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";

/**
 * Phase 19-MA.5 — public unsubscribe, preference centre and opt-in confirmation
 * (PLAN_Phase_19_Marketing_Automation.md §5.3.1, §5.3.2, §8.3, §9.3).
 *
 * These are the only unauthenticated paths in the module, so they carry the plan's privacy rules directly:
 *
 *  - **the link reveals nothing.** A token is 256 random bits, only its digest is stored, and every failure
 *    answers the same generic sentence — an attacker cannot learn whether an address is in the CRM, and a
 *    valid token cannot be guessed or enumerated (§15 `19-MA.5` acceptance);
 *  - **a GET never opts anyone out.** Mail clients and link-preview crawlers fetch URLs; the deliberate
 *    confirmation is the POST (§5.3.1). `GET …/unsubscribe/:token` returns the page, `POST` performs it;
 *  - **the operation is idempotent.** Pressing the link twice, a crawler prefetch followed by a real click,
 *    or a retried one-click POST all succeed once and then report the same outcome without writing a second
 *    history row (§5.3 invariant 10);
 *  - **scope travels with the token.** A purpose-scoped link cannot unsubscribe the person from everything,
 *    and a "one-click list unsubscribe" that carries no purpose becomes a global block — which is what
 *    §1.2's "suppression wins" and §5.3's precedence rules require;
 *  - **a mutation is one-way.** An opt-out cannot be reversed through a public endpoint; re-subscribing
 *    needs the affirmative, evidence-bearing path in `MarketingConsentService` (§5.3.2).
 *
 * There is no logged-in user here, so writes run under the module's documented service identity (§9.2) —
 * attributed to `system`, inside one transaction, and never a way to touch anything other than the consent
 * and suppression records the token itself names.
 */

/** A public link may be exercised a bounded number of times before it is retired. */
const MAX_PUBLIC_ATTEMPTS = 25;

export interface IssuedLink {
  readonly tokenId: string;
  readonly token: string;
  readonly expiresAt: string;
  /** The SPA route a recipient is sent to; the API endpoint is derived from the same token. */
  readonly path: string;
}

export interface PreferenceState {
  readonly purpose: string;
  readonly status: ConsentStatus;
}

export interface PreferenceView {
  readonly categories: readonly PreferenceState[];
  readonly globallySuppressed: boolean;
  readonly expiresAt: string | null;
}

export interface UnsubscribeResult {
  readonly unsubscribed: true;
  readonly scope: "global" | "purpose";
  readonly purpose: string | null;
  /** True when this call was the one that took effect; a replay still succeeds (§5.3 invariant 10). */
  readonly applied: boolean;
}

@Injectable()
export class MarketingPublicTokenService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(MarketingConsentService) private readonly consent: MarketingConsentService,
    @Inject(MarketingSuppressionService) private readonly suppressions: MarketingSuppressionService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Mint a link for an address identity. Authorised callers only: a token is a credential, so issuing one
   * requires the caller to be able to write consent records (§9.1 "Preview content and send a test
   * message"-level capability, not a free utility endpoint).
   */
  async issue(
    scope: PublicTokenScope,
    input: {
      readonly emailHash: string;
      readonly channel?: ConsentChannel | undefined;
      readonly purpose?: CampaignPurpose | undefined;
      readonly campaignId?: string | undefined;
      readonly targetListId?: string | undefined;
    },
  ): Promise<IssuedLink> {
    if (!(PUBLIC_TOKEN_SCOPES as readonly string[]).includes(scope)) {
      throw new ValidationError(`"${scope}" is not a public link scope.`, { field: "scope" });
    }
    if (!/^[0-9a-f]{64}$/.test(input.emailHash)) {
      throw new ValidationError("A public link needs the address identity this platform computes.", {
        field: "emailHash",
      });
    }
    await this.acl.assertAccess(MARKETING_CONSENT_ENTITY, "create");

    const { token, tokenHash } = issueToken();
    const ttlDays = PUBLIC_TOKEN_TTL_DAYS[scope];
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlDays * 86_400_000);

    // Revoke the outstanding links of the same scope for this identity, so an old printed link cannot be
    // used after a new one has been issued (§5.3.2 "revoke old preference tokens when appropriate").
    const outstanding = await this.records.findByAttrs(
      MARKETING_PUBLIC_TOKEN_ENTITY,
      { emailHash: input.emailHash, scope },
      { limit: 50 },
    );
    for (const prior of outstanding) {
      if (prior.data["status"] === "Active") {
        await runAsMarketingSystem(this.scope, "publicLinkRevoke", () =>
          this.entities.update(MARKETING_PUBLIC_TOKEN_ENTITY, prior.id, { status: "Revoked" }),
        );
      }
    }

    const created = await runAsMarketingSystem(this.scope, "publicLinkIssue", () =>
      this.entities.create(MARKETING_PUBLIC_TOKEN_ENTITY, {
        name: `${scope} link`,
        tokenHash,
        scope,
        status: "Active",
        emailHash: input.emailHash,
        channel: input.channel ?? "Email",
        purpose: input.purpose ?? null,
        campaignId: input.campaignId ?? null,
        targetListId: input.targetListId ?? null,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        attempts: 0,
      }),
    );

    return {
      tokenId: String(created["id"]),
      token,
      expiresAt: expiresAt.toISOString(),
      path: `/marketing/preferences?token=${token}&scope=${scope.toLowerCase()}`,
    };
  }

  /**
   * The preference page a recipient sees. Read-only, so a crawler fetching the link learns nothing and
   * changes nothing (§5.3.1). The address itself is never returned — only the states behind the token.
   */
  async preferences(token: string): Promise<PreferenceView> {
    const record = await this.resolve(token, ["Preferences", "Unsubscribe"]);
    const purposes = ["Newsletter", "ProductMarketing", "EventUpdate", "ServiceNotice"] as const;
    const categories: PreferenceState[] = [];
    for (const purpose of purposes) {
      const state = await this.consent.statusFor(record.emailHash, purpose, record.channel);
      categories.push({ purpose, status: state.status });
    }
    const applied = await this.suppressions.appliedFor(record.emailHash, { channel: record.channel });
    return {
      categories,
      globallySuppressed: applied.some((item) => item.scope === "Global"),
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Perform an unsubscribe. `all` (or a token that carries no purpose) is a global block; a purpose-bearing
   * token withdraws only that purpose. Repeating it — including after the link was consumed — answers the
   * same way, because an opt-out that errors on the second click is an opt-out that did not work.
   */
  async unsubscribe(token: string, options: { readonly all?: boolean | undefined } = {}): Promise<UnsubscribeResult> {
    const record = await this.resolve(token, ["Unsubscribe", "Preferences"], { mutating: true });
    const global = options.all === true || record.purpose === null;
    const purpose: CampaignPurpose | null = global ? null : record.purpose;

    if (global) {
      await runAsMarketingSystem(this.scope, "publicUnsubscribe", () =>
        this.suppressions.add({
          emailHash: record.emailHash,
          channel: record.channel,
          scope: "Global",
          reason: "GlobalOptOut",
          source: "UnsubscribeLink",
          note: `Recorded from a public unsubscribe link (token ${record.tokenId}).`,
        }),
      );
    }
    if (purpose !== null) {
      await runAsMarketingSystem(this.scope, "publicUnsubscribePurpose", () =>
        this.consent.record({
          emailHash: record.emailHash,
          channel: record.channel,
          purpose,
          to: "OptedOut",
          source: "UnsubscribeLink",
          reason: "Recorded from a public unsubscribe link.",
          idempotencyKey: `unsubscribe:${record.tokenId}:${purpose}`,
        }),
      );
    }

    await this.markUsed(record);
    return {
      unsubscribed: true,
      scope: global ? "global" : "purpose",
      purpose,
      applied: !record.wasUsed,
    };
  }

  /**
   * Confirm a double-opt-in. The token names the purpose and the address, so the confirmation cannot be
   * pointed at somebody else, and it is the only public path that can *grant* consent — which is why it
   * requires its own scope and cannot be reached from an unsubscribe link.
   */
  async confirmOptIn(token: string): Promise<{ confirmed: boolean; purpose: string | null }> {
    const record = await this.resolve(token, ["OptInConfirmation"], { mutating: true });
    const confirmedPurpose = record.purpose;
    if (confirmedPurpose === null) {
      throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
    }
    await runAsMarketingSystem(this.scope, "publicOptIn", () =>
      this.consent.record({
        emailHash: record.emailHash,
        channel: record.channel,
        purpose: confirmedPurpose,
        to: "Consented",
        basis: "DoubleOptIn",
        source: "UnsubscribeLink",
        reason: "Confirmed through a double opt-in link.",
        confirmedTokenId: record.tokenId,
        idempotencyKey: `optin:${record.tokenId}`,
      }),
    );
    await this.markUsed(record);
    return { confirmed: true, purpose: confirmedPurpose };
  }

  /**
   * Resolve a presented token. Every failure — unknown, expired, revoked, over-budget — raises the *same*
   * generic error, because distinguishing them would tell an attacker which links exist (§5.3.1, §9.3).
   */
  private async resolve(
    token: string,
    allowedScopes: readonly PublicTokenScope[],
    options: { readonly mutating?: boolean } = {},
  ): Promise<{
    readonly tokenId: string;
    readonly emailHash: string;
    readonly channel: ConsentChannel;
    readonly purpose: CampaignPurpose | null;
    readonly expiresAt: string | null;
    readonly wasUsed: boolean;
  }> {
    const presented = typeof token === "string" ? token.trim() : "";
    if (presented.length < 16 || presented.length > 512) {
      throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
    }
    const hash = hashToken(presented);
    const rows = await this.records.findByAttrs(MARKETING_PUBLIC_TOKEN_ENTITY, { tokenHash: hash }, { limit: 1 });
    const row = rows[0];
    if (row === undefined) {
      throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
    }
    const data = row.data;
    const scope = typeof data["scope"] === "string" ? (data["scope"] as PublicTokenScope) : undefined;
    const status = typeof data["status"] === "string" ? data["status"] : "Active";
    const expiresAt = typeof data["expiresAt"] === "string" ? data["expiresAt"] : null;
    if (
      scope === undefined
      || !allowedScopes.includes(scope)
      || status === "Revoked"
      || (expiresAt !== null && new Date(expiresAt).getTime() < Date.now())
    ) {
      throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
    }
    const emailHash = typeof data["emailHash"] === "string" ? data["emailHash"] : "";
    if (!/^[0-9a-f]{64}$/.test(emailHash)) {
      throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
    }

    if (options.mutating === true) {
      const attempts = Number(data["attempts"] ?? 0);
      if (attempts >= MAX_PUBLIC_ATTEMPTS && status !== "Used") {
        await runAsMarketingSystem(this.scope, "publicLinkRetire", () =>
          this.entities.update(MARKETING_PUBLIC_TOKEN_ENTITY, row.id, { status: "Revoked" }),
        );
        throw new ValidationError(PUBLIC_TOKEN_INVALID_MESSAGE, { code: "PUBLIC_TOKEN_INVALID" });
      }
      await runAsMarketingSystem(this.scope, "publicLinkAttempt", () =>
        this.entities.update(MARKETING_PUBLIC_TOKEN_ENTITY, row.id, { attempts: attempts + 1 }),
      );
    }

    return {
      tokenId: row.id,
      emailHash,
      // Email is the only channel this release supports (§3.2); the field exists so a later channel does
      // not silently inherit an email-shaped decision.
      channel: "Email",
      purpose: isCampaignPurpose(data["purpose"]) ? data["purpose"] : null,
      expiresAt,
      wasUsed: status === "Used",
    };
  }

  private async markUsed(record: { readonly tokenId: string; readonly wasUsed: boolean }): Promise<void> {
    if (record.wasUsed) return;
    await runAsMarketingSystem(this.scope, "publicLinkConsume", () =>
      this.entities.update(MARKETING_PUBLIC_TOKEN_ENTITY, record.tokenId, {
        status: "Used",
        usedAt: new Date().toISOString(),
      }),
    );
  }
}
