export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobContext {
  userId?: string;
  data?: Record<string, unknown>;
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
