import { AuthorizationDeniedError, InvalidQueryError } from "@carocrm/core/errors/index.js";
import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { ZodTypeAny } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import { SettingsPatchSchema } from "./dto/service-desk-shapes.js";
import { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.1 — Service Desk module commands (`/api/v1/ServiceDesk`, PLAN §8.2).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a Case is a metadata record, and the
 * Entity Engine already serves list/detail/create/edit/delete for it, with ACL, field validation,
 * audit, stream and search. These routes exist only for what a single record cannot express: module
 * diagnostics, the settings document and the numbering preview.
 *
 * This controller is registered before `ENTITY_CONTROLLERS`, so the static `ServiceDesk` prefix can
 * never be swallowed by the generic `:entity` wildcard (docs/module-guide.md).
 */
@ApiTags("service-desk")
@Controller("api/v1/ServiceDesk")
export class ServiceDeskController {
  constructor(
    @Inject(ServiceDeskModuleHealthService) private readonly health: ServiceDeskModuleHealthService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(CaseNumberingService) private readonly numbering: CaseNumberingService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get("action/health")
  async moduleHealth() {
    this.requireAdmin("module diagnostics");
    return this.health.health();
  }

  @Get("action/settings")
  async readSettings() {
    return this.settings.read();
  }

  @HttpCode(200)
  @Post("action/settings")
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin("changing Service Desk settings");
    parse(SettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** The next case number, without consuming it — configuration visibility, so admin-only. */
  @Get("action/caseNumberPreview")
  async caseNumberPreview() {
    this.requireAdmin("case number configuration");
    return this.numbering.preview();
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
