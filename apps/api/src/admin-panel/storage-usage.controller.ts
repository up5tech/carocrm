import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { StorageUsageView } from './storage-usage.service.js';
import { StorageUsageService } from './storage-usage.service.js';

/**
 * `GET /api/v1/StorageUsage` — the figures behind the Attachments tab
 * (PLAN_Phase_20_Settings_UX.md §4.3 row 5). Administrator-only, enforced in the service.
 */
@ApiTags('admin-panel')
@Controller('api/v1/StorageUsage')
export class StorageUsageController {
  constructor(@Inject(StorageUsageService) private readonly storage: StorageUsageService) {}

  @Get()
  read(): Promise<StorageUsageView> {
    return this.storage.usage();
  }
}
