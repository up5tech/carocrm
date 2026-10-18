import { FeatureDisabledError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import {
  CAMPAIGN_ENTITY,
  type CampaignPurpose,
  isCampaignPurpose,
  MARKETING_TEMPLATE_REVISION_ENTITY,
  purposeRequiresConsent,
  SEGMENT_ENTITY_TYPES,
} from "./marketing-automation-domain.js";
import { runAsMarketingInternal } from "./marketing-automation-internal.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import {
  type RenderFinding,
  renderMarketingTemplate,
  type RenderOutput,
  type TemplateParts,
} from "./marketing-template-render.js";

/**
 * Phase 19-MA.6 — recipient-context rendering, content preview and immutable template revisions
 * (PLAN_Phase_19_Marketing_Automation.md §5.4, §6.2, §9.4, §15 `19-MA.6`).
 *
 * The `EmailTemplate` record stays platform-owned and editable; this service never forks it. What it
 * adds is the *marketing* view on top:
 *
 *  - **A restricted recipient context** (`@see renderMarketingTemplate`): a template placeholder can
 *    only name a person's own simple fields, the campaign's own configuration or a documented system
 *    link. The values come from records read through `EntityCrudService`, so *the actor's* record and
 *    field ACL decide what enters the render — an unreadable field simply never becomes a value
 *    (§9.2 first, §5.4 "prevent access to fields the sender cannot read").
 *  - **A preview, not a send**: previewing with a sample recipient resolves real values; previewing
 *    without one documents every recipient value as a fallback. The system link placeholders render
 *    a preview sentinel and are noted — the per-recipient links are inserted at send time (MA.7/MA.9),
 *    never during preview, because issuing a link here would mint a live unsubscribe credential every
 *    time a marketer opens a preview.
 *  - **An immutable revision**: `sealRevision` copies the template content into
 *    `MarketingTemplateRevision` with a content hash and a monotonic revision number, inside one
 *    transaction, as a module-internal write. A later send stores `revisionId` + `contentHash` on the
 *    delivery, which is the §15-`19-MA.6` acceptance rule "a sent message can be associated with the
 *    content revision/hash actually used" — the send infrastructure arrives in MA.7–MA.9 and reads
 *    this record, it never re-reads the (still editable) template.
 *
 * Everything render-shaped lives in the pure `marketing-template-render.ts`; this file only reads
 * records, checks access and writes revisions.
 */

export type PreviewRecipientType = (typeof SEGMENT_ENTITY_TYPES)[number];

const PREVIEW_RECIPIENT_ENTITIES: readonly string[] = ["Contact", "Lead"];

/** The recipient fields the placeholder allowlist may read, per recipient entity type. */
const RECIPIENT_FIELDS: readonly string[] = ["name", "firstName", "lastName", "emailAddress"];

export interface SealedRevisionSummary {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly contentHash: string;
  readonly templateId: string;
  readonly campaignId: string;
  readonly sealedAt: string;
  /** True when this call found an identical revision already sealed (idempotent no-op). */
  readonly reused: boolean;
}

export interface ContentPreview extends RenderOutput {
  readonly campaignId: string;
  readonly templateId: string;
  /** The sample recipient the preview rendered with, when one was named and is readable. */
  readonly recipient: { readonly type: PreviewRecipientType; readonly id: string } | null;
  readonly recipientResolved: boolean;
  /** The latest revision already sealed for the campaign's template, if any. */
  readonly latestRevision: {
    readonly revisionId: string;
    readonly revisionNumber: number;
    readonly contentHash: string;
    readonly sealedAt: string | null;
  } | null;
  readonly generatedAt: string;
}

