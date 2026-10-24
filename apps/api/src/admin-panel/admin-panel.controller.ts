import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { AdminPanelService } from './admin-panel.service.js';
import type { NavigationTree } from './navigation.service.js';
import { NavigationService } from './navigation.service.js';

const ExplainSchema = z.object({
  userId: z.string().min(1).max(64),
  entity: z.string().min(1).max(100),
  action: z.enum(['create', 'read', 'edit', 'delete', 'stream']),
});

/**
 * `GET /api/v1/AdminPanel` and `GET /api/v1/Navigation` (PLAN_Phase_20_Settings_UX.md §8.1), plus
 * `POST /api/v1/AdminPanel/action/acl-explain` for the Permissions tab's "who can see what" helper
 * (§4.8).
 *
 * The panel is the caller's own view of administration; the navigation tree is every user's menu,
 * resolved and ACL-filtered on the server, so the SPA renders what it is told instead of rebuilding
 * the rules from hard-coded name sets. The explanation is administration data about another account,
 * so it is administrator-only on the server as well as in the tab.
 */
@ApiTags('admin-panel')
@Controller('api/v1/AdminPanel')
export class AdminPanelController {
  constructor(
    @Inject(AdminPanelService) private readonly panel: AdminPanelService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  read(): ReturnType<AdminPanelService['forCaller']> {
    return this.panel.forCaller();
  }

  @HttpCode(200)
  @Post('action/acl-explain')
  explain(@Body() body: unknown) {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
    const parsed = ExplainSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('An explanation needs a user, an entity and an ACL action.', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    return this.acl.explainFor(parsed.data.userId, parsed.data.entity, parsed.data.action);
  }
}

@Controller('api/v1/Navigation')
export class NavigationController {
  constructor(@Inject(NavigationService) private readonly navigation: NavigationService) {}

  @Get()
  async read(): Promise<NavigationTree> {
    return this.navigation.resolve();
  }
}
