import type { Provider, Type } from '@nestjs/common';

import { JobController } from './job.controller.js';
import { JobQueueService } from './job-queue.service.js';
import { JobsService } from './jobs.service.js';
import { ScheduledJobController } from './scheduled-job.controller.js';

export { isValidCronExpression, nextRuns } from './cron.js';
export type { JobView, ScheduleView } from './job.views.js';
export { JOB_QUEUE_NAME,JobQueueService } from './job-queue.service.js';
export { JobsService } from './jobs.service.js';

/**
 * Jobs barrel (PLAN §24). `JOB_CONTROLLERS` owns the static `/api/v1/Job` and
 * `/api/v1/ScheduledJob` prefixes and must be spread before `ENTITY_CONTROLLERS`.
 */
export const JOB_CONTROLLERS: Type<unknown>[] = [JobController, ScheduledJobController];
export const JOB_PROVIDERS: Provider[] = [JobQueueService, JobsService];
