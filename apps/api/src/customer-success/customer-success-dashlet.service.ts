import { ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import type { PortfolioQueue } from "./customer-success-domain.js";
import { CustomerSuccessPortfolioService } from "./customer-success-portfolio.service.js";

/**
 * Phase 19-CS.13 — the Customer Success dashlet catalogue
 * (plans/PLAN_Phase_19_Customer_Success.md §5.12, §8.2).
 *
 * The platform's dashboard framework already renders an entity-list dashlet plus chart/kpi kinds over
 * any metadata entity, so the module contributes *definitions* (the machine-readable description of
 * each suggested view) and a scoped runner for the portfolio queues. Every row it returns comes from
 * `CustomerSuccessPortfolioService`, which applies record ACL before returning anything, so a shared
 * dashlet can only ever show what its reader could open in the portfolio.
 */

export interface CustomerSuccessDashletDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** The queue this definition maps to, when it is a portfolio view. */
  readonly queue?: PortfolioQueue;
  /** The metadata entity a plain list/chart dashlet would use. */
  readonly entity?: string;
  readonly kind: "portfolioQueue" | "entityList" | "trend";
}

export const CUSTOMER_SUCCESS_DASHLET_DEFINITIONS: readonly CustomerSuccessDashletDefinition[] = [
  { key: "portfolioHealthDistribution", label: "My portfolio health", description: "Health distribution across your portfolio.", kind: "trend" },
  { key: "fallingHealth", label: "Customers with falling health", description: "Profiles whose score trend is declining.", kind: "trend" },
  { key: "atRiskNoAction", label: "At-risk customers with no next action", description: "At-risk and critical profiles.", queue: "atRiskHealth", kind: "portfolioQueue" },
  { key: "criticalHealth", label: "Critical customers", description: "Profiles with critical health.", queue: "criticalHealth", kind: "portfolioQueue" },
  { key: "onboardingNow", label: "Onboarding in progress", description: "Profiles onboarding now.", queue: "onboardingNow", kind: "portfolioQueue" },
  { key: "onboardingOverdue", label: "Onboarding overdue", description: "Profiles whose onboarding target date has passed.", queue: "onboardingOverdue", kind: "portfolioQueue" },
  { key: "upcomingRenewals", label: "Upcoming renewals", description: "Profiles inside a configured renewal window.", queue: "upcomingRenewals", kind: "portfolioQueue" },
  { key: "unassignedProfiles", label: "Unassigned profiles", description: "Profiles without a CSM.", queue: "unassigned", kind: "portfolioQueue" },
  { key: "missingPlan", label: "Customers without a success plan", description: "Profiles with no active plan.", queue: "missingPlan", kind: "portfolioQueue" },
  { key: "missingReview", label: "Customers missing a next review", description: "Profiles with no scheduled success review.", queue: "missingNextReview", kind: "portfolioQueue" },
  { key: "openRisks", label: "Open risks", description: "Open customer success risks by severity.", entity: "CustomerSuccessRisk", kind: "entityList" },
  { key: "successPlans", label: "Success plans", description: "Active success plans.", entity: "CustomerSuccessPlan", kind: "entityList" },
];

export const CustomerSuccessDashletConfigSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

@Injectable()
export class CustomerSuccessDashletService {
  constructor(@Inject(CustomerSuccessPortfolioService) private readonly portfolio: CustomerSuccessPortfolioService) {}

  definitions(): readonly CustomerSuccessDashletDefinition[] {
    return CUSTOMER_SUCCESS_DASHLET_DEFINITIONS;
  }

  /**
   * The options a Customer Success dashlet carries (19-CS.13).
   *
   * A dashlet names one catalogue entry by key; it is not a free-form entity/measure pair, so a dashlet
   * can never become a second query surface the module has not bounded. The key itself is checked against
   * the catalogue in `assertConfig`, which is what keeps this schema and the list above from drifting.
   */
  assertConfig(raw: unknown): { key: string; limit: number } {
    const parsed = CustomerSuccessDashletConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError('Invalid Customer Success dashlet options.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    const definition = CUSTOMER_SUCCESS_DASHLET_DEFINITIONS.find((entry) => entry.key === parsed.data.key);
    if (definition === undefined || definition.kind === 'entityList') {
      throw new ValidationError(`Unknown Customer Success dashlet "${parsed.data.key}".`, {
        dashlets: CUSTOMER_SUCCESS_DASHLET_DEFINITIONS.filter((entry) => entry.kind !== 'entityList').map((entry) => entry.key),
      });
    }
    return { key: parsed.data.key, limit: parsed.data.limit };
  }

  /** Run one catalogue entry under the reader's own record scope. */
  async run(key: string, limit: number): Promise<Record<string, unknown>> {
    const definition = CUSTOMER_SUCCESS_DASHLET_DEFINITIONS.find((entry) => entry.key === key);
    if (definition === undefined) throw new ValidationError(`Unknown Customer Success dashlet "${key}".`);
    if (definition.kind === 'trend') {
      return { dashletKey: definition.key, label: definition.label, view: 'summary', ...(await this.runSummary()) };
    }
    const queue = definition.queue;
    if (queue === undefined) throw new ValidationError(`Customer Success dashlet "${key}" names no portfolio queue.`);
    const result = await this.runPortfolio(queue, limit);
    return { dashletKey: definition.key, label: definition.label, view: 'queue', ...result };
  }

  /** Run a portfolio-queue dashlet, ACL-scoped and bounded. */
  async runPortfolio(queue: PortfolioQueue, limit: number, offset = 0) {
    return this.portfolio.queue(queue, { limit, offset });
  }

  /** Run a trend dashlet from the portfolio aggregate. */
  async runSummary() {
    return this.portfolio.summary();
  }
}
