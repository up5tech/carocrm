import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { type AIToolDefinition, AIToolRegistry, type AIToolResult } from '../ai-agents/ai-agent-tools.js';
import { DatabaseService } from '../database/database.service.js';
import { CustomerSuccessHealthService } from './customer-success-health.service.js';

/**
 * Phase 19-CHAT.23 — `crm_customer_health`, contributed by the module that owns the service
 * (plans/PLAN_Phase_19_CRM_Chat.md §17 `19-CHAT.23`; `plans/SPEC.md` §9.4).
 *
 * A thin wrapper over `CustomerSuccessHealthService.explanation()`. It returns the profile's score,
 * status, override, coverage, trend and the component breakdown that explains the number — the same
 * values the health dashboard shows. No second health model is derived here. The agent may reference a
 * `profileId` directly or an `accountId`, in which case the profile is resolved first.
 */

const CustomerHealthArgumentsSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120).optional(),
    accountId: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((data) => data.profileId !== undefined || data.accountId !== undefined, {
    message: 'Either profileId or accountId is required.',
  });

@Injectable()
export class CustomerSuccessToolContribution implements OnModuleInit {
  constructor(
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(CustomerSuccessHealthService) private readonly health: CustomerSuccessHealthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onModuleInit(): void {
    if (this.tools.has('crm_customer_health')) return;
    this.tools.register(this.definition());
  }

  private definition(): AIToolDefinition {
    return {
      key: 'crm_customer_health',
      label: 'Explain customer health',
      description:
        'Return a customer success profile\'s health score, status, override, coverage and the component breakdown that explains it. Use it to answer "which customers are at risk of churning" or "why is this account unhealthy". Pass a profileId, or an accountId to resolve the profile first.',
      version: '1',
      owningModule: 'CustomerSuccess',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: ['CustomerSuccessProfile'],
      inputSchema: CustomerHealthArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profileId: { type: 'string', maxLength: 120 },
          accountId: { type: 'string', maxLength: 120 },
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 10_000,
      execute: (args) => this.run(args),
    };
  }

  private async run(raw: unknown): Promise<AIToolResult> {
    const args = CustomerHealthArgumentsSchema.parse(raw);
    const profileId = await this.resolveProfileId(args);
    const view = await this.health.explanation(profileId);

    return {
      summary: `CustomerSuccessProfile ${view.profileId}: health ${String(view.score)} (${view.effectiveStatus}); coverage ${String(view.coverage)}.`,
      result: {
        profileId: view.profileId,
        accountId: view.accountId,
        score: view.score,
        status: view.status,
        effectiveStatus: view.effectiveStatus,
        override: view.override,
        coverage: view.coverage,
        calculatedAt: view.calculatedAt,
        trend: view.trend,
        components: view.components.map((component) => ({
          key: component.key,
          label: component.label,
          weight: component.weight,
          score: component.score,
          applicability: component.applicability,
          contribution: component.contribution,
          available: component.available,
          explanationCode: component.explanationCode,
        })),
      },
      resultRef: `CustomerSuccessProfile:${view.profileId}`,
    };
  }

  /** Resolve the profile: directly when given, or by looking up the profile owned by the account. */
  private async resolveProfileId(args: z.infer<typeof CustomerHealthArgumentsSchema>): Promise<string> {
    if (args.profileId !== undefined) return args.profileId;
    const accountId = args.accountId as string;
    const row = await this.database.db
      .selectFrom('entity_records')
      .select(['id', 'attrs'])
      .where('entity_type', '=', 'CustomerSuccessProfile')
      .where('deleted_at', 'is', null)
      .where(sql`attrs ->> 'accountId'`, '=', accountId)
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ValidationError(`No CustomerSuccessProfile is linked to account "${accountId}".`, {
        accountId,
      });
    }
    return row.id;
  }
}
