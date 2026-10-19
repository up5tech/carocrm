import { randomUUID } from "node:crypto";

import { NotFoundError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { DatabaseService } from "../database/database.service.js";
import { ADMIN_PERMISSION_ENTITY } from "./voice-communications-domain.js";

/**
 * Phase 19-VC.11 — WhatsApp Business template policy
 * (`PLAN_Phase_19_Voice_Communications.md` §8.3, §15 `19-VC.11`).
 *
 * The provider owns template approval; this module records what the provider told us and validates a
 * send against that record before anything is dispatched. Three rules:
 *
 *  - A template send is only permitted when the local record is `approved` for the account and the
 *    requested language.
 *  - Every `{{n}}` placeholder in the stored components needs a non-empty variable; a missing one is
 *    refused rather than sent with a literal `{{2}}`.
 *  - Approval can be revoked or rejected at any time; `setStatus` records the vendor status and the
 *    reason, so a later send fails closed instead of assuming yesterday's approval still holds.
 *
 * Template metadata is administrative configuration, so writes require the module's administrative
 * capability. The policy service reads it without that check because it is an internal decision.
 */

export const WHATSAPP_TEMPLATE_STATUSES = ["pending", "approved", "rejected", "disabled"] as const;
export type WhatsappTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

export interface WhatsappTemplateView {
  readonly id: string;
  readonly accountKey: string;
  readonly templateKey: string;
  readonly name: string;
  readonly category: string;
  readonly language: string;
  readonly components: unknown;
  readonly status: WhatsappTemplateStatus;
  readonly vendorStatus: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface TemplateValidation {
  readonly ok: boolean;
  readonly template: WhatsappTemplateView | null;
  readonly reason?: string | undefined;
}

interface TemplateRow {
  id: string;
  account_key: string;
  template_key: string;
  name: string;
  category: string;
  language: string;
  components: unknown;
  status: string;
  vendor_status: string | null;
  rejection_reason: string | null;
  created_at: Date;
  modified_at: Date;
}

@Injectable()
export class VoiceWhatsappTemplateService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  async list(accountKey: string): Promise<readonly WhatsappTemplateView[]> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "read");
    const rows = await sql<TemplateRow>`
      select * from voice_whatsapp_templates where account_key = ${accountKey} order by template_key asc, language asc
    `.execute(this.database.db);
    return rows.rows.map(toView);
  }

  async upsert(input: {
    readonly accountKey: string;
    readonly templateKey: string;
    readonly name: string;
    readonly category: string;
    readonly language: string;
    readonly components: unknown;
    readonly status: WhatsappTemplateStatus;
    readonly vendorStatus?: string | null | undefined;
    readonly rejectionReason?: string | null | undefined;
  }): Promise<WhatsappTemplateView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const now = new Date();
    const id = randomUUID();
    await sql`
      insert into voice_whatsapp_templates
        (id, account_key, template_key, name, category, language, components, status,
         vendor_status, rejection_reason, created_at, modified_at)
      values
        (${id}, ${input.accountKey}, ${input.templateKey}, ${input.name}, ${input.category},
         ${input.language}, ${JSON.stringify(input.components)}::jsonb, ${input.status},
         ${input.vendorStatus ?? null}, ${input.rejectionReason ?? null}, ${now}, ${now})
      on conflict (account_key, template_key, language) do update set
        name = excluded.name,
        category = excluded.category,
        components = excluded.components,
        status = excluded.status,
        vendor_status = excluded.vendor_status,
        rejection_reason = excluded.rejection_reason,
        modified_at = excluded.modified_at
    `.execute(this.database.db);
    return this.require(input.accountKey, input.templateKey, input.language);
  }

  async setStatus(
    accountKey: string,
    templateKey: string,
    language: string,
    status: WhatsappTemplateStatus,
    detail?: { readonly vendorStatus?: string | null; readonly rejectionReason?: string | null },
  ): Promise<WhatsappTemplateView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const updated = await sql<TemplateRow>`
      update voice_whatsapp_templates
      set status = ${status},
          vendor_status = ${detail?.vendorStatus ?? null},
          rejection_reason = ${detail?.rejectionReason ?? null},
          modified_at = now()
      where account_key = ${accountKey} and template_key = ${templateKey} and language = ${language}
      returning *
    `.execute(this.database.db);
    const row = updated.rows[0];
    if (row === undefined) throw new NotFoundError(`Template "${templateKey}" (${language}) does not exist.`);
    return toView(row);
  }

  /**
   * Validate a template send. Called by the policy service before dispatch, and again by the
   * messaging service immediately before the adapter call (§8.3 "recheck at dispatch time").
   */
  async validateForSend(input: {
    readonly accountKey: string;
    readonly templateKey: string;
    readonly language?: string | undefined;
    readonly variables?: Readonly<Record<string, string>> | null | undefined;
  }): Promise<TemplateValidation> {
    const language = (input.language ?? "en").trim();
    const row = (await sql<TemplateRow>`
      select * from voice_whatsapp_templates
      where account_key = ${input.accountKey} and template_key = ${input.templateKey} and language = ${language}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) return { ok: false, template: null, reason: "template_not_found" };
    const view = toView(row);
    if (view.status !== "approved") return { ok: false, template: view, reason: `template_${view.status}` };

    const required = placeholders(view.components);
    const supplied = input.variables ?? {};
    const missing = required.filter((name) => (supplied[name] ?? "").trim() === "");
    if (missing.length > 0) {
      return { ok: false, template: view, reason: `template_variables_missing:${missing.join(",")}` };
    }
    return { ok: true, template: view };
  }

  private async require(accountKey: string, templateKey: string, language: string): Promise<WhatsappTemplateView> {
    const row = (await sql<TemplateRow>`
      select * from voice_whatsapp_templates
      where account_key = ${accountKey} and template_key = ${templateKey} and language = ${language}
      limit 1
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Template "${templateKey}" (${language}) does not exist.`);
    return toView(row);
  }
}

/** `{{1}}`, `{{2}}`, … placeholders anywhere in the stored component JSON. */
function placeholders(components: unknown): string[] {
  const text = JSON.stringify(components ?? {});
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

function toView(row: TemplateRow): WhatsappTemplateView {
  return {
    id: row.id,
    accountKey: row.account_key,
    templateKey: row.template_key,
    name: row.name,
    category: row.category,
    language: row.language,
    components: row.components,
    status: row.status as WhatsappTemplateStatus,
    vendorStatus: row.vendor_status,
    rejectionReason: row.rejection_reason,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}
