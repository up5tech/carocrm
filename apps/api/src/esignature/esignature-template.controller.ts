import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ZodTypeAny } from 'zod';

import {
  TemplateCatalogRefreshSchema,
  TemplateMappingActiveSchema,
  TemplateMappingCreateSchema,
  TemplateMappingUpdateSchema,
} from './dto/esignature-shapes.js';
import { ESignatureTemplateService } from './esignature-template.service.js';

/**
 * Phase 19-ES.7 — the template catalog and mapping API
 * (`PLAN_Phase_19_ESignature.md` §6.7, §8.2, §18 `19-ES.7`).
 *
 * Two literal prefixes, `catalog/` and `mappings/`, rather than one `:connectionId` segment: a mapping
 * list and a template detail would otherwise be the same shape to the router, and mixing them up is how
 * a template from one account ends up configured against another (the acceptance criterion this phase
 * exists to hold).
 *
 * There is no route that writes a provider template, and none that creates a mapping without validating
 * it against that connection's live template first.
 */
@ApiTags('esignature')
@Controller('api/v1/ESignature/templates')
export class ESignatureTemplateController {
  constructor(@Inject(ESignatureTemplateService) private readonly templates: ESignatureTemplateService) {}

  /** Refresh one account's catalog, and see how the stored mappings line up with it. */
  @HttpCode(200)
  @Post('catalog/refresh')
  async refreshCatalog(@Body() body: unknown) {
    const { connectionId } = this.parse(TemplateCatalogRefreshSchema, body);
    return this.templates.refresh(connectionId);
  }

  /** One template's roles and tabs, from the account that owns the connection. */
  @Get('catalog/:connectionId/:templateId')
  async templateDetail(@Param('connectionId') connectionId: string, @Param('templateId') templateId: string) {
    return this.templates.detail(this.id(connectionId, 'connectionId'), this.id(templateId, 'templateId'));
  }

  @Get('mappings')
  async listMappings(@Query('connectionId') connectionId: string | undefined) {
    return this.templates.list(connectionId);
  }

  @HttpCode(201)
  @Post('mappings')
  async createMapping(@Body() body: unknown) {
    const parsed = this.parse(TemplateMappingCreateSchema, body);
    return this.templates.create({
      ...parsed,
      // The DTO allows an omitted `crmField`; the mapping shape spells "not applicable" as null.
      roleMappings: parsed.roleMappings.map((role) => ({ ...role, crmField: role.crmField ?? null })),
    });
  }

  @Get('mappings/:id')
  async getMapping(@Param('id') id: string) {
    return this.templates.get(this.id(id, 'id'));
  }

  /** Edit a mapping; the template it names is re-validated when it changes. */
  @HttpCode(200)
  @Patch('mappings/:id')
  async updateMapping(@Param('id') id: string, @Body() body: unknown) {
    const { version, roleMappings, ...patch } = this.parse(TemplateMappingUpdateSchema, body);
    return this.templates.update(this.id(id, 'id'), {
      version,
      patch: {
        ...patch,
        ...(roleMappings === undefined ? {} : { roleMappings: roleMappings.map((role) => ({ ...role, crmField: role.crmField ?? null })) }),
      },
    });
  }

  /** Switch a mapping on or off. Deactivation is how one is retired; nothing deletes it. */
  @HttpCode(200)
  @Post('mappings/:id/active')
  async setActive(@Param('id') id: string, @Body() body: unknown) {
    const { active } = this.parse(TemplateMappingActiveSchema, body);
    return this.templates.setActive(this.id(id, 'id'), active);
  }

  private parse<T extends ZodTypeAny>(schema: T, value: unknown): T['_output'] {
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return parsed.data;
  }

  private id(value: string, field: string): string {
    const id = value.trim();
    if (id === '' || id.length > 128) {
      throw new InvalidQueryError('Invalid ESignature request.', {
        issues: [{ path: field, message: 'An identifier is at most 128 characters.' }],
      });
    }
    return id;
  }
}
