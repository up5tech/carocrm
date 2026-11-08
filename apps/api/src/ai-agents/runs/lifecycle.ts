/**
 * Run lifecycle — create, retry, cancel, input, resume (19-AI.25).
 */

import { randomUUID } from 'node:crypto';

import { NotFoundError, RateLimitError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import { sql } from 'kysely';

import type { Db } from '../../database/database.service.js';
import type { AgentConfig } from '../ai-agent-config.js';
import { agentConfigChecksum, parseAgentConfig } from '../ai-agent-config.js';
import { AI_AGENT_RUN_JOB } from '../ai-agent-jobs.js';
import type { RunStatus } from '../ai-agents-module.js';
import { MAX_RUN_RECORD_REFS, TERMINAL_RUN_STATUSES } from '../ai-agents-module.js';
import { AIAgentRunExecutor } from './executor.js';
import { type AIAgentRunView, asRecord, isUniqueViolation,type RunCreateInput, type RunRecordRef } from './shared.js';

export abstract class AIAgentRunLifecycle extends AIAgentRunExecutor {
  async create(agentId: string, input: RunCreateInput): Promise<AIAgentRunView> {
    return this.createInternal(agentId, input, false);
  }

  /**
   * `allowTrigger` is set only by an internal caller that already enforced its own trigger policy
   * (triggerRun). A direct caller through the public/manual path keeps the refusal below.
   */
  protected async createInternal(agentId: string, input: RunCreateInput, allowTrigger: boolean): Promise<AIAgentRunView> {
    await this.policy.assertCanStartRun();
    const settings = await this.settings.settings();
    const principal = this.scope.requirePrincipal();
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!agent) throw new NotFoundError(`Agent "${agentId}" does not exist.`);
    // Visibility is authorization: a caller who cannot see the definition cannot run it by id.
    const canSeeEveryone = this.scope.isAdmin || (await this.permissions.can('publish')) || (await this.permissions.can('audit'));
    const visible =
      canSeeEveryone ||
      agent.visibility === 'organization' ||
      (agent.owner_user_id !== null && agent.owner_user_id === principal.userId) ||
      (agent.team_id !== null && this.scope.teamIds().includes(agent.team_id));
    if (!visible) throw new NotFoundError(`Agent "${agentId}" does not exist.`);
    if (agent.status !== 'published') {
      throw new ValidationError(`Agent "${agent.name}" is ${agent.status}; only a published agent can run.`);
    }
    if (agent.current_version === null) {
      throw new ValidationError(`Agent "${agent.name}" has no published version.`);
    }
    const version = await this.database.db
      .selectFrom('ai_agent_versions')
      .selectAll()
      .where('agent_id', '=', agent.id)
      .where('version', '=', agent.current_version)
      .executeTakeFirst();
    if (!version) throw new NotFoundError(`The published version of "${agent.name}" is missing.`);
    const parsed = parseAgentConfig(version.config);
    if (!parsed.ok) {
      throw new ValidationError('The published configuration is no longer valid; republish the agent.', {
        issues: parsed.issues,
      });
    }
    const config = parsed.config;
    if (agentConfigChecksum(version.config) !== version.checksum) {
      throw new ValidationError('The published version checksum does not match its configuration; republish the agent.');
    }
    if (!allowTrigger && input.trigger !== undefined && input.trigger !== 'manual') {
      // Non-interactive triggers arrive with their own service identity in AI.15–AI.17. Refusing is
      // safer than accepting a trigger no principal model enforces.
      throw new ValidationError('Only manual runs are implemented in this release.');
    }
    if (!settings.features.execution) throw new ValidationError('Agent execution is disabled.');
    if (settings.safety.globalExecutionPaused) throw new ValidationError('Agent execution is globally paused.');

    const normalized = await this.normalizeInput(config, input.input);
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

    // A run waiting for a human is not consuming an execution slot; otherwise two pending approvals
    // would block the whole instance. Only work that can be executing right now is counted.
    const active = await this.database.db
      .selectFrom('ai_agent_runs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', ['queued', 'running', 'retry_wait', 'cancel_requested'])
      .executeTakeFirst();
    if (Number(active?.count ?? 0) >= settings.limits.maxConcurrency) {
      throw new ValidationError(
        `The instance allows ${String(settings.limits.maxConcurrency)} concurrent agent runs; wait for one to finish.`,
      );
    }

    // Unlocked quota pre-check (19-AI.13): refuse obvious overruns before any side effect, so a
    // refused run never leaves an empty conversation thread behind. The locked re-check inside the
    // insert transaction below is the atomic guarantee.
    await this.quotas.assertRunAllowedUnlocked({
      userId: principal.userId,
      agentId: agent.id,
      providerKey: config.provider?.key ?? '',
    });
    // 19-AI.22: per-user creation fairness — a cheap pre-check so a refused run never leaves an
    // empty conversation thread; the serialized re-check inside the insert transaction is the
    // guarantee (two concurrent creates cannot both take the last slot of the window).
    await this.assertUserRunRateAllowed(this.database.db, principal.userId, settings.limits.maxRunsPerUserPerMinute, false);

    // A conversation is resolved only after the concurrency gate, so a refused run never leaves an
    // empty thread behind. Ownership, agent match and expiry are enforced inside the memory service.
    const conversation = await this.memory.conversationForRun({
      agentId: agent.id,
      agentName: agent.name,
      config,
      userId: principal.userId,
      text: normalized.input.text,
      conversationId: input.conversationId,
      record: normalized.input.record,
    });

    const now = new Date();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    try {
      // 19-AI.13 §12.3: the quota re-check shares the insert's transaction and locks the matching
      // policy rows, so two concurrent creations cannot both take the last available slot.
      await this.database.db.transaction().execute(async (trx) => {
        await this.quotas.assertRunAllowed(trx, {
          userId: principal.userId,
          agentId: agent.id,
          providerKey: config.provider?.key ?? '',
        });
        await this.assertUserRunRateAllowed(trx, principal.userId, settings.limits.maxRunsPerUserPerMinute, true);
        await trx
          .insertInto('ai_agent_runs')
          .values({
            id,
            agent_id: agent.id,
            agent_version_id: version.id,
            agent_version: version.version,
            initiated_by_user_id: principal.userId,
            service_principal: null,
            trigger: input.trigger ?? 'manual',
            status: 'queued',
            input: JSON.stringify(normalized.input),
            input_ref: normalized.input.ref ?? null,
            idempotency_key: input.idempotencyKey ?? null,
            correlation_id: id,
            causation_id: null,
            lease_owner: null,
            lease_expires_at: null,
            started_at: null,
            finished_at: null,
            expires_at: expiresAt,
            step_count: 0,
            model_call_count: 0,
            tool_call_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            estimated_cost_usd: '0',
            result: null,
            failure_category: null,
            failure_message: null,
            cancel_requested: false,
            conversation_id: conversation?.id ?? null,
            created_at: now,
            modified_at: now,
          })
          .execute();
      });
    } catch (error) {
      // The unique partial index is the real idempotency guarantee under a concurrent retry.
      if (input.idempotencyKey !== undefined && isUniqueViolation(error)) {
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
      throw error;
    }

    if (conversation !== undefined) {
      const message = normalized.input.text ?? (normalized.input.record === undefined
        ? 'Started a conversation.'
        : `Started from ${normalized.input.record.entity} "${normalized.input.record.id}".`);
      await this.memory.appendUserMessage(conversation.id, id, message);
    }
    await this.appendEvent(id, 'run', 'run.queued', `Run queued for agent "${agent.name}".`, {
      agentVersion: version.version,
      trigger: input.trigger ?? 'manual',
      ...(conversation === undefined ? {} : { conversationId: conversation.id }),
    });
    await this.enqueue(id);
    return this.get(id);
  }

  async retry(id: string, idempotencyKey?: string): Promise<AIAgentRunView> {
    await this.permissions.assert('use');
    const row = await this.visibleRun(id);
    const retryable: ReadonlySet<RunStatus> = new Set(['failed', 'canceled', 'expired', 'blocked_by_policy']);
    if (!retryable.has(row.status as RunStatus)) {
      throw new ValidationError(`A run with status "${row.status}" cannot be retried.`, { status: row.status });
    }
    const uncertain = await this.database.db
      .selectFrom('ai_agent_tool_calls')
      .select('id')
      .where('run_id', '=', row.id)
      .where('status', '=', 'outcome_unknown')
      .executeTakeFirst();
    if (uncertain) {
      throw new ValidationError('A tool call from this run has an unknown outcome; reconcile it before retrying.');
    }

    const storedInput = asRecord(row.input);
    const text = typeof storedInput['text'] === 'string' ? storedInput['text'] : undefined;
    const record = asRecord(storedInput['record']);
    const entity = typeof record['entity'] === 'string' ? record['entity'] : undefined;
    const recordId = typeof record['id'] === 'string' ? record['id'] : undefined;
    const storedRefs = storedInput['records'];
    const records = Array.isArray(storedRefs)
      ? storedRefs.flatMap((ref) => {
          const entry = asRecord(ref);
          const entity = typeof entry['entity'] === 'string' ? entry['entity'] : undefined;
          const id = typeof entry['id'] === 'string' ? entry['id'] : undefined;
          return entity === undefined || id === undefined ? [] : [{ entity, id }];
        })
      : [];
    const view = await this.create(row.agent_id, {
      input: {
        ...(text === undefined ? {} : { text }),
        ...(entity === undefined || recordId === undefined ? {} : { record: { entity, id: recordId } }),
        ...(records.length === 0 ? {} : { records }),
      },
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    // A replayed idempotency key returns the run this endpoint already created; it is not rewritten
    // and its timeline is not duplicated.
    const created = await this.database.db
      .selectFrom('ai_agent_runs')
      .select('causation_id')
      .where('id', '=', view.id)
      .executeTakeFirst();
    if (created?.causation_id !== row.id) {
      await this.database.db
        .updateTable('ai_agent_runs')
        .set({ causation_id: row.id, correlation_id: row.correlation_id ?? row.id, modified_at: new Date() })
        .where('id', '=', view.id)
        .execute();
      await this.appendEvent(view.id, 'run', 'run.retried', `Retried run ${row.id}.`, { retryOf: row.id }, 'user');
    }
    return this.get(view.id);
  }

  async cancel(id: string): Promise<AIAgentRunView> {
    await this.permissions.assert('use');
    const row = await this.visibleRun(id);
    if (TERMINAL_RUN_STATUSES.has(row.status as RunStatus)) {
      return this.get(id);
    }
    const now = new Date();
    const immediate = row.status === 'queued' || row.status === 'waiting_for_approval' || row.status === 'waiting_for_input';
    await this.database.db
      .updateTable('ai_agent_runs')
      .set({
        cancel_requested: true,
        modified_at: now,
        ...(immediate ? { status: 'canceled', finished_at: now } : { status: 'cancel_requested' }),
      })
      .where('id', '=', id)
      .execute();
    if (immediate) {
      await this.invalidatePendingApprovals(id, 'The run was canceled by its owner.');
      await this.appendEvent(id, 'run', 'run.canceled', 'Run canceled before completion.', {}, 'user');
      if (row.conversation_id !== null) {
        await this.memory.appendRunOutcome({
          conversationId: row.conversation_id,
          runId: id,
          result: null,
          failureMessage: 'The run was canceled before completion.',
        });
        await this.memory.releaseCheckpoint(id);
      }
    } else {
      await this.appendEvent(id, 'run', 'run.cancel_requested', 'Cancellation requested; the current step will stop.', {}, 'user');
    }
    return this.get(id);
  }

  async provideInput(id: string, text: string): Promise<AIAgentRunView> {
    await this.permissions.assert('use');
    const row = await this.visibleRun(id);
    if (row.status !== 'waiting_for_input') {
      throw new ValidationError('The run is not waiting for input.', { status: row.status });
    }
    const now = new Date();
    const stored = asRecord(row.input);
    const merged = { ...stored, text };
    await this.database.db
      .updateTable('ai_agent_runs')
      .set({ status: 'queued', input: JSON.stringify(merged), modified_at: now })
      .where('id', '=', id)
      .execute();
    await this.appendEvent(id, 'run', 'run.input_received', 'Additional input received; resuming.', { text }, 'user');
    return this.get(id);
  }

  async resume(id: string): Promise<AIAgentRunView> {
    await this.permissions.assert('use');
    const row = await this.visibleRun(id);
    if (row.status === 'waiting_for_input' || row.status === 'waiting_for_approval') {
      await this.database.db
        .updateTable('ai_agent_runs')
        .set({ status: 'queued', modified_at: new Date() })
        .where('id', '=', id)
        .execute();
      await this.appendEvent(id, 'run', 'run.resumed', 'Run resumed by user.', {}, 'user');
    }
    return this.get(id);
  }

  /**
   * Recover queued runs and runs whose lease expired (worker crash, restart, queue outage). Each one
   * goes through the same `execute` claim, so a batch cannot double-drive a live run.
   */
  async recoverBatch(limit = 10): Promise<{ scanned: number; executed: { id: string; status: RunStatus }[] }> {
    await this.permissions.assert('audit');
    const now = new Date();
    const rows = await this.database.db
      .selectFrom('ai_agent_runs')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['queued', 'retry_wait']),
          eb.and([
            eb('status', '=', 'running'),
            eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<', now)]),
          ]),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(Math.min(50, Math.max(1, limit)))
      .execute();
    const executed: { id: string; status: RunStatus }[] = [];
    for (const row of rows) {
      const result = await this.execute(row.id);
      executed.push({ id: row.id, status: result.run.status });
    }
    return { scanned: rows.length, executed };
  }

  /**
   * Settle a run from an approval decision. Kept public so the approval service ends a rejected or
   * expired run through the same transition (and the same timeline event) as the engine.
   */
  async settleFromApproval(
    runId: string,
    status: 'canceled' | 'expired' | 'blocked_by_policy',
    failureCategory: string,
    failureMessage: string,
  ): Promise<void> {
    await this.finish(runId, status, { failureCategory, failureMessage });
  }

  /** A safe, append-only note on a run timeline; used when an approval decision is recorded. */
  async note(
    runId: string,
    category: string,
    type: string,
    summary: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.appendEvent(runId, category, type, summary, payload, 'user');
  }

  /** Enqueue an execution attempt, reporting whether the queue accepted it. */
  async requestExecution(runId: string): Promise<boolean> {
    return this.enqueue(runId);
  }

  private async enqueue(runId: string): Promise<boolean> {
    try {
      await this.jobs.enqueue({ job: AI_AGENT_RUN_JOB, data: { runId } });
      return true;
    } catch (error) {
      // The run row is queued durably; an operator (or the worker retry) can execute it. A queue
      // outage must not roll back a run the user started.
      log.warn(
        { runId, error: error instanceof Error ? error.message : 'unknown queue error' },
        'ai agent run could not be enqueued; it remains queued',
      );
      await this.appendEvent(runId, 'run', 'run.dispatch_pending', 'The job queue was unreachable; the run stays queued.', {}, 'operator');
      return false;
    }
  }

  private async normalizeInput(
    config: AgentConfig,
    raw: RunCreateInput['input'],
  ): Promise<{
    input: { text?: string; record?: RunRecordRef; records?: RunRecordRef[]; ref?: string };
  }> {
    if (config.input.mode === 'record') {
      // A record-context agent reads exactly one record; extra references would be validated and
      // then dropped, so they are refused instead (19-AI.28: never validate-and-drop).
      if (raw?.records !== undefined && raw.records.length > 0) {
        throw new ValidationError('A record-context agent takes a single record, not a list of references.');
      }
      const record = raw?.record;
      const expected = config.input.entity ?? '';
      if (record === undefined) throw new ValidationError(`This agent must be started from a ${expected} record.`);
      if (record.entity !== expected) {
        throw new ValidationError(`This agent reads "${expected}" records, not "${record.entity}".`);
      }
      if (!this.metadata.registry.hasEntity(expected)) throw new ValidationError(`Entity "${expected}" is not registered.`);
      // Fail at creation, under the starter's scope, rather than discovering the refusal mid-run.
      await this.entities.get(expected, record.id);
      return {
        input: {
          record: { entity: record.entity, id: record.id },
          ref: `${expected}:${record.id}`,
        },
      };
    }
    const text = raw?.text?.trim() ?? '';
    if (text === '') throw new ValidationError('A run needs a task.');
    if (text.length > 4_000) throw new ValidationError('A run task may contain at most 4000 characters.');
    const records = await this.normalizeRecordRefs(raw?.records);
    // A text-mode run may still name the record it was started from. It is metadata (the model does
    // not read the record), and it lets the owning module bind a run to its subject.
    return {
      input: {
        text,
        ...(raw?.record === undefined ? {} : { record: raw.record }),
        ...(records.length === 0 ? {} : { records }),
      },
    };
  }

  /**
   * 19-AI.28 — validate the reference list a text-mode run carries. Every entry must name a
   * registered entity and a record the **starter** can read right now: `entities.get` applies the
   * Entity Engine ACL under the current request scope, so an unreadable reference fails creation
   * instead of reaching the prompt. Duplicates collapse to the first occurrence.
   */
  private async normalizeRecordRefs(raw: readonly RunRecordRef[] | undefined): Promise<RunRecordRef[]> {
    if (raw === undefined || raw.length === 0) return [];
    if (raw.length > MAX_RUN_RECORD_REFS) {
      throw new ValidationError(`A run may carry at most ${String(MAX_RUN_RECORD_REFS)} record references.`);
    }
    const seen = new Set<string>();
    const refs: RunRecordRef[] = [];
    for (const ref of raw) {
      const entity = ref.entity.trim();
      const id = ref.id.trim();
      if (entity === '' || id === '') throw new ValidationError('A record reference needs an entity and an id.');
      if (!this.metadata.registry.hasEntity(entity)) {
        throw new ValidationError(`Entity "${entity}" is not registered.`);
      }
      const key = `${entity}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // ACL check at creation, under the starter's scope — the same guarantee the single
      // record-mode path gives. A ref the caller cannot read never becomes a run.
      await this.entities.get(entity, id);
      refs.push({ entity, id });
    }
    return refs;
  }

  /**
   * 19-AI.22 — per-user run-creation fairness. `maxConcurrency` bounds the instance and the quota
   * policies bound spend, but neither stops one principal from consuming the whole creation
   * allowance. The unlocked pass runs before conversation resolution so a refused run leaves no
   * thread behind; the serialized pass takes a per-user advisory lock inside the insert transaction
   * so two concurrent creates cannot both observe the last free slot of the window.
   */
  private async assertUserRunRateAllowed(
    db: Db,
    userId: string,
    perMinute: number,
    serialize: boolean,
  ): Promise<void> {
    if (serialize) {
      await sql`select pg_advisory_xact_lock(hashtext(${userId}))`.execute(db);
    }
    const since = new Date(Date.now() - 60_000);
    const row = await db
      .selectFrom('ai_agent_runs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('initiated_by_user_id', '=', userId)
      .where('created_at', '>', since)
      .executeTakeFirst();
    if (Number(row?.count ?? 0) >= perMinute) {
      throw new RateLimitError(`At most ${String(perMinute)} agent runs may be started per minute.`);
    }
  }
}
