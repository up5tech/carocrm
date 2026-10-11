import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { nextRuns } from './cron.js';
import type { JobView, ScheduleView } from './job.views.js';
import { JobsService } from './jobs.service.js';

/**
 * Cron schedule administration (PLAN §24). A schedule is a `scheduled_jobs` row — metadata, never
 * executable code — that the worker's scheduler turns into queue jobs. Static `/api/v1/ScheduledJob`
 * prefix, registered before the generic record controller.
 */
@ApiTags('jobs')
@Controller('api/v1/ScheduledJob')
export class ScheduledJobController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Get()
  async list(): Promise<{ list: ScheduleView[] }> {
    this.requireAdmin();
    return this.jobs.listSchedules();
  }

  /** Upsert: the schedule id is chosen by the admin, like EspoCRM's named scheduled jobs. */
  @HttpCode(200)
  @Post()
  async upsert(@Body() body: unknown): Promise<ScheduleView> {
    this.requireAdmin();
    const request = asObject(body);
    const id = request['id'];
    const job = request['job'];
    const scheduling = request['scheduling'];
    if (typeof id !== 'string' || typeof job !== 'string' || typeof scheduling !== 'string') {
      throw new ValidationError('A schedule needs "id", "job" and "scheduling".', { id, job, scheduling });
    }
    const data = request['data'] === undefined ? {} : asObject(request['data']);
    return this.jobs.upsertSchedule({
      id,
      job,
      scheduling,
      data,
      ...(typeof request['enabled'] === 'boolean' ? { enabled: request['enabled'] } : {}),
    });
  }

  /** What the expression will actually do, before an admin saves it. */
  @HttpCode(200)
  @Post('action/preview')
  preview(@Body() body: unknown): { valid: boolean; next: string[] } {
    this.requireAdmin();
    const scheduling = asObject(body)['scheduling'];
    if (typeof scheduling !== 'string') throw new ValidationError('Request body must carry a "scheduling" string.');
    const next = nextRuns(scheduling, 3);
    return { valid: next.length > 0, next };
  }

  @HttpCode(200)
  @Post(':id/enable')
  async enable(@Param('id') id: string): Promise<ScheduleView> {
    this.requireAdmin();
    return this.jobs.setScheduleEnabled(id, true);
  }

  @HttpCode(200)
  @Post(':id/disable')
  async disable(@Param('id') id: string): Promise<ScheduleView> {
    this.requireAdmin();
    return this.jobs.setScheduleEnabled(id, false);
  }

  @HttpCode(200)
  @Post(':id/action/runNow')
  async runNow(@Param('id') id: string): Promise<JobView> {
    this.requireAdmin();
    return this.jobs.runScheduleNow(id);
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to manage schedules.');
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
