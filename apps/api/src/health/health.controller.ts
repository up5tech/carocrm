import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/auth.guard.js';
import { DatabaseService } from '../database/database.service.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Public()
  @Get('health/live')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('health/ready')
  async readiness(): Promise<{ status: string; database: string }> {
    const db = await this.database.healthy();
    return {
      status: db ? 'ok' : 'error',
      database: db ? 'up' : 'down',
    };
  }
}
