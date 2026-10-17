import { Injectable } from "@nestjs/common";

import {
  dayDifference,
  dayValue,
  lastMeaningfulTouchAt,
  renewalWindow,
  riskComponentScore,
  type SignalApplicability,
  text,
  type TouchCandidate,
  type TouchEntity,
} from "./customer-success-domain.js";
import type { CustomerSuccessRow } from "./customer-success-records.js";
import type { CustomerSuccessSettings } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.4 — health signal providers (PLAN_Phase_19_Customer_Success.md §5.4.2).
 *
 * Each provider is a pure function over a `HealthFacts` bundle the health service loads **once**, so
 * scoring never becomes an N+1 query and stays unit-testable without a database. In particular:
 *
 *  - a provider backed by an optional module that is not installed reports `missing` with the
 *    `unavailable` explanation — the family stays visible in health configuration without behaving
 *    like a failure (§12.6, §13.12);
 *  - a provider never returns `0` for data it simply does not have: no data is `missing` (§5.4.3).
 *
 * Explanations carry only a machine code, a short human-safe label and, at most, an identifier of a
 * permitted source record — never an activity body or customer content (§9.4).
 */

export interface HealthFacts {
  readonly accountId: string;
  readonly profile: CustomerSuccessRow;
  /** Live Contacts that belong to the account. */
  readonly contacts: readonly CustomerSuccessRow[];
  /** Live Task/Call/Meeting/Email records linked to the account or its contacts. */
  readonly activities: readonly CustomerSuccessRow[];
  /** Active (and recently completed) success plans of the profile. */
  readonly plans: readonly CustomerSuccessRow[];
  /** Goals that belong to the profile, across its plans. */
  readonly goals: readonly CustomerSuccessRow[];
  /** Open risks of the profile. */
  readonly risks: readonly CustomerSuccessRow[];
  /** Steps of the active onboarding playbook run, when there is one. */
  readonly onboardingSteps: readonly CustomerSuccessRow[];
  /** Whether a commercial renewal source (Subscription) exists in the metadata registry. */
  readonly subscriptionSourceAvailable: boolean;
}

export interface HealthSignalResult {
  readonly key: string;
  readonly applicability: SignalApplicability;
  readonly score: number | null;
  readonly measuredAt: string | null;
  readonly explanationCode: string;
  /** Short, non-sensitive detail safe to show a user. */
  readonly detail: string | null;
  readonly source: { readonly entity: string; readonly id: string } | null;
}

export interface HealthSignalProvider {
  readonly key: string;
  readonly label: string;
  /** Whether the provider's data source is present in this installation. */
  readonly available: boolean;
  collect(facts: HealthFacts, settings: CustomerSuccessSettings, now: Date): HealthSignalResult;
}

function missing(
  key: string,
  explanationCode: string,
  detail: string | null = null,
): HealthSignalResult {
  return { key, applicability: "missing", score: null, measuredAt: null, explanationCode, detail, source: null };
}

function failed(key: string, explanationCode: string, detail: string | null = null): HealthSignalResult {
  return { key, applicability: "failed", score: null, measuredAt: null, explanationCode, detail, source: null };
}

function applicable(
  key: string,
  score: number,
  explanationCode: string,
  detail: string | null,
  measuredAt: string | null,
  source: { entity: string; id: string } | null = null,
): HealthSignalResult {
  return {
    key,
    applicability: "applicable",
    score: Math.max(0, Math.min(100, Math.round(score))),
    measuredAt,
    explanationCode,
    detail,
    source,
  };
}

function touchCandidateOf(row: CustomerSuccessRow): TouchCandidate | null {
  const type = activityEntityOf(row.entityType);
  if (type === null) return null;
  return {
    entity: type,
    status: text(row.data["status"]) ?? null,
    linkedToCustomer: true,
    completedAt: isoOf(row.data["completedAt"]) ?? null,
    createdAt: isoOf(row.data["dateStart"]) ?? isoOf(row.data["createdAt"]) ?? null,
  };
}

