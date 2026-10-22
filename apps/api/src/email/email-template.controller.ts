/**
 * Email template API.
 *
 * `EmailTemplate` records are CRUDed by the generic entity endpoints; this controller owns only the
 * one thing that is not record content — rendering a draft for the designer — and it is declared on
 * its own static prefix so it can never collide with `:entity` or with `Email`.
 */
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { type EmailTemplatePreview,EmailTemplatePreviewService } from './email-template-preview.service.js';

@ApiTags('email-templates')
@Controller('api/v1/EmailTemplate')
export class EmailTemplateController {
  constructor(@Inject(EmailTemplatePreviewService) private readonly previews: EmailTemplatePreviewService) {}

  /**
   * Render a draft template, personalised against one sample record the caller may read. Nothing is
   * stored and nothing is sent: the response is what the preview pane shows.
   */
  @HttpCode(200)
  @Post('action/preview')
  preview(@Body() body: unknown): Promise<EmailTemplatePreview> {
    return this.previews.preview(body);
  }
}
