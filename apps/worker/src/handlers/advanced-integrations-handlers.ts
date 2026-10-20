import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';

import type { DomainEventBus, DomainEventMessage } from '../events/domain-event-bus.js';

/**
 * Phase 19-INT.12 / 19-INT.13 — the Advanced Integrations module's scheduled work, registered in
 * the worker composition root (`PLAN_Phase_19_Advanced_Integrations.md` §10, §11.6).
 *
 * Like `registerCustomerSuccessJobs`, a handler deliberately does **not** touch the module's tables
 * itself. Processing a provider callback, pushing an outbound operation and reacting to a CRM
 * change are domain operations: they read the settings, decide what the provider should hear
 * about, and move records through the engine's state machines — and the only place that happens
 * correctly is the application layer. So the worker calls the API's worker-authorised endpoints
 * with the shared capability (`x-worker-secret`).
 *
 * Every job is **idempotent** by construction:
 *
 *  - the webhook job carries the provider's delivery id, which is the deduplication key;
 *  - the outbound job carries the operation id, whose idempotency key is already recorded;
 *  - the domain-event subscriber carries the event id, and the outbound operation's idempotency
 *    key is derived from it, so a redelivered event queues the same push exactly once.
 */

export const ADVANCED_INTEGRATIONS_JOB_NAMES = {
  notifyExpiringCredentials: 'advancedIntegrations.notifyExpiringCredentials',
  processWebhookEvent: 'advancedIntegrations.processWebhookEvent',
  pushOutbound: 'advancedIntegrations.pushOutbound',
} as const;

/** The CRM entity events the outbound path reacts to. */
export const OUTBOUND_EVENT_TYPES = ['entity.created', 'entity.updated', 'entity.deleted'] as const;

export interface AdvancedIntegrationsJobDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the job is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a job test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

/**
 * The endpoint the job calls. It mirrors the route declared in
 * `apps/api/src/advanced-integrations/advanced-integrations.controller.ts`.
 */
const NOTIFY_EXPIRING_CREDENTIALS_PATH = '/api/v1/AdvancedIntegrations/action/notify-expiring-credentials';
const PROCESS_WEBHOOK_EVENT_PATH = '/api/v1/AdvancedIntegrations/action/process-webhook-event';
const PUSH_OUTBOUND_PATH = '/api/v1/AdvancedIntegrations/action/push-outbound';
const OUTBOUND_EVENT_PATH = '/api/v1/AdvancedIntegrations/action/outbound-event';

/** Internal signal: the run was cancelled before the API was called. Never escapes a handler. */
class CancelledBeforeCall extends Error {}

async function post(
  deps: AdvancedIntegrationsJobDeps,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
  const fetcher = deps.fetcher ?? fetch;
  const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'x-worker-secret': deps.secret, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload: body };
}

function notifyExpiringCredentialsJob(deps: AdvancedIntegrationsJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; the sweep did not run.' };
    }
    if (await context.shouldStop()) throw new CancelledBeforeCall();
    context.progress(20, 'Checking expiring credentials');
    const result = await post(deps, NOTIFY_EXPIRING_CREDENTIALS_PATH, {});
    if (!result.ok) {
      const detail = await Promise.resolve(JSON.stringify(result.payload)).catch(() => '');
      deps.log.warn({ status: result.status, detail }, 'expiring-credential sweep refused');
      return { status: 'failed', message: `The API refused the sweep (${String(result.status)}).` };
    }
    context.progress(100, 'Sweep complete');
    return {
      status: 'completed',
      message: `Notified ${String(result.payload['notified'] ?? 0)}, expired ${String(result.payload['expired'] ?? 0)}.`,
      result: {
        notified: result.payload['notified'] ?? 0,
        expired: result.payload['expired'] ?? 0,
        purgedStates: result.payload['purgedStates'] ?? 0,
      },
    };
  };
}

/**
 * Process one verified provider callback.
 *
 * The delivery id is the deduplication key, so a retried job does not apply the event twice.
 */
function processWebhookEventJob(deps: AdvancedIntegrationsJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; the event was not processed.' };
    }
    if (await context.shouldStop()) throw new CancelledBeforeCall();
    context.progress(40, 'Applying the provider event');
    const result = await post(deps, PROCESS_WEBHOOK_EVENT_PATH, context.data ?? {});
    if (!result.ok) {
      deps.log.warn({ status: result.status }, 'webhook processing refused');
      return { status: 'failed', message: `The API refused the event (${String(result.status)}).` };
    }
    context.progress(100, 'Event applied');
    return {
      status: 'completed',
      message: 'The provider event was applied.',
      result: result.payload,
    };
  };
}

/** Push one queued outbound operation to the provider. */
function pushOutboundJob(deps: AdvancedIntegrationsJobDeps): JobHandler {
  return async (context: JobContext) => {
    if (deps.secret.trim() === '') {
      return { status: 'completed', message: 'No worker capability is configured; the operation was not pushed.' };
    }
    if (await context.shouldStop()) throw new CancelledBeforeCall();
    context.progress(40, 'Pushing to the provider');
    const result = await post(deps, PUSH_OUTBOUND_PATH, context.data ?? {});
    if (!result.ok) {
      deps.log.warn({ status: result.status }, 'outbound push refused');
      return { status: 'failed', message: `The API refused the push (${String(result.status)}).` };
    }
    context.progress(100, 'Pushed');
    return { status: 'completed', message: 'The operation was pushed.', result: result.payload };
  };
}

export function registerAdvancedIntegrationsJobs(registry: JobRegistry, deps: AdvancedIntegrationsJobDeps): void {
  registry.register(
    ADVANCED_INTEGRATIONS_JOB_NAMES.notifyExpiringCredentials,
    notifyExpiringCredentialsJob(deps),
  );
  registry.register(ADVANCED_INTEGRATIONS_JOB_NAMES.processWebhookEvent, processWebhookEventJob(deps));
  registry.register(ADVANCED_INTEGRATIONS_JOB_NAMES.pushOutbound, pushOutboundJob(deps));
}

/**
 * Subscribe the outbound path to the CRM's domain events.
 *
 * The subscription is the **only** place a CRM change becomes an outbound operation. The echo
 * guard lives in the API: it decides whether the change is a genuine user edit or the echo of an
 * earlier sync, and skips the echo.
 */
export function registerAdvancedIntegrationsDomainEvents(
  bus: DomainEventBus,
  deps: AdvancedIntegrationsJobDeps,
): void {
  for (const eventType of OUTBOUND_EVENT_TYPES) {
    bus.subscribe({
      eventType,
      name: 'advanced-integrations:outbound-sync',
      handler: async (event: DomainEventMessage) => {
        if (deps.secret.trim() === '') return;
        const entity = event.entity;
        if (!entity) return;
        const result = await post(deps, OUTBOUND_EVENT_PATH, {
          eventId: event.id,
          eventType: event.eventType,
          entityType: entity.entityType,
          entityId: entity.entityId,
        });
        if (!result.ok) {
          deps.log.warn({ status: result.status, eventType: event.eventType }, 'outbound event refused');
        }
      },
    });
  }
}
