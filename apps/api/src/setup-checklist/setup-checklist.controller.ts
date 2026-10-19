import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { SetupChecklistService } from './setup-checklist.service.js';

@ApiTags('setup-checklist')
@Controller('api/v1/SetupChecklist')
export class SetupChecklistController {
  constructor(@Inject(SetupChecklistService) private readonly checklist: SetupChecklistService) {}

  @Get()
  items() {
    return this.checklist.getItems();
  }
}
