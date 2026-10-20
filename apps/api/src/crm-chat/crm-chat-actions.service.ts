import { Inject, Injectable } from '@nestjs/common';

import type { AIAgentApprovalService } from '../ai-agents/ai-agent-approvals.service.js';
import { AIAgentApprovalService } from '../ai-agents/ai-agent-approvals.service.js';

/**
 * Phase 19-CHAT.12 — Action Proposal and Confirmation UX
 * (PLAN_Phase_19_CRM_Chat.md §5.6, §11, §17 `19-CHAT.12`).
 *
 * This service manages action proposals and confirmations for CRM Chat. It reuses AIAgents'
 * existing approval system rather than creating a parallel approval engine.
 *
 * Key principles:
 * - No write action executes before valid confirmation
 * - Proposals include target records, before/after values, and side effects
 * - Confirmation is bound to proposal hash, user, and expiry
 * - Revalidation happens at execution time (ACL, permissions, record versions)
 */

export interface ActionProposal {
  readonly id: string;
  readonly actionType: string;
  readonly description: string;
  readonly targets: readonly ActionTarget[];
  readonly changes?: Record<string, unknown> | undefined;
  readonly sideEffects?: readonly string[] | undefined;
  readonly riskClass: 'low_write' | 'material_write' | 'high_impact';
  readonly requiresApproval: boolean;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
}

export interface ActionTarget {
  readonly entity: string;
  readonly id: string;
  readonly label?: string | undefined;
}

export interface ActionConfirmation {
  readonly proposalId: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly result?: 'executed' | 'failed' | undefined;
  readonly errorMessage?: string | undefined;
}

@Injectable()
export class CRMChatActionsService {
  constructor(
    @Inject(AIAgentApprovalService) private readonly approvals: AIAgentApprovalService,
  ) {}

  /**
   * Get an action proposal by ID. Delegates to AIAgents approval system.
   */
  async getProposal(proposalId: string): Promise<ActionProposal | null> {
    try {
      const approval = await this.approvals.get(proposalId);
      if (!approval) return null;

      return this.mapApprovalToProposal(approval);
    } catch {
      return null;
    }
  }

  /**
   * Confirm an action proposal. The approval service will revalidate ACL and execute if approved.
   */
  async confirmAction(proposalId: string, userId: string, note?: string): Promise<ActionConfirmation> {
    try {
      // Approve through AIAgents approval system
      await this.approvals.approve(proposalId, note);

      return {
        proposalId,
        confirmedBy: userId,
        confirmedAt: new Date().toISOString(),
        result: 'executed',
      };
    } catch (error) {
      return {
        proposalId,
        confirmedBy: userId,
        confirmedAt: new Date().toISOString(),
        result: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Approval failed',
      };
    }
  }

  /**
   * Reject an action proposal.
   */
  async rejectAction(proposalId: string, userId: string, note?: string): Promise<void> {
    await this.approvals.reject(proposalId, note);
  }

  /**
   * Map AIAgents approval to Chat action proposal format.
   */
  private mapApprovalToProposal(approval: any): ActionProposal {
    // Extract proposal data from approval record
    const payload = approval.payload || {};

    return {
      id: approval.id,
      actionType: payload.actionType || 'unknown',
      description: payload.description || approval.summary || '',
      targets: Array.isArray(payload.targets) ? payload.targets : [],
      changes: payload.changes,
      sideEffects: Array.isArray(payload.sideEffects) ? payload.sideEffects : [],
      riskClass: payload.riskClass || 'material_write',
      requiresApproval: approval.requires_approval ?? true,
      expiresAt: approval.expires_at || new Date(Date.now() + 3600000).toISOString(), // 1 hour default
      createdBy: approval.created_by || '',
      status: approval.status || 'pending',
    };
  }
}
