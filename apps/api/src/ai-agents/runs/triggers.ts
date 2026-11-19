/**
 * Trigger doors — event, schedule and integration entry points (19-AI.25).
 */

import { FeatureDisabledError, NotFoundError, RateLimitError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';

import { isValidCronExpression } from '../../jobs/cron.js';
import { type AgentConfig, type BoundedJsonSchema, parseAgentConfig } from '../ai-agent-config.js';
import { aiAgentScheduleId } from '../ai-agents-module.js';
import { AIAgentRunLifecycle } from './lifecycle.js';
import { type AIAgentRunView, type RunCreateInput, type WorkflowRunMetadata } from './shared.js';

/** What the workflow host needs to map a settled run's answer back onto a record. */
export interface WorkflowRunStartResult {
  readonly run: AIAgentRunView;
  readonly outputMode: 'text' | 'json';
  readonly outputSchema?: BoundedJsonSchema | undefined;
}

/** The agent fields a trigger door needs, plus the published version's stored config. */
interface PublishedTriggerAgent {
  readonly id: string;
  readonly agent_key: string;
  readonly owner_user_id: string | null;
  readonly version_config: unknown;
}

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
   * Phase 25.5 — the workflow step door. Unlike the fan-out trigger doors, this starts exactly one
   * published agent named by an administrator's workflow definition. The worker capability only
   * carries the request; every rule below is re-checked against the immutable published version.
   *
   * Principal rule (25.2): `requesting_user` acts as the user who caused the workflow run;
   * `publisher` is accepted only when that same user is the agent owner. There is no service
   * identity. Skill keys are an assertion against the pinned bindings, never an override; an
   * approval expectation can only refuse a permissive agent, never weaken its policy.
   */
  async startFromWorkflow(input: {
    readonly agentId: string;
    readonly task: string;
    readonly record?: { readonly entity: string; readonly id: string } | undefined;
    readonly skillKeys?: readonly string[] | undefined;
    readonly approvalExpectation?: 'policy' | 'must_require' | undefined;
    readonly idempotencyKey: string;
    readonly metadata: WorkflowRunMetadata;
  }): Promise<WorkflowRunStartResult> {
    if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 120) {
      throw new ValidationError('The workflow idempotency key is invalid.');
    }
    // Return the existing run before reading mutable draft fields: a redelivered step must observe
    // the same run even if somebody edited the agent meanwhile.
    const existing = await this.database.db
      .selectFrom('ai_agent_runs')
      .selectAll()
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
    if (existing !== undefined) {
      const { agents } = await this.agentNames([existing.agent_id]);
      return {
        run: this.toView(existing, agents.get(existing.agent_id)),
        ...(await this.outputShape(existing.agent_version_id)),
      };
    }

    const agent = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', input.agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!agent) throw new NotFoundError(`Agent "${input.agentId}" does not exist.`);
    if (agent.status !== 'published' || agent.current_version === null) {
      throw new ValidationError('Only a published agent with a current version can be used in a workflow.');
    }
    const version = await this.database.db
      .selectFrom('ai_agent_versions')
      .selectAll()
      .where('agent_id', '=', agent.id)
      .where('version', '=', agent.current_version)
      .executeTakeFirst();
    if (!version) throw new NotFoundError('The published version is missing.');
    const parsed = parseAgentConfig(version.config);
    if (!parsed.ok) throw new ValidationError('The published configuration is no longer valid; republish the agent.');
    const config = parsed.config;
    if (config.triggers?.workflow !== true) {
      throw new ValidationError('This agent has not opted in to workflow runs.');
    }
    if (input.skillKeys !== undefined && input.skillKeys.length > 0) {
      const pinned = new Set(config.skills.map((binding) => binding.key));
      const unknown = input.skillKeys.filter((key) => !pinned.has(key));
      if (unknown.length > 0) {
        throw new ValidationError('The workflow expects a skill that the published version does not pin.', {
          skills: unknown,
        });
      }
    }
    if (input.approvalExpectation === 'must_require' && config.approval.requireFor.length === 0) {
      throw new ValidationError('The workflow requires an approval policy, but this agent never asks for one.');
    }

    const initiator = input.metadata.userId;
    const publisherMode = config.principal.mode === 'publisher';
    if (publisherMode && (initiator === undefined || initiator === '' || initiator !== agent.owner_user_id)) {
      throw new ValidationError('This version pins the publisher as principal; only its owner may start it from a workflow.');
    }
    const actorId: string | undefined = publisherMode ? (agent.owner_user_id ?? undefined) : initiator;
    if (actorId === undefined || actorId === '') {
      throw new ValidationError('A workflow AI step needs an initiating user.');
    }
    const principal = await this.auth.principalFromUser(actorId);
    const view = await this.scope.runAs(
      principal,
      () =>
        this.createInternal(
          agent.id,
          {
            input: {
              text: input.task,
              ...(input.record === undefined ? {} : { record: input.record }),
            },
            idempotencyKey: input.idempotencyKey,
            trigger: 'workflow',
            metadata: input.metadata,
          },
          true,
        ),
      `workflow:${input.metadata.workflowId}:${input.metadata.workflowRunId}`,
    );
    await this.database.db
      .updateTable('ai_agent_runs')
      .set({ causation_id: input.metadata.workflowRunId, modified_at: new Date() })
      .where('id', '=', view.id)
      .execute();
    await this.appendEvent(
      view.id,
      'run',
      'run.workflow_linked',
      'Started by a workflow step.',
      {
        workflowId: input.metadata.workflowId,
        workflowRunId: input.metadata.workflowRunId,
        nodeId: input.metadata.nodeId,
        principalMode: config.principal.mode,
      },
      'user',
    );
    // The created view is already the caller-visible shape; do not re-read it through `get()` here.
    // This worker door has no session of its own, and the read path would re-check AIAgent.use
    // outside the initiating principal's scope even though creation just passed that check.
    return { run: view, outputMode: config.output.mode, ...(config.output.schema === undefined ? {} : { outputSchema: config.output.schema }) };
  }

  /** The output contract of the exact version a run captured, not the agent's current draft. */
  private async outputShape(versionId: string): Promise<{ outputMode: 'text' | 'json'; outputSchema?: BoundedJsonSchema | undefined }> {
    const row = await this.database.db
      .selectFrom('ai_agent_versions')
      .select('config')
      .where('id', '=', versionId)
      .executeTakeFirst();
    const parsed = row === undefined ? undefined : parseAgentConfig(row.config);
    const config: AgentConfig | undefined = parsed?.ok === true ? parsed.config : undefined;
    return {
      outputMode: config?.output.mode ?? 'text',
      ...(config?.output.schema === undefined ? {} : { outputSchema: config.output.schema }),
    };
  }

  /**
   * Every published agent joined to its current published version, in one query.
   *
   * G95 fix: the doors used to scan an arbitrary first-20 window of published agents (ordered by a
   * random UUID), so a matching agent could be invisible. The scan now sees the whole catalogue —
   * bounded in practice by how many agents an admin publishes — while the fan-out below stays
   * capped at five starts per event.
   */
  private async publishedTriggerAgents(): Promise<readonly PublishedTriggerAgent[]> {
    return this.database.db
      .selectFrom('ai_agents')
      .innerJoin('ai_agent_versions', (join) =>
        join
          .onRef('ai_agent_versions.agent_id', '=', 'ai_agents.id')
          .onRef('ai_agent_versions.version', '=', 'ai_agents.current_version'),
      )
      .select([
        'ai_agents.id',
        'ai_agents.agent_key',
        'ai_agents.owner_user_id',
        'ai_agent_versions.config as version_config',
      ])
      .where('ai_agents.status', '=', 'published')
      .where('ai_agents.is_deleted', '=', false)
      .orderBy('ai_agents.id', 'asc')
      .execute();
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
    const candidates: { readonly agent: PublishedTriggerAgent }[] = [];
    for (const row of await this.publishedTriggerAgents()) {
      const parsed = parseAgentConfig(row.version_config);
      if (!parsed.ok) continue;
      const triggers = parsed.config.triggers;
      if (!triggers.event) continue;
      if (!triggers.eventTypes.includes(input.eventType)) continue;
      if (!triggers.eventEntities.includes(input.entityType)) continue;
      // A record-context agent is the only shape an event can feed; it names the entity it reads.
      if (parsed.config.input.mode !== 'record' || parsed.config.input.entity !== input.entityType) continue;
      candidates.push({ agent: row });
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
        if (category === 'internal_error') {
          log.warn({ agentId: agent.id, err: error instanceof Error ? error.message : String(error) }, 'trigger run failed');
        }
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

    const candidates: { readonly agent: PublishedTriggerAgent }[] = [];
    for (const row of await this.publishedTriggerAgents()) {
      const parsed = parseAgentConfig(row.version_config);
      if (!parsed.ok) continue;
      const triggers = parsed.config.triggers;
      if (!triggers.integration) continue;
      if (!triggers.integrationTypes.includes(input.eventType)) continue;
      // Same rule as event triggers: the payload can only feed a record-context agent for exactly
      // this entity.
      if (parsed.config.input.mode !== 'record' || parsed.config.input.entity !== entityType) continue;
      candidates.push({ agent: row });
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
        if (category === 'internal_error') {
          log.warn({ agentId: agent.id, err: error instanceof Error ? error.message : String(error) }, 'trigger run failed');
        }
      }
    }
    return { matched: candidates.length, started, skipped, errors };
  }
}
