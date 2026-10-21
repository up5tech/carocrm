import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { ApprovalView } from '../ai-agents/ai-agent-approvals.service.js';
import { AIAgentApprovalService } from '../ai-agents/ai-agent-approvals.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';

/**
 * Phase 19-CHAT.12 — action proposal and confirmation (PLAN_Phase_19_CRM_Chat.md §10, §17 `19-CHAT.12`;
 * contract §6.4, §10).
 *
 * ## Chat owns no proposal record
 *
 * The proposal and its decision live in `ai_agent_approvals`, written by the AIAgents runtime when a
 * tool that requires approval is reached. Chat is a **façade**: it projects that row for the SPA and
 * forwards the decision. It never creates a parallel proposal, never pre-approves, and never
 * executes a tool itself. There is exactly one ledger and one executor.
 *
 * ## Where the decision is actually enforced
 *
 * `AIAgentApprovalService.decide` re-reads the target, rechecks ACL and field rights, record state,
 * the proposal hash and the expiry, and refuses a stale proposal. That check is the real one, and it
 * is the one that must not be duplicated here — a second, weaker copy in Chat would be the exact
 * defect the plan warns about. What Chat adds is the *product* gate that AIAgents knows nothing
 * about: the `actionProposals` feature flag and the operator's `safety.allowWrites` switch.
 *
 * ## Why an unknown approval and someone else's approval are the same answer
 *
 * The contract requires `404 NOT_FOUND` for both, so an approval id cannot be probed to discover
 * that another user's run exists. Chat resolves ownership itself before delegating, rather than
 * pattern-matching on the wording of AIAgents' error.
 */
export interface CRMChatActionView {
  readonly id: string;
  readonly runId: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly toolKey: string | null;
  /** The action class the tool belongs to, as classified by AIAgents. */
  readonly actionClass: string;
  /** The risk level AIAgents assigned to this proposal. */
  readonly riskLevel: string;
  /** A one-line, user-safe description of what the action would do. */
  readonly summary: string;
  /** The typed preview AIAgents produced. Bounded and already sanitized by the runtime. */
  readonly proposal: unknown;
  /** The resolved target set, when the tool reported one. */
  readonly targets: unknown;
  readonly status: string;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** Whether the caller may still decide this proposal. */
  readonly actionable: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CRMChatActionDecision {
  readonly action: CRMChatActionView;
  /** Whether the runtime resumed the paused run after the decision. */
  readonly resumed: boolean;
}

@Injectable()
export class CRMChatActionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CRMChatPermissionService) private readonly permissions: CRMChatPermissionService,
    @Inject(CRMChatPolicyService) private readonly policy: CRMChatPolicyService,
    @Inject(AIAgentApprovalService) private readonly approvals: AIAgentApprovalService,
  ) {}

  /** The authorized projection of one proposal. */
  async get(approvalId: string): Promise<CRMChatActionView> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    await this.requireOwned(approvalId);
    const view = await this.approvals.get(approvalId);
    return this.toView(view);
  }

  /**
   * Confirm the proposal. The product gate (`actionProposals` + `safety.allowWrites`) is Chat's;
   * the revalidation is AIAgents'.
   */
  async confirm(approvalId: string, note?: string): Promise<CRMChatActionDecision> {
    await this.permissions.assert('use');
    await this.policy.assertWrites();
    await this.requireOwned(approvalId);
    const result = await this.approvals.approve(approvalId, note);
    return { action: this.toView(result.approval), resumed: result.resumed };
  }

  /** Reject the proposal. A rejection never needs the write switch — it removes an intent to write. */
  async reject(approvalId: string, note?: string): Promise<CRMChatActionDecision> {
    await this.permissions.assert('use');
    await this.policy.assertWorkspace();
    await this.requireOwned(approvalId);
    const result = await this.approvals.reject(approvalId, note);
    return { action: this.toView(result.approval), resumed: result.resumed };
  }

  /**
   * Resolve the caller's ownership of a proposal without leaking whether it exists.
   *
   * A proposal belongs to the caller when the run's conversation is theirs. A run with no Chat
   * conversation falls back to "the caller started the run", which is how AIAgents' own visibility
   * rule reads. Anything else is reported as absent.
   */
  private async requireOwned(approvalId: string): Promise<void> {
    if (typeof approvalId !== 'string' || approvalId.trim() === '') {
      throw new NotFoundError('Action proposal not found.');
    }
    const userId = this.scope.userId;
    if (userId === undefined) throw new NotFoundError('Action proposal not found.');

    const approval = await this.database.db
      .selectFrom('ai_agent_approvals')
      .select(['run_id'])
      .where('id', '=', approvalId)
      .executeTakeFirst();
    if (!approval) throw new NotFoundError(`Action proposal "${approvalId}" does not exist.`);

    const run = await this.database.db
      .selectFrom('ai_agent_runs')
      .select(['id', 'conversation_id', 'initiated_by_user_id'])
      .where('id', '=', approval.run_id)
      .executeTakeFirst();
    if (!run) throw new NotFoundError(`Action proposal "${approvalId}" does not exist.`);

    if (run.initiated_by_user_id === userId) return;

    if (run.conversation_id === null) {
      throw new NotFoundError(`Action proposal "${approvalId}" does not exist.`);
    }

    const conversation = await this.database.db
      .selectFrom('ai_agent_conversations')
      .select(['owner_user_id'])
      .where('id', '=', run.conversation_id)
      .executeTakeFirst();
    if (!conversation || conversation.owner_user_id !== userId) {
      throw new NotFoundError(`Action proposal "${approvalId}" does not exist.`);
    }
  }

  private toView(view: ApprovalView): CRMChatActionView {
    return {
      id: view.id,
      runId: view.runId,
      agentName: view.agentName,
      agentVersion: view.agentVersion,
      toolKey: view.toolKey,
      actionClass: view.actionClass,
      riskLevel: view.riskLevel,
      summary: view.summary,
      proposal: view.proposal,
      targets: view.targets,
      status: view.status,
      decidedByUserId: view.decidedByUserId,
      decidedAt: view.decidedAt,
      decisionNote: view.decisionNote,
      // A proposal can only be acted on while it is pending and unexpired; the SPA renders the
      // controls from this flag rather than guessing from the timestamp.
      actionable: view.status === 'pending' && new Date(view.expiresAt).getTime() > Date.now(),
      expiresAt: view.expiresAt,
      createdAt: view.createdAt,
    };
  }
}
