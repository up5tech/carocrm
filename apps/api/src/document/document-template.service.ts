import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import {
  renderTemplate,
  type TemplateData,
  type TemplateRenderResult,
} from "@carocrm/document";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import {
  type CreateDocumentTemplateInput,
  CreateDocumentTemplateSchema,
  UpdateDocumentTemplateSchema,
} from "./dto/document-shapes.js";

/** A rendered document: the pure renderer's result, plus which template and format produced it. */
export interface DocumentRenderResult extends TemplateRenderResult {
  readonly format: string;
  readonly templateCode: string;
}

/**
 * The `document` module — the kernel-owned way a record becomes a document.
 *
 * Before this module, every module that wanted to print something invented its own template syntax and
 * its own renderer. That is how the same invoice ends up looking different in three places, and how a
 * placeholder nobody can answer quietly turns into a blank. This module owns both halves:
 *
 *  - `DocumentTemplate` is a record like any other, so ACL, audit, stream and import/export all work;
 *  - rendering is `@carocrm/document`, a pure package, so the API process and the worker share it and a
 *    result can be asserted on without producing a binary.
 *
 * The rule that makes this safe for commercial documents: **render from a frozen snapshot, never from
 * the live catalog.** A quote rendered a month after it was sent must show the prices that were sent,
 * so the caller hands in a view that came from a snapshot, and this service only fills placeholders.
 */
@Injectable()
export class DocumentTemplateService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
  ) {}

  /** Templates visible to the caller, newest first. */
  async list(entityType?: string): Promise<readonly Record<string, unknown>[]> {
    await this.acl.assertAccess("DocumentTemplate", "read");
    const templates = await this.entities.list("DocumentTemplate", {
      where:
        entityType === undefined
          ? undefined
          : [{ field: "entityType", operator: "equals", value: entityType }],
    });
    return templates.list;
  }

  async create(
    input: CreateDocumentTemplateInput,
  ): Promise<Record<string, unknown>> {
    await this.acl.assertAccess("DocumentTemplate", "create");
    const parsed = CreateDocumentTemplateSchema.parse(input);
    await this.assertCodeAvailable(parsed.code);
    if (parsed.isDefault) await this.clearDefault(parsed.entityType);
    return await this.entities.create("DocumentTemplate", {
      name: parsed.name,
      code: parsed.code,
      entityType: parsed.entityType,
      subject: parsed.subject ?? null,
      body: parsed.body,
      format: parsed.format,
      locale: parsed.locale ?? null,
      active: parsed.active,
      isDefault: parsed.isDefault,
    });
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.acl.assertAccess("DocumentTemplate", "edit");
    const parsed = UpdateDocumentTemplateSchema.parse(patch);
    await this.requireTemplate(id);
    if (parsed.isDefault === true)
      await this.clearDefault(await this.entityTypeOf(id));
    return await this.entities.update(
      "DocumentTemplate",
      id,
      parsed as Record<string, unknown>,
    );
  }

  /**
   * Render a named template against caller-supplied data.
   *
   * Used for an admin preview of a template, and by the module that owns the document for a real
   * document render — the caller supplies the data, so this service never reaches into a catalog to
   * fill a placeholder. Unresolved placeholders are reported, never blanked.
   */
  async render(
    templateCode: string,
    data: TemplateData,
  ): Promise<DocumentRenderResult> {
    await this.acl.assertAccess("DocumentTemplate", "read");
    const template = await this.requireByCode(templateCode);
    const fields: Record<string, unknown> =
      typeof template.data === "object" && template.data !== null
        ? (template.data as Record<string, unknown>)
        : {};
    if (fields["active"] === false) {
      throw new ValidationError(`Template "${templateCode}" is inactive.`, {
        templateCode,
      });
    }
    const format = text(fields["format"]) ?? "html";
    // Escaping is the template's own choice (`{{}}` escapes, `{{{}}}` does not), so `format` is carried
    // back for the consumer — a `text` body is sent as text, an `html` body with an HTML mail.
    return {
      format,
      templateCode,
      ...renderTemplate(text(fields["body"]) ?? "", data, {
        subject: text(fields["subject"]) ?? undefined,
      }),
    };
  }

  /** The template to use when a caller does not name one. */
  async defaultTemplateCode(entityType: string): Promise<string | undefined> {
    await this.acl.assertAccess("DocumentTemplate", "read");
    const templates = await this.entities.list("DocumentTemplate", {
      where: [
        { field: "entityType", operator: "equals", value: entityType },
        { field: "active", operator: "equals", value: true },
      ],
    });
    const chosen =
      templates.list.find((template) => template["isDefault"] === true) ??
      templates.list[0];
    return chosen?.["code"] as string | undefined;
  }

  private async requireTemplate(id: string) {
    const template = await this.entities.get("DocumentTemplate", id);
    if (template === undefined)
      throw new NotFoundError(`Document template "${id}" does not exist.`);
    return template;
  }

  private async requireByCode(code: string) {
    const templates = await this.entities.list("DocumentTemplate", {
      where: [{ field: "code", operator: "equals", value: code }],
    });
    const template = templates.list[0];
    if (template === undefined)
      throw new NotFoundError(`Document template "${code}" does not exist.`);
    return template;
  }

  private async entityTypeOf(id: string): Promise<string> {
    return text((await this.requireTemplate(id))["entityType"]) ?? "Document";
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const templates = await this.entities.list("DocumentTemplate", {
      where: [{ field: "code", operator: "equals", value: code }],
    });
    if (templates.list.length > 0) {
      throw new ValidationError(
        `A template with the code "${code}" already exists.`,
        { code },
      );
    }
  }

  /** One default per entity type: clearing the previous one keeps "the default" unambiguous. */
  private async clearDefault(entityType: string): Promise<void> {
    const templates = await this.entities.list("DocumentTemplate", {
      where: [
        { field: "entityType", operator: "equals", value: entityType },
        { field: "isDefault", operator: "equals", value: true },
      ],
    });
    for (const template of templates.list) {
      await this.entities.update("DocumentTemplate", String(template["id"]), {
        isDefault: false,
      });
    }
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
