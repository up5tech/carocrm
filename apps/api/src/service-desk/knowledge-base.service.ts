import { FeatureDisabledError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

const KB_ARTICLE = "KnowledgeArticle";

export interface KnowledgeArticleView {
  readonly id: string;
  readonly title: string;
  readonly slug: string | null;
  readonly summary: string | null;
  readonly status: string;
  readonly isInternal: boolean;
  readonly publishedAt: string | null;
  readonly expiresAt: string | null;
}

@Injectable()
export class KnowledgeBaseService {
  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  private async requireFeature(): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.knowledgeBase) throw new FeatureDisabledError("knowledgeBase");
  }

  async publish(articleId: string): Promise<KnowledgeArticleView> {
    await this.requireFeature();
    const now = new Date().toISOString();
    const updated = await this.entities.update(KB_ARTICLE, articleId, { status: "Published", publishedAt: now });
    return this.toView(updated);
  }

  async archive(articleId: string): Promise<KnowledgeArticleView> {
    await this.requireFeature();
    const updated = await this.entities.update(KB_ARTICLE, articleId, { status: "Archived" });
    return this.toView(updated);
  }

  /** Portal-safe list: only published, non-internal, in-date articles. */
  async portalArticles(): Promise<KnowledgeArticleView[]> {
    await this.requireFeature();
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", KB_ARTICLE)
      .where("deleted_at", "is", null)
      .execute();
    const now = new Date();
    const out: KnowledgeArticleView[] = [];
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      if (a["status"] !== "Published") continue;
      if (a["isInternal"] === true) continue;
      const expires = a["expiresAt"] ? new Date(String(a["expiresAt"])) : null;
      if (expires && expires.getTime() < now.getTime()) continue;
      const published = a["publishedAt"] ? new Date(String(a["publishedAt"])) : null;
      if (published && published.getTime() > now.getTime()) continue;
      out.push(this.toView(a, String(r.id)));
    }
    return out;
  }

  /** Suggest published portal-visible articles for a case based on subject keyword overlap. */
  async suggestForCase(caseId: string): Promise<KnowledgeArticleView[]> {
    await this.requireFeature();
    const caseRecord = await this.entities.get(CASE_ENTITY, caseId);
    const subject = String(caseRecord["name"] ?? "").toLowerCase();
    const words = subject.split(/\s+/).filter((w) => w.length >= 4);
    const articles = await this.portalArticles();
    if (words.length === 0) return articles.slice(0, 5);
    return articles.filter((a) => {
      const hay = `${a.title} ${a.summary ?? ""}`.toLowerCase();
      return words.some((w) => hay.includes(w));
    }).slice(0, 10);
  }

  /**
   * Scheduled lifecycle sweep (§5.8 "expiry behavior"): a published article whose expiry date has
   * passed becomes `Expired`, so portal search stops serving it and the change is audited like any
   * other editorial update. Idempotent: only `Published` rows are candidates.
   */
  async expireDueArticles(now = new Date()): Promise<number> {
    const settings = await this.settings.settings();
    if (!settings.features.knowledgeBase) return 0;
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", KB_ARTICLE)
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'status'`, "=", "Published")
      .where(sql`attrs ->> 'expiresAt'`, "is not", null)
      .limit(500)
      .execute();
    let expired = 0;
    for (const row of rows) {
      const a = (row.attrs ?? {}) as Record<string, unknown>;
      const expiresAt = new Date(String(a["expiresAt"]));
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > now.getTime()) continue;
      await this.entities.update(KB_ARTICLE, String(row.id), { status: "Expired" });
      expired += 1;
    }
    return expired;
  }

  private toView(record: Record<string, unknown>): KnowledgeArticleView;
  private toView(attrs: Record<string, unknown>, id?: string): KnowledgeArticleView;
  private toView(recordOrAttrs: Record<string, unknown>, id?: string): KnowledgeArticleView {
    const a = recordOrAttrs;
    return {
      id: id ?? String(a["id"] ?? ""),
      title: String(a["name"] ?? ""),
      slug: typeof a["slug"] === "string" ? (a["slug"] as string) : null,
      summary: typeof a["summary"] === "string" ? (a["summary"] as string) : null,
      status: typeof a["status"] === "string" ? (a["status"] as string) : "Draft",
      isInternal: a["isInternal"] === true,
      publishedAt: typeof a["publishedAt"] === "string" ? (a["publishedAt"] as string) : null,
      expiresAt: typeof a["expiresAt"] === "string" ? (a["expiresAt"] as string) : null,
    };
  }
}