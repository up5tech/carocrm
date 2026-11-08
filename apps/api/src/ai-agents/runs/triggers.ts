/**
 * Trigger doors — event, schedule and integration entry points (19-AI.25).
 */

import { FeatureDisabledError, NotFoundError, RateLimitError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';

import { isValidCronExpression } from '../../jobs/cron.js';
import { parseAgentConfig } from '../ai-agent-config.js';
import { aiAgentScheduleId } from '../ai-agents-module.js';
import { AIAgentRunLifecycle } from './lifecycle.js';
import { type AIAgentRunView,type RunCreateInput } from './shared.js';

export abstract class AIAgentRunTriggers extends AIAgentRunLifecycle {
  /**
   * Phase 19-AI.11 — a safe retry of a run whose fate is fully known.
   *
   * Retrying is a **new** run: the original ledger stays intact and the new row points back to it
   * through `causation_id`. Anything whose side effect may already have happened (`outcome_unknown`
   * or `partially_succeeded`) is refused until an operator reconciles it, and a run that is still
   * active is not retried — it is resumed or canceled. The client supplies an idempotency key so a
   * double-click cannot enqueue two copies.
   */
  /**
   * Phase 19-AI.17 — start a run from an approved event or schedule.
   *
   * Reuses `create()` so quota, idempotency, conversation memory and the run engine behave exactly
   * like a manual run. Adds the trigger type, feature-flag gating, the agent's own trigger allowlist,
   * a causation id and a bounded recursion depth so an agent-created change cannot loop forever.
   */
  async triggerRun(input: {
    readonly agentId: string;
    readonly trigger: 'event' | 'schedule' | 'integration' | 'record';
    readonly runInput?: RunCreateInput['input'];
    readonly idempotencyKey?: string;
    readonly causationId?: string;
    readonly depth?: number;
  }): Promise<AIAgentRunView> {
    await this.policy.assertCanStartRun();
    const settings = await this.settings.settings();
    const featureKey =
      input.trigger === 'event' || input.trigger === 'integration' ? 'eventTriggers' : input.trigger === 'schedule' ? 'scheduledTriggers' : 'execution';
    if (featureKey === 'eventTriggers' && !settings.features.eventTriggers) {
      throw new FeatureDisabledError('AI agent event triggers');
    }
    if (featureKey === 'scheduledTriggers' && !settings.features.scheduledTriggers) {
      throw new FeatureDisabledError('AI agent scheduled triggers');
    }
    const depth = input.depth ?? 0;
    if (depth > 3) {
      throw new ValidationError('Trigger recursion depth exceeded.', { depth });
    }
    // de-dup
    if (input.idempotencyKey !== undefined) {
      const existing = await this.database.db
        .selectFrom('ai_agent_runs')
        .selectAll()
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        const { agents } = await this.agentNames([existing.agent_id]);
        return this.toView(existing, agents.get(existing.agent_id));
      }
    }
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', input.agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!agent) throw new NotFoundError(`Agent "${input.agentId}" does not exist.`);
    const parsed = parseAgentConfig(agent.draft_config);
    if (!parsed.ok) throw new ValidationError('The agent configuration is not valid.');
    if (parsed.config.triggers === undefined) throw new ValidationError('The agent declares no triggers.');
    const allowed =
      (input.trigger === 'event' && parsed.config.triggers.event) ||
      (input.trigger === 'schedule' && parsed.config.triggers.schedule) ||
      (input.trigger === 'record' && parsed.config.triggers.record) ||
      (input.trigger === 'integration' && parsed.config.triggers.integration);
    if (!allowed) throw new ValidationError('This trigger is not enabled on the agent.');
    const view = await this.createInternal(input.agentId, {
      input: input.runInput,
      idempotencyKey: input.idempotencyKey,
      trigger: input.trigger,
    }, true);
    // stamp causation for loop detection
    if (input.causationId !== undefined) {
      await this.database.db
        .updateTable('ai_agent_runs')
        .set({ causation_id: input.causationId, modified_at: new Date() })
        .where('id', '=', view.id)
        .execute();
    }
    return view;
  }

  /**
   * The worker's door for committed domain events (P1, 19-AI.17; `plans/PLAN_Phase_19_AI_Agents.md` §13.1, §13.8).
   *
   * An event-triggered run executes as the **publishing user**, never wider: the agent can only do
   * what its owner could do by clicking Run themselves, the quota it spends is theirs, and the audit
   * trail names them. There is no service principal with ambient authority — one was designed into
   * the schema (`ai_agent_runs.service_principal`, always NULL) and deliberately never used.
   *
   * Recursion is stopped at the source: every event produced inside a run carries
   * `correlation_id = 'aiAgentRun:<id>'`, and the worker subscriber never hands those back to this
   * door. Depth stays 0 here, so the `depth > 3` ceiling in `triggerRun` never comes into play.
   */
  async triggerEvent(input: {
    readonly eventId: string;
    readonly eventType: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.restored';
    readonly entityType: string;
    readonly entityId: string;
  }): Promise<{
    readonly disabled?: true;
    readonly matched: number;
    readonly started: number;
    readonly skipped: readonly { readonly agent: string; readonly reason: string }[];
    readonly errors: readonly { readonly agent: string; readonly category: string }[];
  }> {
    const settings = await this.settings.settings();
    if (!settings.features.eventTriggers) {
      // A disabled feature is a quiet no-op, not a retry storm for the outbox poller.
      return { disabled: true, matched: 0, started: 0, skipped: [], errors: [] };
    }
    const db = this.database.db;
    const published = await db
      .selectFrom('ai_agents')
      .selectAll()
      .where('status', '=', 'published')
      .where('is_deleted', '=', false)
      .orderBy('id', 'asc')
      .limit(20)
      .execute();

    const candidates: { readonly agent: (typeof published)[number] }[] = [];
    for (const agent of published) {
      if (agent.current_version === null) continue;
      const version = await db
        .selectFrom('ai_agent_versions')
        .selectAll()
        .where('agent_id', '=', agent.id)
        .where('version', '=', agent.current_version)
        .executeTakeFirst();
      if (!version) continue;
      const parsed = parseAgentConfig(version.config);
      if (!parsed.ok) continue;
      const triggers = parsed.config.triggers;
      if (!triggers.event) continue;
      if (!triggers.eventTypes.includes(input.eventType)) continue;
      if (!triggers.eventEntities.includes(input.entityType)) continue;
      // A record-context agent is the only shape an event can feed; it names the entity it reads.
      if (parsed.config.input.mode !== 'record' || parsed.config.input.entity !== input.entityType) continue;
      candidates.push({ agent });
    }

    const skipped: { agent: string; reason: string }[] = [];
    const errors: { agent: string; category: string }[] = [];
    let started = 0;
    // Fan-out cap: one busy record must not start the whole catalogue.
    for (const { agent } of candidates.slice(0, 5)) {
      if (agent.owner_user_id === null) {
        skipped.push({ agent: agent.agent_key, reason: 'owner-missing' });
        continue;
      }
      let principal;
      try {
        principal = await this.auth.principalFromUser(agent.owner_user_id);
      } catch {
        skipped.push({ agent: agent.agent_key, reason: 'owner-inactive' });
        continue;
      }
      try {
        await this.scope.runAs(
          principal,
          () =>
            this.triggerRun({
              agentId: agent.id,
              trigger: 'event',
              runInput: { record: { entity: input.entityType, id: input.entityId } },
              // At-least-once delivery: re-delivering the event is a no-op for this agent.
              idempotencyKey: `evt:${input.eventId}:${agent.id}`,
              causationId: input.eventId,
              depth: 0,
            }),
          `aiAgentTrigger:${input.eventId}`,
        );
        started += 1;
      } catch (error) {
        const category =
          error instanceof FeatureDisabledError
            ? 'feature_disabled'
            : error instanceof RateLimitError
              ? 'rate_limited'
              : error instanceof ValidationError
                ? 'validation'
                : error instanceof NotFoundError
                  ? 'not_found'
                  : 'internal_error';
        errors.push({ agent: agent.agent_key, category });
      }
    }
    return { matched: candidates.length, started, skipped, errors };
  }

  /**
   * 19-AI.17 — the worker's door for one cron firing of an agent's schedule.
   *
   * The kernel scheduler already deduplicated the boundary (`scheduled_jobs.last_run_at` + the
   * deterministic BullMQ job id); this method's own dedup is the run's idempotency key
   * `sched:<agentId>:<scheduledForMs>`, so a retried delivery of the same firing is a no-op.
   *
   * Like an event trigger, the run executes as the **agent owner** — never wider. Provenance is
   * the `trigger` column plus `causation_id` (the schedule row id): `service_principal` stays NULL
   * because the schema's principal check allows only one of the two, and the owner must remain the
   * initiator for quota, visibility and audit. A disabled feature
   * or an agent that no longer qualifies is a quiet `{ started: 0 }`, not an error the scheduler
   * would retry forever.
   */
  async triggerSchedule(input: {
    readonly agentId: string;
    readonly scheduledForMs?: number;
  }): Promise<{
    readonly disabled?: true;
    readonly started: number;
    readonly runId?: string;
    readonly reason?: string;
  }> {
    const settings = await this.settings.settings();
    if (!settings.features.scheduledTriggers) {
      return { disabled: true, started: 0 };
    }
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', input.agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (agent === undefined || agent.status !== 'published' || agent.current_version === null) {
      return { started: 0, reason: 'agent-not-published' };
    }
    const version = await this.database.db
      .selectFrom('ai_agent_versions')
      .select('config')
      .where('agent_id', '=', agent.id)
      .where('version', '=', agent.current_version)
      .executeTakeFirst();
    const parsed = version === undefined ? undefined : parseAgentConfig(version.config);
    const config = parsed?.ok === true ? parsed.config : undefined;
    const cron = config?.triggers.scheduleCron?.trim() ?? '';
    const text = config?.triggers.scheduleText?.trim() ?? '';
    if (
      config === undefined ||
      !config.triggers.schedule ||
      !isValidCronExpression(cron) ||
      config.input.mode !== 'text' ||
      text === ''
    ) {
      return { started: 0, reason: 'schedule-not-configured' };
    }
    if (agent.owner_user_id === null) return { started: 0, reason: 'owner-missing' };
    let principal;
    try {
      principal = await this.auth.principalFromUser(agent.owner_user_id);
    } catch {
      return { started: 0, reason: 'owner-inactive' };
    }
    const scheduledFor = input.scheduledForMs ?? Date.now();
    const scheduleId = aiAgentScheduleId(agent.id);
    try {
      const view = await this.scope.runAs(
        principal,
        () =>
          this.triggerRun({
            agentId: agent.id,
            trigger: 'schedule',
            runInput: { text },
            idempotencyKey: `sched:${agent.id}:${scheduledFor}`,
            causationId: scheduleId,
          }),
        `aiAgentSchedule:${agent.id}`,
      );
      return { started: 1, runId: view.id };
    } catch (error) {
      const category =
        error instanceof FeatureDisabledError
          ? 'feature_disabled'
          : error instanceof RateLimitError
            ? 'rate_limited'
            : error instanceof ValidationError
              ? 'validation'
              : 'internal_error';
      if (category === 'internal_error') {
        log.warn({ agentId: agent.id, err: error instanceof Error ? error.message : String(error) }, 'scheduled trigger run failed');
      }
      return { started: 0, reason: category };
    }
  }

  /**
   * 19-AI.17 — the worker's door for committed `integration.*` events.
   *
   * AdvancedIntegrations publishes its inbound-webhook and sync outcomes through the transactional
   * outbox (`integration.record.imported`, `integration.conflict.opened`, …); the worker subscriber
   * ferries them here. An agent fires only when it opted in with `triggers.integration` plus a
   * matching `triggers.integrationTypes` allowlist, and only as a **record-context** run for the
   * entity the payload names — the same rule event triggers follow, because the payload is
   * untrusted external data and must never become prompt text.
   *
   * Integration triggers share the `features.eventTriggers` flag: both are "a committed event
   * started this run". The run executes as the agent owner; `causation_id` is the outbox event id,
   * which resolves back to the payload (and its event type). Recursion is already impossible
   * because agent-produced events carry
   * `correlation_id = 'aiAgentRun:<id>'` and never reach this door.
   */
  async triggerIntegrationEvent(input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly disabled?: true;
    readonly matched: number;
    readonly started: number;
    readonly skipped: readonly { readonly agent: string; readonly reason: string }[];
    readonly errors: readonly { readonly agent: string; readonly category: string }[];
  }> {
    const settings = await this.settings.settings();
    if (!settings.features.eventTriggers) {
      return { disabled: true, matched: 0, started: 0, skipped: [], errors: [] };
    }
    if (!input.eventType.startsWith('integration.')) {
      throw new ValidationError('Only integration.* events may enter through this door.');
    }
    const entityType = typeof input.payload['crmEntityType'] === 'string' ? input.payload['crmEntityType'] : '';
    const entityId = typeof input.payload['crmEntityId'] === 'string' ? input.payload['crmEntityId'] : '';
    if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(entityType) || entityId === '' || entityId.length > 120) {
      // No record context: no agent input mode can consume the event safely.
      return { matched: 0, started: 0, skipped: [], errors: [] };
    }

    const db = this.database.db;
    const published = await db
      .selectFrom('ai_agents')
      .selectAll()
      .where('status', '=', 'published')
      .where('is_deleted', '=', false)
      .orderBy('id', 'asc')
      .limit(20)
      .execute();

    const candidates: { readonly agent: (typeof published)[number] }[] = [];
    for (const agent of published) {
      if (agent.current_version === null) continue;
      const version = await db
        .selectFrom('ai_agent_versions')
        .selectAll()
        .where('agent_id', '=', agent.id)
        .where('version', '=', agent.current_version)
        .executeTakeFirst();
      if (!version) continue;
      const parsed = parseAgentConfig(version.config);
      if (!parsed.ok) continue;
      const triggers = parsed.config.triggers;
      if (!triggers.integration) continue;
      if (!triggers.integrationTypes.includes(input.eventType)) continue;
      // Same rule as event triggers: the payload can only feed a record-context agent for exactly
      // this entity.
      if (parsed.config.input.mode !== 'record' || parsed.config.input.entity !== entityType) continue;
      candidates.push({ agent });
    }

    const skipped: { agent: string; reason: string }[] = [];
    const errors: { agent: string; category: string }[] = [];
    let started = 0;
    for (const { agent } of candidates.slice(0, 5)) {
      if (agent.owner_user_id === null) {
        skipped.push({ agent: agent.agent_key, reason: 'owner-missing' });
        continue;
      }
      let principal;
      try {
        principal = await this.auth.principalFromUser(agent.owner_user_id);
      } catch {
        skipped.push({ agent: agent.agent_key, reason: 'owner-inactive' });
        continue;
      }
      try {
        await this.scope.runAs(
          principal,
          () =>
            this.triggerRun({
              agentId: agent.id,
              trigger: 'integration',
              runInput: { record: { entity: entityType, id: entityId } },
              idempotencyKey: `int:${input.eventId}:${agent.id}`,
              causationId: input.eventId,
            }),
          `aiAgentTrigger:${input.eventId}`,
        );
        started += 1;
      } catch (error) {
        const category =
          error instanceof FeatureDisabledError
            ? 'feature_disabled'
            : error instanceof RateLimitError
              ? 'rate_limited'
              : error instanceof ValidationError
                ? 'validation'
                : error instanceof NotFoundError
                  ? 'not_found'
                  : 'internal_error';
        errors.push({ agent: agent.agent_key, category });
      }
    }
    return { matched: candidates.length, started, skipped, errors };
  }
}
