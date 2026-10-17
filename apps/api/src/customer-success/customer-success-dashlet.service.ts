import { Inject, Injectable } from "@nestjs/common";

import type { PortfolioQueue } from "./customer-success-domain.js";
import { CustomerSuccessPortfolioService } from "./customer-success-portfolio.service.js";

/**
 * Phase 19-CS.13 — the Customer Success dashlet catalogue
 * (PLAN_Phase_19_Customer_Success.md §5.12, §8.2).
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

@Injectable()
export class CustomerSuccessDashletService {
  constructor(@Inject(CustomerSuccessPortfolioService) private readonly portfolio: CustomerSuccessPortfolioService) {}

  definitions(): readonly CustomerSuccessDashletDefinition[] {
    return CUSTOMER_SUCCESS_DASHLET_DEFINITIONS;
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
