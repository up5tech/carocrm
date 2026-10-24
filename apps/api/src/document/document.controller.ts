import {
  AuthorizationDeniedError,
  InvalidQueryError,
} from "@carocrm/core/errors/index.js";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { ZodTypeAny } from "zod";

import {
  REQUEST_SCOPE_TOKEN,
  type RequestScope,
} from "../common/request-scope.js";
import { DocumentTemplateService } from "./document-template.service.js";
import {
  CreateDocumentTemplateSchema,
  PreviewDocumentSchema,
  UpdateDocumentTemplateSchema,
} from "./dto/document-shapes.js";

/**
 * The `document` module's commands (`/api/v1/DocumentTemplate`, `/api/v1/Document`).
 *
 * Templates are records, so their CRUD follows the generic `/api/v1/:entity` API as well — these routes
 * exist only for the two things a record cannot express: listing the templates an entity type may use
 * (with the default chosen), and a render **preview** that runs the pure renderer against data the
 * caller supplies.
 *
 * The route order matters: `action/*` is registered before the generic `:entity` controller in
 * `AppModule`, so `action` can never be read as a template id.
 */
@ApiTags("document")
@Controller("api/v1")
export class DocumentController {
  constructor(
    @Inject(DocumentTemplateService)
    private readonly templates: DocumentTemplateService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** `GET /api/v1/DocumentTemplate?entityType=Quote` — the templates an entity type may use. */
  @Get("DocumentTemplate")
  async list(@Query("entityType") entityType?: string) {
    return { list: await this.templates.list(entityType) };
  }

  @HttpCode(201)
  @Post("DocumentTemplate")
  async create(@Body() body: unknown) {
    const input = parse(CreateDocumentTemplateSchema, body);
    return this.templates.create(input);
  }

  @HttpCode(200)
  @Patch("DocumentTemplate/:id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(UpdateDocumentTemplateSchema, body);
    return this.templates.update(id, input as Record<string, unknown>);
  }

  /** Which template a command should pick when the caller does not name one. */
  @Get("document/defaultTemplate")
  async defaultTemplate(@Query("entityType") entityType: string) {
    return { code: await this.templates.defaultTemplateCode(entityType) };
  }

  /** Render a preview: a stored template, or the draft body the designer is editing. */
  @HttpCode(200)
  @Post("document/action/preview")
  async preview(@Body() body: unknown) {
    this.requireAdmin("rendering a document preview");
    const input = parse(PreviewDocumentSchema, body);
    if ("templateCode" in input) {
      return this.templates.render(input.templateCode, input.data);
    }
    return this.templates.renderDraft({
      body: input.body,
      subject: input.subject,
      format: input.format,
      data: input.data,
    });
  }

  /** Rendering arbitrary data produces HTML, so it is an administrative act (§13). */
  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(
        `Administrator access is required for ${action}.`,
      );
    }
  }
}

/** One validation path for every route: a rejected body is a 400 with the reasons, never a 500. */
function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
