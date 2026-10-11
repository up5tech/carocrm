import type { JobContext, JobLogLevel } from '@carocrm/jobs';

/**
 * A complete `JobContext` for handler tests: `job-runner` always builds one with real
 * progress/log/cancel sinks, so unit tests of a handler need the same shape.
 */
export function jobContext(
  data: Record<string, unknown> = {},
  options: { userId?: string; cancelRequested?: boolean } = {},
): JobContext & { readonly progressLines: number[]; readonly logLines: [string, JobLogLevel][] } {
  const progressLines: number[] = [];
  const logLines: [string, JobLogLevel][] = [];
  const context: JobContext & { readonly progressLines: number[]; readonly logLines: [string, JobLogLevel][] } = {
    data,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    progressLines,
    logLines,
    progress(percent: number): void {
      progressLines.push(percent);
    },
    log(message: string, level: JobLogLevel = 'info'): void {
      logLines.push([message, level]);
    },
    async shouldStop(): Promise<boolean> {
      return options.cancelRequested === true;
    },
  };
  return context;
}
