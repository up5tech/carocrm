import type { Logger } from '@carocrm/core/logger/index.js';

import { SUBSCRIBE_ALL, type DomainEventBus, type DomainEventMessage } from '../events/domain-event-bus.js';

/**
 * Phase 19-AI.17 — the domain-event door for agent triggers (P1)
 * (`plans/PLAN_Phase_19_AI_Agents.md` §13.1, §13.8).
 *
 * A committed `entity.*` event may start a run for each agent that opted in with `triggers.event`
 * plus matching `eventTypes`/`eventEntities` allowlists — that decision belongs to the API, which
 * owns the run engine and the agent definitions. This subscriber only ferries committed events to
 * the API's worker-authorised door; it decides nothing.
 *
 * Two deliberate properties:
 *
 * - **Inert without a capability.** An installation that has not configured the worker capability
 *   never starts an agent from an event; it logs and moves on rather than dead-lettering the
 *   outbox.
 * - **Agents do not trigger agents.** Every event produced inside a run carries
 *   `correlation_id = 'aiAgentRun:<id>'`; those events are skipped here so an agent's own output
 *   can never start another run, or itself again.
 */

export const AI_AGENT_TRIGGER_SUBSCRIBER = 'ai-agents-event-trigger';
export const AI_AGENT_TRIGGER_PATH = '/api/v1/AIAgents/action/worker/trigger-event';

const AGENT_RUN_CORRELATION = 'aiAgentRun:';

/** Events the agent runtime can act on. Everything else is logged and marked processed. */
const TRIGGERABLE_EVENTS: ReadonlySet<string> = new Set([
  'entity.created',
  'entity.updated',
  'entity.deleted',
  'entity.restored',
]);

export interface AIAgentTriggerDeps {
  readonly apiBaseUrl: string;
  /** The shared worker→API capability. Empty means the door is inert, not broken. */
  readonly secret: string;
  readonly log: Logger;
  /** Injectable for tests, so a subscriber test never opens a socket. */
  readonly fetcher?: typeof fetch;
}

export function registerAIAgentDomainEvents(bus: DomainEventBus, deps: AIAgentTriggerDeps): void {
  bus.subscribe({
    name: AI_AGENT_TRIGGER_SUBSCRIBER,
    eventType: SUBSCRIBE_ALL,
    handler: async (event: DomainEventMessage) => {
      const correlation = event.correlationId ?? '';
      // An agent's own output must never re-enter the trigger door.
      if (correlation.startsWith(AGENT_RUN_CORRELATION)) return;
      if (!TRIGGERABLE_EVENTS.has(event.eventType)) return;
      const entity = event.entity;
      if (entity === undefined) return;
      if (deps.secret.trim() === '') {
        deps.log.warn({ eventId: event.id, eventType: event.eventType }, 'agent event trigger inert: no worker capability configured');
        return;
      }
      const fetcher = deps.fetcher ?? fetch;
      const response = await fetcher(
        `${deps.apiBaseUrl.replace(/\/$/, '')}${AI_AGENT_TRIGGER_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-worker-secret': deps.secret },
          body: JSON.stringify({
            eventId: event.id,
            eventType: event.eventType,
            entityType: entity.entityType,
            entityId: entity.entityId,
            correlationId: correlation === '' ? null : correlation,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new Error(`AI agent trigger door answered HTTP ${String(response.status)}.`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body['disabled'] === true) {
        // The deployment has event triggers switched off; nothing to do and nothing to retry.
        return;
      }
      deps.log.info(
        { eventId: event.id, eventType: event.eventType, entityType: entity.entityType, started: body['started'] ?? 0 },
        'agent event trigger applied',
      );
    },
  });
}