function activityEntityOf(value: string): TouchEntity | null {
  if (value === "Task" || value === "Call" || value === "Meeting" || value === "Email") return value;
  return null;
}

function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  const raw = text(value);
  return raw === undefined ? undefined : raw;
}

function maxIso(values: readonly (string | null | undefined)[]): string | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

// ---------------------------------------------------------------------------
// Engagement: time since the last qualifying customer-facing activity (§5.4.2)
// ---------------------------------------------------------------------------

export class EngagementSignalProvider implements HealthSignalProvider {
  readonly key = "engagement";
  readonly label = "Customer engagement";
  readonly available = true;

  collect(facts: HealthFacts, settings: CustomerSuccessSettings, now: Date): HealthSignalResult {
    const candidates = facts.activities
      .map((activity) => touchCandidateOf(activity))
      .filter((candidate): candidate is TouchCandidate => candidate !== null);
    if (candidates.length === 0) {
      return missing(this.key, "noActivities", "No customer-linked activity has been recorded.");
    }
    const last = lastMeaningfulTouchAt(candidates);
    if (last === null) {
      return applicable(this.key, 20, "noQualifyingTouch", "Activities exist but none is a customer-facing touch.", null);
    }
    const recencyDays = settings.touchpoints.recencyDays;
    const days = dayDifference(last.slice(0, 10), dayValue(now) ?? last.slice(0, 10));
    if (days <= recencyDays) {
      return applicable(this.key, 100, "recentTouch", `Last touch ${String(days)} day(s) ago.`, last);
    }
    const score = 100 - ((days - recencyDays) / (3 * recencyDays)) * 100;
    return applicable(this.key, score, "agingTouch", `Last touch ${String(days)} day(s) ago.`, last);
  }
}

// ---------------------------------------------------------------------------
// Success plan: progress against active goals (§5.4.2)
// ---------------------------------------------------------------------------

export class SuccessPlanSignalProvider implements HealthSignalProvider {
  readonly key = "successPlan";
  readonly label = "Success plan progress";
  readonly available = true;

