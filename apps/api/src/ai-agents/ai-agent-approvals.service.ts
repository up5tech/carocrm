import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AIAgentApprovalsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { PostgresRecordStore } from '../entity/entity-record.store.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import { aiApprovalSecondApproverRequiredError, aiApprovalSelfApprovalForbiddenError } from './ai-agent-errors.js';
import { AIAgentRunService } from './ai-agent-runs.service.js';
import { AIToolRegistry, expectedTargetVersionsOf } from './ai-agent-tools.js';
import { type RunStatus,TERMINAL_RUN_STATUSES } from './ai-agents-module.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';

/**
 * Phase 19-AI.10 — approval inbox and decisions
 * (plans/PLAN_Phase_19_AI_Agents.md §9.2, §9.3, §14.3, §20 `19-AI.10`).
 *
 * A pending approval is a **proposal**, not a permission grant. Approving records who accepted which
 * exact proposal (tool, argument hash, targets), and the engine revalidates the tool, the grant, the
 * stored arguments and the target record before it executes. An approval that expires, whose run is
 * canceled, whose agent is archived or whose tool is disabled becomes invalid rather than silently
 * stale — and an invalid approval never executes.
 *
 * The inbox is capability-gated (`approval`) on the server. The timeline records the decision with
 * the approver's identity, so a run can explain who allowed the action and when.
 *
 * Phase 19-AI.21 (§24) adds the **self-approval policy**: the person a proposal was requested from
 * may not complete it alone. The decision, the codes and the rollback are documented in
 * `docs/modules/ai-agents/security-and-threat-model.md`.
 */

/**
 * Effect classes a self-approval may not complete on its own (19-AI.21).
 *
 * A `read` or `low_write` approval is a formality — there is no business write behind it — so the
 * requester may still decide it and the decision is audited. A `material_write` or `high_impact`
 * proposal is the case the policy exists for.
 */
const SELF_APPROVAL_GATED_CLASSES: ReadonlySet<string> = new Set(['material_write', 'high_impact']);

/** The pending first signature of a permissive-mode self-approval (19-AI.21). */
interface FirstApproval {
  readonly by: string;
  readonly at: string;
  readonly note: string | null;
}

export type ApprovalStatusFilter =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'expired'
  | 'invalidated'
  | 'executed'
  | 'all';

export interface ApprovalListQuery {
  readonly status?: ApprovalStatusFilter | undefined;
  readonly runId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly offset?: number | undefined;
  readonly maxSize?: number | undefined;
}

export interface ApprovalView {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly toolKey: string | null;
  readonly actionClass: string;
  readonly riskLevel: string;
  readonly summary: string;
  readonly proposal: unknown;
  readonly targets: unknown;
  readonly status: string;
  readonly requestedByUserId: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly revalidation: unknown;
  readonly executionResult: unknown;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly selfApproval: boolean;
  /** Phase 19-AI.21: the requester signed it and a second approver is still required. */
  readonly awaitingSecondApproval: boolean;
}

