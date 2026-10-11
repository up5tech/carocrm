import { z } from 'zod';

/**
 * Wire format of a BullMQ job on the `crm-jobs` queue (PLAN §24).
 *
 * The contract is intentionally tiny: `{ job, data }`. `scheduleId` / `scheduledForMs` are
 * only set by the cron scheduler and let the runner record `scheduling_type = 'cron'` plus
 * deduplicate by deterministic BullMQ jobId.
 *
 * Declared as a type alias (not an interface) so it satisfies BullMQ's
 * `Record<string, any>` job-data constraint.
 */
export type JobPayload = {
  job: string;
  data: Record<string, unknown>;
  scheduleId?: string | undefined;
  scheduledForMs?: number | undefined;
  jobRowId?: string | undefined;
};

const JobPayloadSchema = z.object({
  job: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  scheduleId: z.string().min(1).optional(),
  scheduledForMs: z.number().int().nonnegative().optional(),
  jobRowId: z.string().min(1).max(64).optional(),
});

export function parseJobPayload(raw: unknown): JobPayload | undefined {
  const parsed = JobPayloadSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    job: parsed.data.job,
    data: parsed.data.data,
    ...(parsed.data.scheduleId !== undefined ? { scheduleId: parsed.data.scheduleId } : {}),
    ...(parsed.data.scheduledForMs !== undefined
      ? { scheduledForMs: parsed.data.scheduledForMs }
      : {}),
    ...(parsed.data.jobRowId !== undefined ? { jobRowId: parsed.data.jobRowId } : {}),
  };
}

export function buildJobPayload(input: {
  job: string;
  data?: Record<string, unknown> | undefined;
  scheduleId?: string | undefined;
  scheduledForMs?: number | undefined;
  jobRowId?: string | undefined;
}): JobPayload {
  return {
    job: input.job,
    data: input.data ?? {},
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    ...(input.scheduledForMs !== undefined ? { scheduledForMs: input.scheduledForMs } : {}),
    ...(input.jobRowId !== undefined ? { jobRowId: input.jobRowId } : {}),
  };
}

/**
 * Deterministic BullMQ jobId used by the scheduler for deduplication:
 * `<scheduleId>_<cronBoundaryMs>`.
 *
 * The spec's `${id}:${cronNextMs}` form is impossible on BullMQ — custom job ids may not
 * contain ":" ("Custom Id cannot contain :"), so the boundary is joined with "_". The suffix
 * is always plain milliseconds, so the mapping stays one-to-one.
 */
export function scheduledJobId(scheduleId: string, boundaryMs: number): string {
  return `${scheduleId}_${boundaryMs}`;
}