  collect(facts: HealthFacts, settings: CustomerSuccessSettings, now: Date): HealthSignalResult {
    if (!settings.features.successPlans || !settings.features.goals) {
      return missing(this.key, "featureDisabled", "Success plans or goals are disabled.");
    }
    const activePlans = facts.plans.filter((plan) => text(plan.data["status"]) === "active");
    if (activePlans.length === 0) {
      return missing(this.key, "noActivePlan", "No active success plan.");
    }
    const planIds = new Set(activePlans.map((plan) => plan.id));
    const goals = facts.goals.filter((goal) => planIds.has(text(goal.data["planId"]) ?? ""));
    if (goals.length === 0) {
      return missing(this.key, "noGoals", "The active plan has no goals.");
    }
    const today = dayValue(now) ?? new Date().toISOString().slice(0, 10);
    let total = 0;
    let overdue = 0;
    for (const goal of goals) {
      const progress = numeric(goal.data["progress"]);
      total += progress ?? 0;
      const targetDate = dayValue(goal.data["targetDate"]);
      const status = text(goal.data["status"]) ?? "";
      if (targetDate !== undefined && targetDate < today && status !== "achieved" && status !== "canceled") {
        overdue += 1;
      }
    }
    const average = total / goals.length;
    const score = average - overdue * 20;
    const measuredAt = maxIso(goals.map((goal) => isoOf(goal.data["progressAt"]) ?? isoOf(goal.data["modifiedAt"]) ?? null));
    return applicable(
      this.key,
      score,
      overdue > 0 ? "goalsOverdue" : "goalsOnTrack",
      `${String(goals.length)} goal(s), ${String(overdue)} overdue.`,
      measuredAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Relationship coverage: active contacts and an executive sponsor (§5.4.2)
// ---------------------------------------------------------------------------

export class RelationshipSignalProvider implements HealthSignalProvider {
  readonly key = "relationship";
  readonly label = "Relationship coverage";
  readonly available = true;

  collect(facts: HealthFacts, _settings: CustomerSuccessSettings, _now: Date): HealthSignalResult {
    const activeContacts = facts.contacts.filter((contact) => {
      const status = text(contact.data["status"]) ?? "Active";
      return status !== "Left";
    });
    const sponsor = text(facts.profile.data["executiveSponsorContactId"]);
    const coverage = Math.min(activeContacts.length, 3) / 3;
    const score = coverage * 60 + (sponsor !== undefined ? 40 : 0);
    const measuredAt = maxIso(activeContacts.map((contact) => isoOf(contact.data["modifiedAt"]) ?? null));
    return applicable(
      this.key,
      score,
      activeContacts.length === 0 ? "noContacts" : sponsor === undefined ? "noSponsor" : "covered",
      `${String(activeContacts.length)} active contact(s)${sponsor === undefined ? ", no executive sponsor" : ""}.`,
      measuredAt,
      sponsor !== undefined ? { entity: "Contact", id: sponsor } : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Onboarding: completion ratio and blockers (§5.4.2)
// ---------------------------------------------------------------------------

export class OnboardingSignalProvider implements HealthSignalProvider {
  readonly key = "onboarding";
  readonly label = "Onboarding progress";
  readonly available = true;

  collect(facts: HealthFacts, settings: CustomerSuccessSettings, _now: Date): HealthSignalResult {
    if (!settings.features.onboarding) return missing(this.key, "featureDisabled", "Onboarding is disabled.");
    const status = text(facts.profile.data["onboardingStatus"]) ?? "notStarted";
    if (status === "notStarted") return missing(this.key, "notStarted", "Onboarding has not started.");
    if (status === "canceled") return missing(this.key, "canceled", "Onboarding was canceled.");
    if (status === "completed") {
      return applicable(this.key, 100, "completed", "Onboarding is complete.", isoOf(facts.profile.data["onboardingCompletedAt"]) ?? null);
    }
    const steps = facts.onboardingSteps;
    if (steps.length === 0) {
      return applicable(this.key, status === "blocked" ? 25 : 50, status === "blocked" ? "blocked" : "inProgressNoSteps", "Onboarding in progress with no tracked steps.", null);
    }
    const complete = steps.filter((step) => {
      const stepStatus = text(step.data["status"]) ?? "pending";
      return stepStatus === "completed" || stepStatus === "skipped";
    }).length;
    const ratio = complete / steps.length;
    const score = status === "blocked" ? ratio * 60 : ratio * 100;
    const measuredAt = maxIso(steps.map((step) => isoOf(step.data["modifiedAt"]) ?? null));
    return applicable(
      this.key,
      score,
      status === "blocked" ? "blocked" : "inProgress",
      `${String(complete)}/${String(steps.length)} onboarding step(s) done.`,
      measuredAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Risks: open severity, age and overdue mitigations (§5.4.2)
// ---------------------------------------------------------------------------

export class RisksSignalProvider implements HealthSignalProvider {
  readonly key = "risks";
  readonly label = "Open risks";
  readonly available = true;

  collect(facts: HealthFacts, settings: CustomerSuccessSettings, now: Date): HealthSignalResult {
    if (!settings.features.risks) return missing(this.key, "featureDisabled", "Risks are disabled.");
    const today = dayValue(now) ?? new Date().toISOString().slice(0, 10);
    const contributing = facts.risks.filter((risk) => risk.data["contributesToHealth"] !== false);
    const score = riskComponentScore(
      contributing.map((risk) => ({
        severity: text(risk.data["severity"]) ?? "medium",
        status: text(risk.data["status"]) ?? "open",
        targetResolutionDate: dayValue(risk.data["targetResolutionDate"]) ?? null,
      })),
      today,
    );
    const open = contributing.filter((risk) => {
      const status = text(risk.data["status"]) ?? "open";
      return status !== "resolved" && status !== "closed" && status !== "accepted";
    });
    const measuredAt = maxIso(contributing.map((risk) => isoOf(risk.data["modifiedAt"]) ?? null));
    return applicable(
      this.key,
      score,
      open.length === 0 ? "noOpenRisks" : "openRisks",
      `${String(open.length)} open risk(s).`,
      measuredAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Renewal: horizon and renewal risk from the profile or a detected source (§5.4.2)
// ---------------------------------------------------------------------------

export class RenewalSignalProvider implements HealthSignalProvider {
  readonly key = "renewal";
  readonly label = "Renewal readiness";
  readonly available = true;

  collect(facts: HealthFacts, settings: CustomerSuccessSettings, now: Date): HealthSignalResult {
    if (!settings.features.renewalReadiness) return missing(this.key, "featureDisabled", "Renewal readiness is disabled.");
    const renewalDate = dayValue(facts.profile.data["renewalDate"]);
    if (renewalDate === undefined) return missing(this.key, "noRenewalDate", "No renewal date is known.");
    const today = dayValue(now) ?? new Date().toISOString().slice(0, 10);
    const window = renewalWindow(renewalDate, today, settings.renewal.windows);
    if (window === null) return missing(this.key, "noRenewalDate", "No renewal date is known.");
    const status = text(facts.profile.data["renewalStatus"]) ?? "unknown";
    let score = 100;
    if (window.overdue) score = 30;
    else if (window.windowDays !== null) score = 70;
    if (status === "atRisk") score = Math.min(score, 40);
    if (status === "preparing" || status === "inProgress") score = Math.max(score, 60);
    if (status === "renewed") score = 100;
    if (status === "churned") score = 0;
    const measuredAt = isoOf(facts.profile.data["renewalSyncedAt"]) ?? null;
    const source = facts.subscriptionSourceAvailable
      ? { entity: "Subscription", id: facts.accountId }
      : null;
    return applicable(
      this.key,
      score,
      window.overdue ? "renewalOverdue" : window.windowDays !== null ? "inRenewalWindow" : "notDue",
      `${String(window.daysToRenewal)} day(s) to renewal.`,
      measuredAt,
      source,
    );
  }
}

// ---------------------------------------------------------------------------
// Unavailable families — kept visible, reported as unavailable, never as failed (§12.6, §12.7)
// ---------------------------------------------------------------------------

export class AdoptionSignalProvider implements HealthSignalProvider {
  readonly key = "adoption";
  readonly label = "Product adoption";
  readonly available = false;

  collect(): HealthSignalResult {
    return missing(
      this.key,
      "unavailable",
      "No adoption-analytics connector is installed; adoption is tracked manually.",
    );
  }
}

export class SupportSignalProvider implements HealthSignalProvider {
  readonly key = "support";
  readonly label = "Support health";
  readonly available = false;

  collect(): HealthSignalResult {
    return missing(
      this.key,
      "unavailable",
      "No Service Desk module is installed; support signals are unavailable.",
    );
  }
}

/**
 * The provider registry (§7.1 `HealthSignalRegistry`). A configured signal key with no registered
 * provider is reported as `missing`/`unknownSignal` rather than failing the score.
 */
@Injectable()
export class HealthSignalRegistry {
  private readonly providers = new Map<string, HealthSignalProvider>();

  constructor() {
    for (const provider of [
      new EngagementSignalProvider(),
      new SuccessPlanSignalProvider(),
      new RelationshipSignalProvider(),
      new OnboardingSignalProvider(),
      new RisksSignalProvider(),
      new RenewalSignalProvider(),
      new AdoptionSignalProvider(),
      new SupportSignalProvider(),
    ]) {
      this.register(provider);
    }
  }

  register(provider: HealthSignalProvider): void {
    this.providers.set(provider.key, provider);
  }

  get(key: string): HealthSignalProvider | undefined {
    return this.providers.get(key);
  }

  list(): HealthSignalProvider[] {
    return [...this.providers.values()];
  }

  collect(
    key: string,
    facts: HealthFacts,
    settings: CustomerSuccessSettings,
    now: Date,
  ): HealthSignalResult {
    const provider = this.providers.get(key);
    if (provider === undefined) return missing(key, "unknownSignal", null);
    try {
      return provider.collect(facts, settings, now);
    } catch (error: unknown) {
      return failed(key, "providerError", error instanceof Error ? error.message.slice(0, 200) : null);
    }
  }
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
