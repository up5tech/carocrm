export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** The request id that wrote the event, when there was one (22.21). */
  correlationId?: string | null;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobLogLevel = 'info' | 'warn' | 'error';

export interface JobContext {
  userId?: string;
  /** Present only when the scheduler enqueued this attempt from a cron boundary. */
  scheduleId?: string;
  scheduledForMs?: number;
  data?: Record<string, unknown>;
  /** Report 0..100 progress; the Admin UI reads it straight off the `jobs` row. */
  progress(percent: number, message?: string): void;
  /** Append a line to this execution's log. */
  log(message: string, level?: JobLogLevel): void;
  /**
   * Cooperative cancellation (PLAN §24). An admin cancel marks the row; a long-running job is
   * asked to stop between batches rather than being killed mid-statement.
   */
  shouldStop(): Promise<boolean>;
}

export interface JobRunResult {
  status: JobStatus;
  message?: string;
  result?: Record<string, unknown>;
}

export type JobHandler = (context: JobContext) => Promise<JobRunResult>;

export class JobRegistry {
  private handlers = new Map<string, JobHandler>();

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): JobHandler | undefined {
    return this.handlers.get(name);
  }

  list(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }
}

export interface JobQueuePort {
  enqueue(job: string, data?: Record<string, unknown>): Promise<string>;
  schedule(id: string, job: string, cron: string, data?: Record<string, unknown>): Promise<void>;
  unschedule(id: string): Promise<void>;
}

export const JOB_REGISTRY = Symbol('JOB_REGISTRY');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
