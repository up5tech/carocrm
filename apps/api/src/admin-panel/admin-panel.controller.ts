import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AdminPanelService } from './admin-panel.service.js';
import type { NavigationTree } from './navigation.service.js';
import { NavigationService } from './navigation.service.js';

/**
 * `GET /api/v1/AdminPanel` and `GET /api/v1/Navigation` (PLAN_Phase_20_Settings_UX.md §8.1).
 *
 * The panel is the caller's own view of administration; the navigation tree is every user's menu,
 * resolved and ACL-filtered on the server, so the SPA renders what it is told instead of rebuilding
 * the rules from hard-coded name sets.
 */
@ApiTags('admin-panel')
@Controller('api/v1/AdminPanel')
export class AdminPanelController {
  constructor(@Inject(AdminPanelService) private readonly panel: AdminPanelService) {}

  @Get()
  read(): ReturnType<AdminPanelService['forCaller']> {
    return this.panel.forCaller();
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
