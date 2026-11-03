import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { type AIToolDefinition, AIToolRegistry, type AIToolResult } from '../ai-agents/ai-agent-tools.js';
import { LeadScoreExplanationService, MAX_HISTORY_PAGE } from './lead-score-explanation.service.js';

/**
 * Phase 19-CHAT.23 — `crm_lead_score`, contributed by the module that owns the service
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.23`; `plans/SPEC.md` §9.4).
 *
 * A thin wrapper over `LeadScoreExplanationService.score()` (and `.history()` when asked). It returns
 * exactly the owning service's values — no re-derived score, no second freshness model — so the number
 * the chat shows and the number the Lead screen shows can never disagree. The service already enforces
 * record ACL and the `viewScore` / `scoring` gate on the caller's scope; the tool adds only a schema,
 * a bound and a summary.
 */

const LeadScoreArgumentsSchema = z
  .object({
    leadId: z.string().trim().min(1).max(120),
    /** How many history entries to return. `0` (default) returns none. */
    historyLimit: z.number().int().min(0).max(MAX_HISTORY_PAGE).optional(),
  })
  .strict();

const MAX_HISTORY_IN_TOOL = MAX_HISTORY_PAGE;

@Injectable()
export class LeadScoreToolContribution implements OnModuleInit {
  constructor(
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(LeadScoreExplanationService) private readonly leadScore: LeadScoreExplanationService,
  ) {}

  onModuleInit(): void {
    if (this.tools.has('crm_lead_score')) return;
    this.tools.register(this.definition());
  }

  private definition(): AIToolDefinition {
    return {
      key: 'crm_lead_score',
      label: 'Explain a lead score',
      description:
        'Return a lead\'s current score, its band, how fresh the score is, and the rule-level breakdown that explains why it is hot or cold. Optionally include the scoring history. Use it to answer "why is this lead scored X" or "which leads are heating up".',
      version: '1',
      owningModule: 'LeadScore',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: ['Lead'],
      inputSchema: LeadScoreArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['leadId'],
        properties: {
          leadId: { type: 'string', maxLength: 120 },
          historyLimit: { type: 'integer', minimum: 0, maximum: MAX_HISTORY_IN_TOOL },
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 10_000,
      execute: (args) => this.run(args),
    };
  }

  private async run(raw: unknown): Promise<AIToolResult> {
    const args = LeadScoreArgumentsSchema.parse(raw);
    const view = await this.leadScore.score(args.leadId);

    const result: Record<string, unknown> = {
      leadId: view.leadId,
      scored: view.scored,
      score: view.score,
      freshness: view.freshness,
      explanation: {
        reasonCodes: view.explanation.reasonCodes,
        breakdown: view.explanation.breakdown,
        errorCodes: view.explanation.errorCodes,
        signalState: view.explanation.signalState,
      },
      actions: view.actions,
    };

    if (args.historyLimit && args.historyLimit > 0) {
      result.history = await this.leadScore.history(args.leadId, args.historyLimit);
    }

    return {
      summary: view.scored
        ? `Lead ${view.leadId}: score ${String(view.score.value)} (${view.score.band}); ${view.freshness.label}.`
        : `Lead ${view.leadId} has not been scored.`,
      result,
      resultRef: `Lead:${view.leadId}`,
    };
  }
}
