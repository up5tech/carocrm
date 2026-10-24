import { AuthorizationDeniedError } from '@carocrm/core/errors/index.js';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { SetupChecklistService } from './setup-checklist.service.js';

/**
 * The first-run checklist (PLAN_Phase_20_Settings_UX.md §4.10). Administration guidance, so it is
 * administrator-only on the server as well as hidden in the SPA — hiding a panel is not authorization
 * (AGENTS.MD §5.3).
 */
@ApiTags('setup-checklist')
@Controller('api/v1/SetupChecklist')
export class SetupChecklistController {
  constructor(
    @Inject(SetupChecklistService) private readonly checklist: SetupChecklistService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  items() {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
    return this.checklist.getItems();
  }
}