@Injectable()
export class MarketingTemplateService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Render the linked template for one campaign, optionally against one sample recipient.
   *
   * Access follows §9.2 the same way campaign validation does: the actor must read the campaign, the
   * template and (when given) the recipient through the engine, so unreadable records are refused
   * without leaking their existence.
   *
   * @param recipientType/recipientId a *sample* recipient for personalisation only — nothing here
   *   decides an actual send; eligibility and consent stay with the MA.4/MA.5 gates.
   */
  async previewCampaignContent(
    campaignId: string,
    options: {
      readonly recipientType?: PreviewRecipientType | undefined;
      readonly recipientId?: string | undefined;
    } = {},
  ): Promise<ContentPreview> {
    const settings = await this.settings.settings();
    if (!settings.features.templates) throw new FeatureDisabledError("templates");

    const campaign = await this.entities.get(CAMPAIGN_ENTITY, campaignId);
    const templateId = typeof campaign["templateId"] === "string" ? campaign["templateId"] : "";
    if (templateId.trim() === "") {
      throw new ValidationError("This campaign has no linked email template to preview.", {
        code: "CONTENT_REQUIRED",
        campaignId,
      });
    }
    const template = await this.entities.get("EmailTemplate", templateId);
    const purpose: CampaignPurpose | null = isCampaignPurpose(campaign["purpose"]) ? campaign["purpose"] : null;
    const consentRequired = purpose !== null && purposeRequiresConsent(purpose);

    let recipient: Record<string, unknown> | null = null;
    let recipientResolved = false;
    if (options.recipientId !== undefined && options.recipientId.trim() !== "") {
      const type = options.recipientType ?? "Contact";
      if (!PREVIEW_RECIPIENT_ENTITIES.includes(type)) {
        throw new ValidationError(
          `A preview recipient must be one of ${PREVIEW_RECIPIENT_ENTITIES.join(", ")}.`,
          { code: "PREVIEW_RECIPIENT_INVALID", campaignId },
        );
      }
      // The engine applies the actor's record ACL here: an unreadable recipient is a refusal.
      recipient = await this.entities.get(type, options.recipientId);
      recipientResolved = recipient !== null;
    }

    const render = renderMarketingTemplate({
      template: templateParts(template),
      campaign: campaignValues(campaign),
      recipient: recipient === null ? null : recipientValues(recipient),
      consentRequired,
    });

    return {
      ...render,
      campaignId,
      templateId,
      recipient:
        recipientResolved === true && options.recipientType !== undefined
          ? { type: options.recipientType, id: options.recipientId ?? "" }
          : null,
      recipientResolved,
      latestRevision: await this.latestRevision(templateId),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Seal the campaign's current template content into an immutable revision.
   *
   * Requires **edit** on the campaign (sealing is part of send preparation, the same privilege class
   * as an audience snapshot) and read on the template. Two content facts make this honest:
   *
   *  - the revision stores the *raw* template parts plus their hash, so the sealed content is exactly
   *    what a later render derives from;
   *  - sealing identical content twice is a no-op that returns the existing revision — repeated checks
   *    must not mint evidence rows (§0.1 rule 10, idempotent commands).
   */
  async sealRevision(campaignId: string): Promise<SealedRevisionSummary> {
    const settings = await this.settings.settings();
    if (!settings.features.templates) throw new FeatureDisabledError("templates");

    const campaignRow = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (campaignRow === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "edit", recordShape(campaignId, campaignRow.data));

    const templateId = typeof campaignRow.data["templateId"] === "string" ? campaignRow.data["templateId"].trim() : "";
    if (templateId === "") {
      throw new ValidationError("This campaign has no linked email template to seal.", {
        code: "CONTENT_REQUIRED",
        campaignId,
      });
    }
    const template = await this.entities.get("EmailTemplate", templateId);
    const parts = templateParts(template);
    const contentHash = renderMarketingTemplate({
      template: parts,
      campaign: { name: null, code: null, objective: null, startsAt: null, endsAt: null },
      recipient: null,
      consentRequired: false,
    }).templateContentHash;

    const existing = await this.revisionsForTemplate(templateId);
    const prior = existing.find((revision) => revision.contentHash === contentHash);
    if (prior !== undefined) {
      return {
        revisionId: prior.revisionId,
        revisionNumber: prior.revisionNumber,
        contentHash,
        templateId,
        campaignId,
        sealedAt: prior.sealedAt,
        reused: true,
      };
    }

    const sealedAt = new Date().toISOString();
    const actor = this.scope.principal;
    const revisionNumber = Math.max(0, ...existing.map((revision) => revision.revisionNumber)) + 1;

    return runInTransaction(this.database.db, async (tx) => {
      const created = await runAsMarketingInternal(() =>
        this.entities.create(MARKETING_TEMPLATE_REVISION_ENTITY, {
          name: revisionTitle(template["name"], revisionNumber),
          templateId,
          revisionNumber,
          contentHash,
          subject: parts.subject ?? null,
          body: parts.body ?? null,
          bodyHtml: parts.bodyHtml ?? null,
          campaignId,
          sealedById: actor?.userId ?? null,
          sealedAt,
        }),
      );
      const revisionId = String(created["id"]);
      // Identifiers and decisions only (§7.3): the event never carries the message content itself.
      await this.events.dispatch(tx, {
        type: "marketingAutomation.template.revisionSealed",
        payload: {
          schemaVersion: 1,
          occurredAt: sealedAt,
          campaignId,
          templateId,
          revisionId,
          revisionNumber,
          contentHash,
          actorUserId: actor?.userId ?? null,
        },
      });
      return {
        revisionId,
        revisionNumber,
        contentHash,
        templateId,
        campaignId,
        sealedAt,
        reused: false,
      };
    });
  }

  /** The revisions sealed for one campaign's template, newest first (campaign read required). */
  async revisionsForCampaign(campaignId: string): Promise<{ campaignId: string; templateId: string | null; revisions: readonly RevisionHeader[] }> {
    const campaign = await this.entities.get(CAMPAIGN_ENTITY, campaignId);
    const templateId = typeof campaign["templateId"] === "string" && campaign["templateId"].trim() !== ""
      ? campaign["templateId"]
      : null;
    if (templateId === null) return { campaignId, templateId: null, revisions: [] };
    return {
      campaignId,
      templateId,
      revisions: await this.revisionsForTemplate(templateId),
    };
  }

  /** Pure renderer entry the campaign validation uses for its content findings. */
  analyzeTemplate(
    template: Record<string, unknown>,
    campaignData: { name?: unknown; code?: unknown; objective?: unknown; startsAt?: unknown; endsAt?: unknown; purpose?: unknown },
  ): RenderOutput {
    const purpose: CampaignPurpose | null =
      isCampaignPurpose(campaignData.purpose) ? campaignData.purpose : null;
    return renderMarketingTemplate({
      template: templateParts(template),
      campaign: campaignValues(campaignData),
      recipient: null,
      consentRequired: purpose !== null && purposeRequiresConsent(purpose),
    });
  }

  /** Read a template by id with the actor's ACL applied — the validation path's equivalent of `readable()`. */
  async readTemplate(templateId: string): Promise<Record<string, unknown>> {
    return this.entities.get("EmailTemplate", templateId);
  }

  private async latestRevision(templateId: string): Promise<ContentPreview["latestRevision"]> {
    const revisions = await this.revisionsForTemplate(templateId);
    const latest = revisions[0];
    return latest === undefined
      ? null
      : {
          revisionId: latest.revisionId,
          revisionNumber: latest.revisionNumber,
          contentHash: latest.contentHash,
          sealedAt: latest.sealedAt,
        };
  }

  /** Revisions of one template, newest first. bounded by the records service' own limit. */
  private async revisionsForTemplate(templateId: string): Promise<readonly RevisionHeader[]> {
    const rows = await this.records.findByAttr(MARKETING_TEMPLATE_REVISION_ENTITY, "templateId", templateId);
    return rows
      .map((row) => toRevisionHeader(row.id, row.data))
      .sort(
        (left, right) =>
          left.revisionNumber - right.revisionNumber || left.sealedAt.localeCompare(right.sealedAt),
      )
      .reverse();
  }
}

export interface RevisionHeader {
  readonly revisionId: string;
  readonly templateId: string | null;
  readonly campaignId: string | null;
  readonly revisionNumber: number;
  readonly contentHash: string;
  readonly subject: string | null;
  readonly sealedAt: string;
  readonly sealedById: string | null;
}

function toRevisionHeader(id: string, data: Record<string, unknown>): RevisionHeader {
  const revisionNumber = Number(data["revisionNumber"]);
  return {
    revisionId: id,
    templateId: text(data["templateId"]),
    campaignId: text(data["campaignId"]),
    revisionNumber: Number.isInteger(revisionNumber) && revisionNumber > 0 ? revisionNumber : 0,
    contentHash: text(data["contentHash"]) ?? "",
    subject: typeof data["subject"] === "string" ? data["subject"] : null,
    sealedAt: text(data["sealedAt"]) ?? "",
    sealedById: text(data["sealedById"]),
  };
}

function templateParts(template: Record<string, unknown>): TemplateParts {
  return {
    subject: typeof template["subject"] === "string" ? template["subject"] : null,
    body: typeof template["body"] === "string" ? template["body"] : null,
    bodyHtml: typeof template["bodyHtml"] === "string" ? template["bodyHtml"] : null,
  };
}

function campaignValues(data: Record<string, unknown>) {
  return {
    name: text(data["name"]),
    code: text(data["code"]),
    objective: text(data["objective"]),
    startsAt: text(data["startsAt"]),
    endsAt: text(data["endsAt"]),
  };
}

function recipientValues(recipient: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  for (const field of RECIPIENT_FIELDS) {
    if (typeof recipient[field] === "string") values[field] = recipient[field];
  }
  return {
    name: text(values["name"]),
    firstName: text(values["firstName"]),
    lastName: text(values["lastName"]),
    emailAddress: text(values["emailAddress"]),
  };
}

function revisionTitle(templateName: unknown, revisionNumber: number): string {
  const base = typeof templateName === "string" && templateName.trim() !== "" ? templateName : "Email template";
  return `${base} · revision ${revisionNumber}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function recordShape(id: string, data: Record<string, unknown>) {
  return {
    id,
    assignedUserId: text(data["assignedUserId"]) ?? undefined,
    createdById: text(data["createdById"]) ?? undefined,
    teams: Array.isArray(data["teams"]) ? (data["teams"] as string[]) : [],
    data,
  };
}

export type { RenderFinding };
