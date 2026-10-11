import { AuthorizationDeniedError, InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AuditListResult, AuditLogEntryDto } from './audit-read.service.js';
import { AuditReadService } from './audit-read.service.js';

const ListQuerySchema = z.object({
  entityId: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  action: z.enum(['create', 'update', 'delete']).optional(),
  usernameFrom: z.string().min(1).optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

@ApiTags('audit')
@Controller('api/v1/AuditLog')
export class AuditController {
  constructor(
    @Inject(AuditReadService) private readonly read: AuditReadService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Alpha access rule (simplified, per plan): administrators see the whole
   * log; non-administrators may only browse the history of one record and
   * must pass `entityId`. Cross-record browsing for non-admins is rejected.
   */
  @Get()
  async list(@Query() query: unknown): Promise<AuditListResult> {
    const parsed = ListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError('Invalid audit log query.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    if (!this.scope.isAdmin && parsed.data.entityId === undefined) {
      throw new AuthorizationDeniedError(
        'Audit log access requires administrator privileges; non-admin users must filter by entityId.',
      );
    }
    return this.read.list(parsed.data);
  }

  @Get(':id')
  async byId(@Param('id') id: string): Promise<AuditLogEntryDto> {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Audit log entry access requires administrator privileges.');
    }
    return this.read.getById(id);
  }
}
