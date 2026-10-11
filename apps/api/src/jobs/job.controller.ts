import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { JobView } from './job.views.js';
import { JobsService } from './jobs.service.js';

const JOB_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Background jobs API (PLAN §24). Static `/api/v1/Job` prefix, so it must be registered before the
 * generic record controller. Job execution is an administrative capability: submitting, cancelling
 * and reading job state all require an admin principal.
 */
@ApiTags('jobs')
@Controller('api/v1/Job')
export class JobController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @HttpCode(201)
  @Post()
  async create(@Body() body: unknown): Promise<JobView> {
    this.requireAdmin();
    const request = asObject(body);
    const job = request['jobName'] ?? request['job'];
    if (typeof job !== 'string') throw new ValidationError('Request body must carry a "jobName" string.', { job });
    const data = request['data'] === undefined ? {} : asObject(request['data']);
    const id = typeof request['id'] === 'string' ? request['id'] : undefined;
    return this.jobs.enqueue({ job, data, ...(id === undefined ? {} : { id }) });
  }

  @Get()
  async list(@Query() raw: Record<string, string | string[] | undefined>): Promise<{
    list: JobView[];
    total: number;
    offset: number;
    count: number;
    queue: Record<string, number>;
  }> {
    this.requireAdmin();
    const query = normalizeList(raw);
    const result = await this.jobs.list(query);
    return { ...result, queue: await this.jobs.queueCounts() };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<JobView> {
    this.requireAdmin();
    return this.jobs.get(id);
  }

  @Get(':id/log')
  async log(@Param('id') id: string): Promise<{ jobId: string; lines: { seq: string; level: string; message: string; createdAt: string }[] }> {
    this.requireAdmin();
    return this.jobs.logs(id);
  }

  @HttpCode(200)
  @Post(':id/action/cancel')
  async cancel(@Param('id') id: string): Promise<JobView> {
    this.requireAdmin();
    return this.jobs.cancel(id);
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) throw new AuthorizationDeniedError('Administrator access is required to manage jobs.');
  }
}

function normalizeList(raw: Record<string, string | string[] | undefined>): {
  status: string | undefined;
  job: string | undefined;
  offset: number;
  limit: number;
} {
  const status = single(raw['status']);
  if (status !== undefined && !JOB_STATUSES.has(status)) {
    throw new ValidationError(`Unknown job status "${status}".`, { status });
  }
  const job = single(raw['job']);
  const offset = toNumber(single(raw['offset']), 0, 0, 100_000);
  const limit = toNumber(single(raw['limit']), 25, 1, 100);
  return { status, job, offset, limit };
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}
