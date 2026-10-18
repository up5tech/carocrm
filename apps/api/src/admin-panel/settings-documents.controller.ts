import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { SettingsDocumentService } from './settings-document.service.js';

/**
 * Settings document API (PLAN_Phase_20_Settings_UX.md §8.1).
 *
 * `GET /Settings` stays the public brand/locale read and `POST /Settings` stays the legacy flat
 * write; both share validation with these routes because the legacy controller delegates to the same
 * registry. These endpoints are what the tabbed shell uses: catalog, per-document read with version
 * and warnings, versioned write, reset to the registered defaults.
 */
@ApiTags('settings')
@Controller('api/v1/Settings/documents')
export class SettingsDocumentsController {
  constructor(@Inject(SettingsDocumentService) private readonly documents: SettingsDocumentService) {}

  @Get()
  list(): { documents: ReturnType<SettingsDocumentService['catalog']> } {
    return { documents: this.documents.catalog() };
  }

  @Get(':name')
  async read(@Param('name') name: string): Promise<unknown> {
    return this.documents.read(name);
  }

  /**
   * The body is an envelope, not the bare document: `version` is what the caller read and must match,
   * and `value` is the patch it wants applied. Keeping them in separate keys means a document that
   * legitimately carries a field called `version` cannot be mistaken for the token.
   */
  @HttpCode(200)
  @Post(':name')
  async write(@Param('name') name: string, @Body() body: unknown): Promise<unknown> {
    const parsed = WriteBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid settings payload.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    return this.documents.write(name, parsed.data.value, parsed.data.version);
  }

  @HttpCode(200)
  @Post(':name/reset')
  async reset(@Param('name') name: string): Promise<unknown> {
    return this.documents.reset(name);
  }
}

const WriteBodySchema = z
  .object({
    value: z.record(z.string(), z.unknown()),
    version: z.number().int().min(0).optional(),
  })
  .strict();