@Injectable()
export class AIAgentApprovalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(AIAgentRunService) private readonly runs: AIAgentRunService,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(ENTITY_STORE) private readonly store: PostgresRecordStore,
  ) {}

  async list(query: ApprovalListQuery = {}): Promise<{
    list: ApprovalView[];
    total: number;
    offset: number;
    count: number;
    expired: number;
  }> {
    await this.permissions.assert('approval');
    const expired = await this.expireDue();
    const offset = Math.max(0, query.offset ?? 0);
    const maxSize = Math.min(100, Math.max(1, query.maxSize ?? 25));
    const status = query.status ?? 'pending';

    let builder = this.database.db.selectFrom('ai_agent_approvals');
    if (status !== 'all') builder = builder.where('status', '=', status);
    if (query.runId !== undefined) builder = builder.where('run_id', '=', query.runId);
    if (query.agentId !== undefined) builder = builder.where('agent_id', '=', query.agentId);
    const totalRow = await builder.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    const rows = await builder
      .selectAll()
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(maxSize)
      .execute();
    const names = await this.agentNames(rows.map((row) => row.agent_id));
    return {
      list: rows.map((row) => this.toView(row, names.get(row.agent_id) ?? '')),
      total: Number(totalRow?.count ?? 0),
      offset,
      count: rows.length,
      expired,
    };
  }

  /** The approvals of one run, visible to an approver or to the user who started it. */
  async forRun(runId: string): Promise<{ list: ApprovalView[] }> {
    const approved = await this.permissions.can('approval');
    if (!approved) {
      const row = await this.database.db
        .selectFrom('ai_agent_runs')
        .select(['initiated_by_user_id'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!row || row.initiated_by_user_id !== this.scope.userId) {
        await this.permissions.assert('approval');
      }
    }
    const rows = await this.database.db
      .selectFrom('ai_agent_approvals')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('created_at', 'desc')
      .execute();
    const names = await this.agentNames(rows.map((row) => row.agent_id));
    return { list: rows.map((row) => this.toView(row, names.get(row.agent_id) ?? '')) };
  }

  async get(id: string): Promise<ApprovalView> {
    const row = await this.requireVisible(id);
    const names = await this.agentNames([row.agent_id]);
    return this.toView(row, names.get(row.agent_id) ?? '');
  }

  async approve(id: string, note?: string): Promise<{ approval: ApprovalView; resumed: boolean }> {
    return this.decide(id, 'approved', note);
  }

  async reject(id: string, note?: string): Promise<{ approval: ApprovalView; resumed: boolean }> {
    return this.decide(id, 'rejected', note);
  }

  private async decide(
    id: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<{ approval: ApprovalView; resumed: boolean }> {
    await this.permissions.assert('approval');
    const approval = await this.requireVisible(id);
    if (approval.status !== 'pending') {
      throw new ValidationError(`This approval is already "${approval.status}".`);
    }
    if (approval.expires_at.getTime() < Date.now()) {
      await this.expireOne(approval);
      throw new ValidationError('This approval expired before the decision; the run cannot execute it.');
    }
    const run = await this.database.db
      .selectFrom('ai_agent_runs')
      .selectAll()
      .where('id', '=', approval.run_id)
      .executeTakeFirst();
    if (!run) throw new ValidationError('The run this approval belongs to no longer exists.');
    if (TERMINAL_RUN_STATUSES.has(run.status as RunStatus)) {
      await this.invalidate(approval, `The run already ended as "${run.status}".`);
      throw new ValidationError(`The run already ended as "${run.status}"; the approval is invalid.`);
    }
    if (run.status !== 'waiting_for_approval') {
      await this.invalidate(approval, `The run is "${run.status}", not waiting for approval.`);
      throw new ValidationError('The run is not waiting for an approval decision.');
    }

    const now = new Date();
    const decidedBy = this.scope.userId ?? null;
    const selfApproval = decidedBy !== null && decidedBy === approval.requested_by_user_id;
    if (decision === 'approved') {
      const invalid = await this.revalidationFailure(approval);
      if (invalid !== null) {
        await this.invalidate(approval, invalid);
        await this.runs.settleFromApproval(approval.run_id, 'blocked_by_policy', 'approval_invalidated', invalid);
        throw new ValidationError(`The proposal can no longer be executed: ${invalid}`);
      }
      // 19-AI.21: separation of duties on the decision itself. A stale proposal is already dead
      // above; a live one still has to pass the self-approval policy before anybody signs it.
      if (selfApproval) await this.assertSelfApprovalPolicy(approval, note);
    }

    const firstApproval = readFirstApproval(approval.revalidation);

    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('ai_agent_approvals')
        .set({
          status: decision,
          decided_by_user_id: decidedBy,
          decided_at: now,
          decision_note: note?.slice(0, 1_000) ?? null,
          revalidation: JSON.stringify({
            ok: decision === 'approved',
            checkedAt: now.toISOString(),
            selfApproval,
            // The second signature of a permissive-mode proposal (§24, 19-AI.21). Kept here so the
            // approval row explains why it needed two people, even after the decision is final.
            ...(firstApproval === null ? {} : { secondApproval: true, firstApproval }),
          }),
          modified_at: now,
        })
        .where('id', '=', id)
        .where('status', '=', 'pending')
        .execute();
      if (decision === 'approved') {
        await trx
          .updateTable('ai_agent_runs')
          .set({ status: 'queued', modified_at: now })
          .where('id', '=', approval.run_id)
          .execute();
      } else {
        await trx
          .updateTable('ai_agent_runs')
          .set({
            status: 'canceled',
            failure_category: 'approval_rejected',
            failure_message: 'A reviewer rejected the proposed action.',
            finished_at: now,
            modified_at: now,
            lease_owner: null,
            lease_expires_at: null,
          })
          .where('id', '=', approval.run_id)
          .execute();
        await trx
          .updateTable('ai_agent_approvals')
          .set({
            status: 'invalidated',
            decision_note: 'The run was canceled by a rejected approval.',
            modified_at: now,
          })
          .where('run_id', '=', approval.run_id)
          .where('status', '=', 'pending')
          .where('id', '!=', id)
          .execute();
      }
    });

    await this.runs.note(
      approval.run_id,
      'approval',
      decision === 'approved' ? 'approval.approved' : 'approval.rejected',
      decision === 'approved'
        ? `Approval granted${selfApproval ? ' by the requester' : ''}.`
        : `Approval rejected${note === undefined ? '' : `: ${note.slice(0, 200)}`}.`,
      { approvalId: id, decidedBy, selfApproval },
    );

    let resumed = false;
    if (decision === 'approved') {
      // A queue outage leaves the run queued, not lost: the approval is recorded and an operator or
      // a later recovery pass can execute it.
      resumed = await this.runs.requestExecution(approval.run_id);
    }
    const fresh = await this.database.db
      .selectFrom('ai_agent_approvals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const names = await this.agentNames([fresh.agent_id]);
    return { approval: this.toView(fresh, names.get(fresh.agent_id) ?? ''), resumed };
  }

  /**
   * Phase 19-AI.21 — the self-approval policy (§24).
   *
   * `forbidden` (the default): a `material_write` or `high_impact` proposal cannot be approved by the
   * person it was requested from. The refusal is a 403 with a stable code and changes nothing — the
   * proposal stays pending, so another approver may still decide it.
   *
   * `permitted_with_audit`: the requester's own decision is **recorded** — on the approval row and in
   * the run timeline — but it does not make the action executable. A second approver has to sign, and
   * only then does the run leave `waiting_for_approval`.
   *
   * The check is deliberately not an admin bypass: an administrator who started the run needs a second
   * approver just like anybody else. Rejecting one's own proposal stays allowed — refusing an action is
   * the safe direction.
   */
  private async assertSelfApprovalPolicy(
    approval: AIAgentApprovalsTable,
    note?: string,
  ): Promise<void> {
    if (!SELF_APPROVAL_GATED_CLASSES.has(approval.action_class)) return;
    const policy = (await this.settings.settings()).approval.selfApprovalPolicy;
    if (policy === 'forbidden') {
      throw aiApprovalSelfApprovalForbiddenError({
        approvalId: approval.id,
        actionClass: approval.action_class,
        policy,
      });
    }
    await this.recordFirstSignature(approval, note);
    throw aiApprovalSecondApproverRequiredError({
      approvalId: approval.id,
      actionClass: approval.action_class,
      policy,
    });
  }

  /**
   * Keep the requester's first signature (19-AI.21, permissive mode).
   *
   * The signature lives in two places: the approval row, so the inbox can say the proposal is waiting
   * for a second approver, and the run timeline, which is the durable audit trail — the row's
   * `revalidation` payload is overwritten again when the action executes. A repeated attempt by the
   * same person is not recorded twice.
   */
  private async recordFirstSignature(approval: AIAgentApprovalsTable, note?: string): Promise<void> {
    const decidedBy = this.scope.userId ?? null;
    if (decidedBy === null) return;
    if (readFirstApproval(approval.revalidation) !== null) return;
    const at = new Date().toISOString();
    const first: FirstApproval = { by: decidedBy, at, note: note?.slice(0, 1_000) ?? null };
    await this.database.db
      .updateTable('ai_agent_approvals')
      .set({
        revalidation: JSON.stringify({
          ok: false,
          checkedAt: at,
          selfApproval: true,
          secondApprovalRequired: true,
          firstApproval: first,
        }),
        modified_at: new Date(),
      })
      .where('id', '=', approval.id)
      .where('status', '=', 'pending')
      .execute();
    await this.runs.note(
      approval.run_id,
      'approval',
      'approval.self_signed',
      'The requester signed their own proposal; a second approver is required before it can execute.',
      { approvalId: approval.id, actionClass: approval.action_class, by: decidedBy },
    );
  }

  /** Expire every pending approval whose deadline passed; returns the count. */
  async expireDue(): Promise<number> {
    const due = await this.database.db
      .selectFrom('ai_agent_approvals')
      .selectAll()
      .where('status', '=', 'pending')
      .where('expires_at', '<', new Date())
      .execute();
    let count = 0;
    for (const approval of due) {
      await this.expireOne(approval);
      count += 1;
    }
    return count;
  }

  private async expireOne(approval: AIAgentApprovalsTable): Promise<void> {
    await this.database.db
      .updateTable('ai_agent_approvals')
      .set({ status: 'expired', modified_at: new Date() })
      .where('id', '=', approval.id)
      .where('status', '=', 'pending')
      .execute();
    await this.runs.settleFromApproval(
      approval.run_id,
      'expired',
      'approval_expired',
      'The approval expired before a decision was made.',
    );
  }

  private async invalidate(approval: AIAgentApprovalsTable, reason: string): Promise<void> {
    await this.database.db
      .updateTable('ai_agent_approvals')
      .set({ status: 'invalidated', decision_note: reason.slice(0, 1_000), modified_at: new Date() })
      .where('id', '=', approval.id)
      .where('status', '=', 'pending')
      .execute();
  }

  /** Reasons an approved proposal must not execute. Empty means it may. */
  private async revalidationFailure(approval: AIAgentApprovalsTable): Promise<string | null> {
    // The decision is about the version the human was shown. A record that moved after the preview
    // makes the proposal stale, and the answer is to ask again — not to apply the same write to
    // whatever the record became (plan §18 task 4). A missing record is left to execution, which
    // reports it through the tool's own ACL/not-found path.
    for (const [key, expected] of Object.entries(expectedTargetVersionsOf(approval.targets))) {
      const separator = key.indexOf(':');
      if (separator <= 0) continue;
      const record = await this.store.findById(key.slice(0, separator), key.slice(separator + 1));
      if (record === undefined) continue;
      if (record.version !== expected) {
        return `The record changed after the proposal was shown (version ${String(expected)} → ${String(record.version)}); ask the assistant again.`;
      }
    }
    if (approval.tool_call_id === null) return 'The approval has no linked tool call.';
    const call = await this.database.db
      .selectFrom('ai_agent_tool_calls')
      .selectAll()
      .where('id', '=', approval.tool_call_id)
      .executeTakeFirst();
    if (!call) return 'The proposed tool call no longer exists.';
    if (call.status !== 'validated') return `The tool call is already "${call.status}".`;
    if (!this.tools.has(call.tool_key)) return `Tool "${call.tool_key}" is no longer registered.`;
    if (!(await this.tools.isEnabled(call.tool_key))) return `Tool "${call.tool_key}" is disabled.`;
    const version = await this.database.db
      .selectFrom('ai_agent_versions')
      .select('id')
      .where('agent_id', '=', approval.agent_id)
      .where('version', '=', approval.agent_version)
      .executeTakeFirst();
    if (!version) return 'The captured agent version no longer exists.';
    const grant = await this.database.db
      .selectFrom('ai_agent_tool_grants')
      .select('id')
      .where('agent_version_id', '=', version.id)
      .where('tool_key', '=', call.tool_key)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!grant) return `Tool "${call.tool_key}" is no longer granted to this agent version.`;
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .select(['status'])
      .where('id', '=', approval.agent_id)
      .executeTakeFirst();
    if (!agent) return 'The agent no longer exists.';
    if (agent.status === 'archived') return 'The agent was archived.';
    return null;
  }

  private async requireVisible(id: string): Promise<AIAgentApprovalsTable> {
    await this.permissions.assert('use');
    const row = await this.database.db
      .selectFrom('ai_agent_approvals')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new ValidationError(`Approval "${id}" does not exist.`);
    const canApprove = await this.permissions.can('approval');
    const canAudit = await this.permissions.can('audit');
    if (!canApprove && !canAudit) {
      const run = await this.database.db
        .selectFrom('ai_agent_runs')
        .select(['initiated_by_user_id'])
        .where('id', '=', row.run_id)
        .executeTakeFirst();
      if (!run || run.initiated_by_user_id !== this.scope.userId) {
        throw new ValidationError(`Approval "${id}" does not exist.`);
      }
    }
    return row;
  }

  private async agentNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.database.db
      .selectFrom('ai_agents')
      .select(['id', 'name'])
      .where('id', 'in', unique)
      .execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private toView(row: AIAgentApprovalsTable, agentName: string): ApprovalView {
    const proposal = asRecord(row.proposal);
    return {
      id: row.id,
      runId: row.run_id,
      agentId: row.agent_id,
      agentName,
      agentVersion: row.agent_version,
      toolKey: typeof proposal['toolKey'] === 'string' ? proposal['toolKey'] : null,
      actionClass: row.action_class,
      riskLevel: row.risk_level,
      summary: row.summary,
      proposal: row.proposal,
      targets: row.targets,
      status: row.status,
      requestedByUserId: row.requested_by_user_id,
      decidedByUserId: row.decided_by_user_id,
      decidedAt: row.decided_at?.toISOString() ?? null,
      decisionNote: row.decision_note,
      revalidation: row.revalidation,
      executionResult: row.execution_result,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      selfApproval:
        row.requested_by_user_id !== null &&
        row.decided_by_user_id !== null &&
        row.requested_by_user_id === row.decided_by_user_id,
      awaitingSecondApproval: row.status === 'pending' && isAwaitingSecondApproval(row.revalidation),
    };
  }
}

/** The first (self) signature of a permissive-mode proposal, if one was recorded (19-AI.21). */
function readFirstApproval(value: unknown): FirstApproval | null {
  const first = asRecord(asRecord(value)['firstApproval']);
  const by = first['by'];
  if (typeof by !== 'string' || by === '') return null;
  const at = first['at'];
  const note = first['note'];
  return {
    by,
    at: typeof at === 'string' ? at : '',
    note: typeof note === 'string' ? note : null,
  };
}

/** True while a proposal carries a first signature and still waits for a second one (19-AI.21). */
function isAwaitingSecondApproval(value: unknown): boolean {
  return asRecord(value)['secondApprovalRequired'] === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
