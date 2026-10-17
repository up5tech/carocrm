import type { Logger } from "@carocrm/core/logger/index.js";
import type { JobContext, JobHandler, JobRegistry } from "@carocrm/jobs";

/**
 * Phase 19-SD.9 — Service Desk scheduled SLA scanning (PLAN_Phase_19_ServiceDesk.md §5.7, §12.1).
 *
 * The scan itself runs in the API: it loads clocks and policies, writes warning/breach state,
 * escalates cases and writes notifications, which only the application layer may do correctly.
 * The worker only drives the schedule, calling the worker-authorised endpoint with the shared
 * capability (`x-worker-secret`) exactly as the Sales and Customer Success jobs do.
 *
 * Idempotency is what makes a retry safe: a clock records the thresholds it already fired and a
 * breach its notification state, so a repeated run creates no duplicate notification and does not
 * overwrite an earlier breach. A run is inert when the SLA feature is off.
 */

export const SLA_SCAN_JOB = "serviceDesk.slaScan";
export const SLA_SCAN_PATH = "/api/v1/ServiceDesk/action/sla/run-scheduled-check";

export interface ServiceDeskJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

export function slaScanJob(deps: ServiceDeskJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === "") {
      return {
        status: "completed",
        message: "Service Desk SLA scan is disabled: no worker capability is configured.",
        result: { disabled: true },
      };
    }
    if (await context.shouldStop()) return { status: "cancelled", message: "Cancelled before the SLA scan." };

    context.progress(20, "scanning SLA clocks");
    const fetcher = deps.fetcher ?? fetch;
    const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, "")}${SLA_SCAN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": deps.secret },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Service Desk SLA scan failed with HTTP ${String(response.status)}.`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const checked = typeof payload["checked"] === "number" ? payload["checked"] : 0;
    const breached = typeof payload["breached"] === "number" ? payload["breached"] : 0;
    const warned = typeof payload["warned"] === "number" ? payload["warned"] : 0;
    const notified = typeof payload["notified"] === "number" ? payload["notified"] : 0;
    const escalated = typeof payload["escalated"] === "number" ? payload["escalated"] : 0;
    const expiredArticles = typeof payload["expiredArticles"] === "number" ? payload["expiredArticles"] : 0;

    context.progress(100, `${String(checked)} clock(s) checked`);
    deps.log.info({ job: SLA_SCAN_JOB, checked, breached, warned, notified, escalated, expiredArticles }, "service desk SLA scan finished");
    return {
      status: "completed",
      message: `Checked ${String(checked)} SLA clock(s); ${String(breached)} breached, ${String(warned)} warned`,
      result: { checked, breached, warned, notified, escalated, expiredArticles },
    };
  };
}

export function registerServiceDeskJobs(registry: JobRegistry, deps: ServiceDeskJobDeps): void {
  registry.register(SLA_SCAN_JOB, slaScanJob(deps));
}
