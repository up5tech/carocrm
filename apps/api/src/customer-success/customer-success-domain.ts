/**
 * Phase 19-CS — Customer Success pure domain rules (PLAN_Phase_19_Customer_Success.md §5, §13).
 *
 * Nothing in this file touches Nest, the database or the request scope: every rule is a function
 * over plain values, so lifecycle policy, health scoring, goal progress, risk transitions, playbook
 * validation, renewal windows and meaningful-touch qualification can be unit-tested directly
 * (§15.1) and reused by the services, the jobs and the projections.
 *
 * The health engine in particular is deliberately a pure function: PLAN §5.4.3 requires the score
 * to be "a pure, deterministic domain calculation" that "must be unit-testable without a database,
 * must never execute user-authored SQL or JavaScript, and must never let a missing signal be scored
 * as zero".
 */

import { ValidationError } from "@carocrm/core/errors/index.js";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Configurable lifecycle stage keys; ship with these validated defaults (§5.3). */
export const LIFECYCLE_STAGES = [
  "onboarding",
  "adoption",
  "valueRealization",
  "mature",
  "renewal",
  "atRisk",
  "churned",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Default allowed transitions. `churned` is terminal by default: PLAN §13.7 forbids inferring it
 * from a score, a missing subscription, a missing opportunity or a Critical risk, and reopening a
 * churned account is a separate, explicit decision an administrator configures. An administrator
 * may override this map entirely through settings.
 */
export const DEFAULT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<LifecycleStage, readonly LifecycleStage[]>
> = {
  onboarding: ["adoption", "atRisk", "churned"],
  adoption: ["valueRealization", "mature", "atRisk", "churned"],
  valueRealization: ["mature", "renewal", "atRisk", "churned"],
  mature: ["renewal", "atRisk", "churned"],
  renewal: ["mature", "atRisk", "churned"],
  atRisk: ["onboarding", "adoption", "valueRealization", "mature", "renewal", "churned"],
  churned: [],
};

/** Stages whose transitions require a reason (§5.3 "important transitions such as to churned"). */
export const LIFECYCLE_REASON_REQUIRED: readonly LifecycleStage[] = ["churned", "atRisk"];

export function isLifecycleStage(value: string): value is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(value);
}

export interface LifecycleTransitionInput {
  readonly from: string;
  readonly to: string;
  readonly reason?: string | undefined;
  readonly transitions?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly reasonRequired?: readonly string[] | undefined;
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Validate a lifecycle transition server-side (§5.3 "validate transitions server-side"). A no-op
 * transition is allowed and changes nothing; every other move must be one of the configured edges,
 * and a move to a stage in `reasonRequired` must carry a non-empty reason.
 */
export function checkLifecycleTransition(
  input: LifecycleTransitionInput,
): TransitionCheck {
  if (!isLifecycleStage(input.from) || !isLifecycleStage(input.to)) {
    return {
      allowed: false,
      code: "invalidLifecycleStage",
      message: `Unknown lifecycle stage (from "${input.from}" to "${input.to}").`,
    };
  }
  if (input.from === input.to) return { allowed: true };
  const map = input.transitions ?? DEFAULT_LIFECYCLE_TRANSITIONS;
  const allowed = map[input.from] ?? [];
  if (!allowed.includes(input.to)) {
    return {
      allowed: false,
      code: "invalidTransition",
      message: `Lifecycle cannot move from "${input.from}" to "${input.to}".`,
    };
  }
  const reasonRequired = input.reasonRequired ?? LIFECYCLE_REASON_REQUIRED;
  if (reasonRequired.includes(input.to) && (input.reason ?? "").trim() === "") {
    return {
      allowed: false,
      code: "reasonRequired",
      message: `Moving to "${input.to}" requires a reason.`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Health scoring (§5.4)
// ---------------------------------------------------------------------------

export const HEALTH_STATUSES = [
  "healthy",
  "monitor",
  "atRisk",
  "critical",
  "unknown",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthThresholdBand {
  readonly status: Exclude<HealthStatus, "unknown">;
  readonly min: number;
  readonly max: number;
}

/** Default bands: healthy 80–100, monitor 60–79, atRisk 40–59, critical 0–39 (§5.4.1). */
export const DEFAULT_HEALTH_THRESHOLDS: readonly HealthThresholdBand[] = [
  { status: "critical", min: 0, max: 39 },
  { status: "atRisk", min: 40, max: 59 },
  { status: "monitor", min: 60, max: 79 },
  { status: "healthy", min: 80, max: 100 },
];

/**
 * Validate threshold configuration: bands must be integral, inside 0–100, non-overlapping, and
 * together cover the whole range with no gaps (§5.4.1 "must guarantee coverage … no gaps and no
 * overlaps").
 */
export function validateHealthThresholds(
  bands: readonly HealthThresholdBand[],
): string[] {
  const issues: string[] = [];
  if (bands.length === 0) {
    issues.push("At least one health threshold band is required.");
    return issues;
  }
  const seen = new Set<string>();
  for (const band of bands) {
    if (seen.has(band.status)) issues.push(`Threshold band "${band.status}" is defined twice.`);
    seen.add(band.status);
    if (!Number.isInteger(band.min) || !Number.isInteger(band.max)) {
      issues.push(`Threshold band "${band.status}" must use whole numbers.`);
    }
    if (band.min < 0 || band.max > 100) {
      issues.push(`Threshold band "${band.status}" must lie within 0–100.`);
    }
    if (band.min > band.max) {
      issues.push(`Threshold band "${band.status}" has min greater than max.`);
    }
  }
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  if (sorted[0]?.min !== 0) issues.push("Health thresholds must start at 0.");
  if (sorted[sorted.length - 1]?.max !== 100) {
    issues.push("Health thresholds must reach 100.");
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current && current.min !== previous.max + 1) {
      issues.push(
        `Threshold bands "${previous.status}" and "${current.status}" do not tile 0–100 without gaps or overlaps.`,
      );
    }
  }
  return issues;
}

export function classifyHealth(
  score: number | null,
  bands: readonly HealthThresholdBand[] = DEFAULT_HEALTH_THRESHOLDS,
): HealthStatus {
  if (score === null || !Number.isFinite(score)) return "unknown";
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  for (const band of bands) {
    if (clamped >= band.min && clamped <= band.max) return band.status;
  }
  return "unknown";
}

/** How missing or stale inputs are handled (§5.4.3). Never "score the missing data as zero". */
export const MISSING_DATA_POLICIES = [
  "excludeAndRenormalize",
  "unknownWhenIncomplete",
] as const;
export type MissingDataPolicy = (typeof MISSING_DATA_POLICIES)[number];

export const ROUNDING_POLICIES = ["round", "floor", "ceil"] as const;
export type RoundingPolicy = (typeof ROUNDING_POLICIES)[number];

export type SignalApplicability = "applicable" | "missing" | "stale" | "failed";

export interface HealthSignalInput {
  readonly key: string;
  /** Weight in the active configuration; non-negative. */
  readonly weight: number;
  readonly applicability: SignalApplicability;
  /** 0–100 when `applicable`; otherwise ignored. */
  readonly score?: number | null | undefined;
  readonly measuredAt?: string | null | undefined;
  readonly freshnessWindowMs?: number | null | undefined;
}

export interface HealthComponentResult {
  readonly key: string;
  readonly weight: number;
  readonly score: number | null;
  readonly applicability: SignalApplicability;
  /** `weight` share of the *valid* weight, 0 when the signal did not contribute. */
  readonly contribution: number | null;
  readonly measuredAt: string | null;
}

export interface HealthCalculationInput {
  readonly signals: readonly HealthSignalInput[];
  readonly bands?: readonly HealthThresholdBand[] | undefined;
  readonly minimumCoverage?: number | undefined;
  readonly missingDataPolicy?: MissingDataPolicy | undefined;
  readonly rounding?: RoundingPolicy | undefined;
  readonly now?: Date | undefined;
}

export interface HealthCalculation {
  readonly score: number | null;
  readonly status: HealthStatus;
  /** Share of total configured weight that was valid, 0–1. */
  readonly coverage: number;
  readonly validWeight: number;
  readonly totalWeight: number;
  readonly components: readonly HealthComponentResult[];
}

function applyRounding(value: number, rounding: RoundingPolicy): number {
  if (rounding === "floor") return Math.floor(value);
  if (rounding === "ceil") return Math.ceil(value);
  return Math.round(value);
}

function isStale(
  signal: HealthSignalInput,
  now: Date,
): boolean {
  if (signal.freshnessWindowMs === null || signal.freshnessWindowMs === undefined) return false;
  if (signal.measuredAt === null || signal.measuredAt === undefined) return false;
  const measured = Date.parse(signal.measuredAt);
  if (Number.isNaN(measured)) return false;
  return now.getTime() - measured > signal.freshnessWindowMs;
}

/**
 * Deterministic weighted score (§5.4.3). Only `applicable`, non-stale signals with a numeric score
 * contribute; missing, stale and failed signals are excluded and the remaining weights are
 * renormalized. When the valid share of weight falls below `minimumCoverage` the result is the
 * `unknown` status with a `null` score — never zero. Under `unknownWhenIncomplete` any excluded
 * signal forces `unknown`.
 */
export function computeHealthScore(
  input: HealthCalculationInput,
): HealthCalculation {
  const now = input.now ?? new Date();
  const bands = input.bands ?? DEFAULT_HEALTH_THRESHOLDS;
  const minimumCoverage = clamp01(input.minimumCoverage ?? 0.5);
  const policy = input.missingDataPolicy ?? "excludeAndRenormalize";
  const rounding = input.rounding ?? "round";

  const normalized = input.signals.map((signal) => {
    const weight = Number.isFinite(signal.weight) ? Math.max(0, signal.weight) : 0;
    let applicability = signal.applicability;
    if (applicability === "applicable" && isStale(signal, now)) applicability = "stale";
    const scoreValue =
      applicability === "applicable" && typeof signal.score === "number" && Number.isFinite(signal.score)
        ? Math.max(0, Math.min(100, signal.score))
        : null;
    if (applicability === "applicable" && scoreValue === null) {
      applicability = "missing";
    }
    return { ...signal, weight, applicability, scoreValue };
  });

  const totalWeight = normalized.reduce((sum, signal) => sum + signal.weight, 0);
  const valid = normalized.filter(
    (signal) => signal.applicability === "applicable" && signal.scoreValue !== null,
  );
  const validWeight = valid.reduce((sum, signal) => sum + signal.weight, 0);
  const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
  const excluded = normalized.filter(
    (signal) => signal.applicability !== "applicable",
  ).length;

  const components: HealthComponentResult[] = normalized.map((signal) => ({
    key: signal.key,
    weight: signal.weight,
    score: signal.applicability === "applicable" ? signal.scoreValue : null,
    applicability: signal.applicability,
    contribution:
      signal.applicability === "applicable" && validWeight > 0 && signal.scoreValue !== null
        ? (signal.scoreValue * signal.weight) / validWeight
        : null,
    measuredAt: signal.measuredAt ?? null,
  }));

  if (normalized.length === 0 || valid.length === 0 || totalWeight <= 0) {
    return {
      score: null,
      status: "unknown",
      coverage: 0,
      validWeight: 0,
      totalWeight,
      components,
    };
  }

  const insufficient =
    coverage < minimumCoverage ||
    (policy === "unknownWhenIncomplete" && excluded > 0);
  if (insufficient) {
    return {
      score: null,
      status: "unknown",
      coverage,
      validWeight,
      totalWeight,
      components,
    };
  }

  const weighted = valid.reduce(
    (sum, signal) => sum + (signal.scoreValue ?? 0) * signal.weight,
    0,
  );
  const score = applyRounding(weighted / validWeight, rounding);
  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    status: classifyHealth(bounded, bands),
    coverage,
    validWeight,
    totalWeight,
    components,
  };
}

// ---------------------------------------------------------------------------
// Goal progress (§5.7)
// ---------------------------------------------------------------------------

export const GOAL_DIRECTIONS = [
  "increase",
  "decrease",
  "maintain",
  "boolean",
  "manual",
] as const;
export type GoalDirection = (typeof GOAL_DIRECTIONS)[number];

export const GOAL_STATUSES = [
  "notStarted",
  "inProgress",
  "achieved",
  "missed",
  "canceled",
  "blocked",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalProgressInput {
  readonly direction: string;
  readonly baseline?: number | null | undefined;
  readonly target?: number | null | undefined;
  readonly current?: number | null | undefined;
  readonly tolerance?: number | null | undefined;
  /** For `manual` goals the caller supplies the value directly (0–100). */
  readonly manualProgress?: number | null | undefined;
}

export interface GoalProgressResult {
  readonly progress: number;
  readonly status: Extract<GoalStatus, "notStarted" | "inProgress" | "achieved" | "missed">;
  readonly explanation: string;
}

/**
 * Direction-aware progress, bounded to 0–100 (§5.7, §13.8). `increase` divides by the baseline→target
 * span, `decrease` reverses it, `maintain` scores the drift against a tolerance, `boolean` is binary
 * and `manual` takes a controlled value. Degenerate ranges (target equals baseline, zero denominator)
 * are handled explicitly rather than dividing by zero.
 */
export function computeGoalProgress(input: GoalProgressInput): GoalProgressResult {
  const direction = input.direction;
  if (!(GOAL_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new ValidationError(`Unknown goal direction "${direction}".`, { direction });
  }
  if (direction === "manual") {
    if (typeof input.manualProgress !== "number" || !Number.isFinite(input.manualProgress)) {
      throw new ValidationError("A manual goal requires a numeric progress value.", {});
    }
    const progress = clampPercent(input.manualProgress);
    return {
      progress,
      status: progress >= 100 ? "achieved" : progress <= 0 ? "notStarted" : "inProgress",
      explanation: "Manually recorded progress.",
    };
  }

  const baseline = num(input.baseline);
  const target = num(input.target);
  const current = num(input.current);
  if (target === undefined || current === undefined) {
    throw new ValidationError(
      "A measured goal requires a target and a current value.",
      { direction },
    );
  }

  if (direction === "boolean") {
    const achieved = current >= Math.max(target, 1);
    const progress = achieved ? 100 : 0;
    return {
      progress,
      status: achieved ? "achieved" : "notStarted",
      explanation: achieved ? "Goal met." : "Goal not met yet.",
    };
  }

  if (direction === "increase") {
    if (baseline === undefined) {
      throw new ValidationError("An increase goal requires a baseline value.", { direction });
    }
    const span = target - baseline;
    if (span === 0) {
      const achieved = current >= target;
      return {
        progress: achieved ? 100 : 0,
        status: achieved ? "achieved" : "inProgress",
        explanation: "Target equals baseline; achieved once the current value reaches it.",
      };
    }
    const progress = clampPercent(((current - baseline) / span) * 100);
    return {
      progress,
      status: statusFor(progress, current, target, "increase"),
      explanation: `Progress from ${String(baseline)} toward ${String(target)}.`,
    };
  }

  if (direction === "decrease") {
    if (baseline === undefined) {
      throw new ValidationError("A decrease goal requires a baseline value.", { direction });
    }
    const span = baseline - target;
    if (span === 0) {
      const achieved = current <= target;
      return {
        progress: achieved ? 100 : 0,
        status: achieved ? "achieved" : "inProgress",
        explanation: "Target equals baseline; achieved once the current value falls to it.",
      };
    }
    const progress = clampPercent(((baseline - current) / span) * 100);
    return {
      progress,
      status: statusFor(progress, current, target, "decrease"),
      explanation: `Reduction from ${String(baseline)} toward ${String(target)}.`,
    };
  }

  // maintain: within tolerance is achieved; beyond it degrades against the target magnitude.
  const tolerance = Math.abs(num(input.tolerance) ?? 0);
  const drift = Math.abs(current - target);
  if (drift <= tolerance) {
    return {
      progress: 100,
      status: "achieved",
      explanation: "Within the configured tolerance of the target.",
    };
  }
  const scale = Math.max(Math.abs(target), 1);
  const progress = clampPercent(100 - ((drift - tolerance) / scale) * 100);
  return {
    progress,
    status: progress > 0 ? "inProgress" : "missed",
    explanation: "Drifting outside the configured tolerance of the target.",
  };
}

function statusFor(
  progress: number,
  current: number,
  target: number,
  direction: "increase" | "decrease",
): GoalProgressResult["status"] {
  if (progress >= 100) return "achieved";
  if (progress <= 0) {
    const regressed = direction === "increase" ? current < target : current > target;
    return regressed ? "missed" : "notStarted";
  }
  return "inProgress";
}

/** A goal past its due date and not achieved is overdue (§5.7). */
export function goalIsOverdue(
  goal: { readonly status: string; readonly targetDate?: string | null | undefined },
  today: string,
): boolean {
  if (goal.status === "achieved" || goal.status === "canceled") return false;
  const targetDate = goal.targetDate ?? null;
  return targetDate !== null && targetDate !== "" && targetDate < today;
}

// ---------------------------------------------------------------------------
// Risks (§5.8)
// ---------------------------------------------------------------------------

export const RISK_TYPES = [
  "adoption",
  "engagement",
  "support",
  "stakeholder",
  "valueRealization",
  "renewal",
  "commercial",
  "implementation",
  "competitor",
  "unknown",
] as const;
export type RiskType = (typeof RISK_TYPES)[number];

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const RISK_STATUSES = [
  "open",
  "mitigating",
  "escalated",
  "resolved",
  "accepted",
  "closed",
] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const DEFAULT_RISK_TRANSITIONS: Readonly<Record<RiskStatus, readonly RiskStatus[]>> = {
  open: ["mitigating", "escalated", "resolved", "accepted", "closed"],
  mitigating: ["open", "escalated", "resolved", "accepted", "closed"],
  escalated: ["mitigating", "resolved", "accepted", "closed"],
  resolved: ["open", "closed"],
  accepted: ["open", "closed"],
  closed: ["open"],
};

/** Severity subtracted from a 100-point risk component; higher severity costs more (§5.4.2). */
export const RISK_SEVERITY_WEIGHT: Readonly<Record<RiskSeverity, number>> = {
  low: 5,
  medium: 15,
  high: 35,
  critical: 60,
};

export function checkRiskTransition(
  from: string,
  to: string,
  transitions: Readonly<Record<string, readonly string[]>> = DEFAULT_RISK_TRANSITIONS,
): TransitionCheck {
  if (!(RISK_STATUSES as readonly string[]).includes(from) || !(RISK_STATUSES as readonly string[]).includes(to)) {
    return { allowed: false, code: "invalidRiskStatus", message: `Unknown risk status (${from} → ${to}).` };
  }
  if (from === to) return { allowed: true };
  if (!(transitions[from] ?? []).includes(to)) {
    return {
      allowed: false,
      code: "invalidRiskTransition",
      message: `A risk cannot move from "${from}" to "${to}".`,
    };
  }
  return { allowed: true };
}

/** High/Critical risks require a mitigation action or a documented deferral (§5.8). */
export function riskRequiresMitigation(
  severity: string,
  data: { readonly mitigationPlan?: string | null | undefined; readonly nextAction?: string | null | undefined },
): boolean {
  if (severity !== "high" && severity !== "critical") return false;
  return (data.mitigationPlan ?? "").trim() === "" && (data.nextAction ?? "").trim() === "";
}

export interface RiskSignalInput {
  readonly severity: string;
  readonly status: string;
  readonly targetResolutionDate?: string | null | undefined;
}

/**
 * Score 0–100 for the risk component. Open risks cost by severity, and an overdue unresolved risk
 * adds a further penalty. Resolved/closed/accepted risks do not contribute.
 */
export function riskComponentScore(
  risks: readonly RiskSignalInput[],
  today: string,
): number {
  let score = 100;
  for (const risk of risks) {
    if (risk.status === "resolved" || risk.status === "closed" || risk.status === "accepted") continue;
    const severity = (RISK_SEVERITIES as readonly string[]).includes(risk.severity)
      ? (risk.severity as RiskSeverity)
      : "medium";
    score -= RISK_SEVERITY_WEIGHT[severity];
    const due = risk.targetResolutionDate ?? "";
    if (due !== "" && due < today) score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Playbooks (§5.11)
// ---------------------------------------------------------------------------

export const PLAYBOOK_TRIGGER_MODES = [
  "manual",
  "lifecycleTransition",
  "healthTransition",
  "renewalWindow",
  "onboardingStarted",
] as const;
export type PlaybookTriggerMode = (typeof PLAYBOOK_TRIGGER_MODES)[number];

export const PLAYBOOK_STEP_TYPES = [
  "manual",
  "createActivity",
  "createTask",
  "createRisk",
  "createSuccessPlan",
  "notifyOwner",
  "waitUntil",
] as const;
export type PlaybookStepType = (typeof PLAYBOOK_STEP_TYPES)[number];

export const PLAYBOOK_RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "canceled",
  "failed",
] as const;
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];

export const PLAYBOOK_STEP_RUN_STATUSES = [
  "pending",
  "inProgress",
  "completed",
  "skipped",
  "failed",
  "canceled",
] as const;
export type PlaybookStepRunStatus = (typeof PLAYBOOK_STEP_RUN_STATUSES)[number];

export interface PlaybookStepInput {
  readonly key: string;
  readonly name: string;
  readonly stepType: string;
  readonly order: number;
  readonly required?: boolean | undefined;
  readonly dueOffsetDays?: number | null | undefined;
  readonly assigneePolicy?: string | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly instructions?: string | undefined;
}

/** Validate a playbook template's step set (§5.11.1). Never executes a step's body. */
export function validatePlaybookSteps(
  steps: readonly PlaybookStepInput[],
): string[] {
  const issues: string[] = [];
  if (steps.length === 0) {
    issues.push("A playbook template needs at least one step.");
    return issues;
  }
  if (steps.length > 200) issues.push("A playbook template may declare at most 200 steps.");
  const keys = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z][A-Za-z0-9_]{0,63}$/.test(step.key)) {
      issues.push(`Step key "${step.key}" must start with a lower-case letter and use alphanumerics or underscores.`);
    }
    if (keys.has(step.key)) issues.push(`Duplicate step key "${step.key}".`);
    keys.add(step.key);
    if (step.name.trim() === "") issues.push(`Step "${step.key}" needs a name.`);
    if (!(PLAYBOOK_STEP_TYPES as readonly string[]).includes(step.stepType)) {
      issues.push(`Step "${step.key}" has an unsupported type "${step.stepType}".`);
    }
    if (!Number.isInteger(step.order) || step.order < 0) {
      issues.push(`Step "${step.key}" needs a non-negative integer order.`);
    }
  }
  // Dependency edges must point at declared steps, and must not form a cycle.
  const declared = [...keys];
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!keys.has(dependency)) {
        issues.push(`Step "${step.key}" depends on unknown step "${dependency}".`);
      }
      if (dependency === step.key) {
        issues.push(`Step "${step.key}" cannot depend on itself.`);
      }
    }
  }
  if (hasStepCycle(steps)) issues.push("Playbook steps contain a dependency cycle.");
  void declared;
  return issues;
}

function hasStepCycle(steps: readonly PlaybookStepInput[]): boolean {
  const dependencies = new Map<string, readonly string[]>();
  for (const step of steps) dependencies.set(step.key, step.dependsOn ?? []);
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    const current = state.get(key);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(key, "visiting");
    for (const dependency of dependencies.get(key) ?? []) {
      if (visit(dependency)) return true;
    }
    state.set(key, "done");
    return false;
  };
  for (const key of dependencies.keys()) {
    if (visit(key)) return true;
  }
  return false;
}

/** Steps whose dependencies are all satisfied and that are still pending — the ready set (§5.11.3). */
export function readyPlaybookSteps(
  steps: readonly { readonly key: string; readonly status: string; readonly dependsOn?: readonly string[] | undefined }[],
): string[] {
  const completed = new Set(
    steps
      .filter((step) => step.status === "completed" || step.status === "skipped")
      .map((step) => step.key),
  );
  return steps
    .filter((step) => step.status === "pending")
    .filter((step) => (step.dependsOn ?? []).every((dependency) => completed.has(dependency)))
    .map((step) => step.key);
}

// ---------------------------------------------------------------------------
// Renewal windows (§5.9)
// ---------------------------------------------------------------------------

export const DEFAULT_RENEWAL_WINDOWS: readonly number[] = [30, 60, 90, 120];

export const RENEWAL_STATUSES = [
  "unknown",
  "notDue",
  "preparing",
  "inProgress",
  "renewed",
  "atRisk",
  "churned",
] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

export interface RenewalWindowResult {
  readonly daysToRenewal: number;
  /** The smallest configured window the customer has entered, or null when none applies. */
  readonly windowDays: number | null;
  readonly overdue: boolean;
}

/**
 * Which configured window a renewal date falls into today (§5.9). A date in the past is overdue and
 * always inside the smallest window. Uses calendar-day arithmetic so timezone does not shift the
 * boundary.
 */
export function renewalWindow(
  renewalDate: string | null | undefined,
  today: string,
  windows: readonly number[] = DEFAULT_RENEWAL_WINDOWS,
): RenewalWindowResult | null {
  if (renewalDate === null || renewalDate === undefined || renewalDate === "") return null;
  const daysToRenewal = dayDifference(today, renewalDate);
  const sorted = [...new Set(windows.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (a, b) => a - b,
  );
  if (daysToRenewal < 0) {
    return { daysToRenewal, windowDays: sorted[0] ?? null, overdue: true };
  }
  const windowDays = sorted.find((value) => daysToRenewal <= value) ?? null;
  return { daysToRenewal, windowDays, overdue: false };
}

// ---------------------------------------------------------------------------
// Meaningful touch (§5.10)
// ---------------------------------------------------------------------------

export type TouchEntity = "Task" | "Call" | "Meeting" | "Email";

export interface TouchCandidate {
  readonly entity: TouchEntity;
  readonly status?: string | null | undefined;
  /** Whether the activity links to the account (or one of its contacts). */
  readonly linkedToCustomer: boolean;
  /** ISO instant the activity was completed, when it carries one. */
  readonly completedAt?: string | null | undefined;
  /** ISO instant the activity was created. */
  readonly createdAt?: string | null | undefined;
}

/**
 * A "meaningful touch" is a customer-facing activity that actually happened (§5.10): a held call or
 * meeting, a completed customer task, or a sent email — all linked to the customer. Internal-only or
 * automated noise is excluded. Recency uses completion time when present, then creation time.
 */
export function isMeaningfulTouch(candidate: TouchCandidate): boolean {
  if (!candidate.linkedToCustomer) return false;
  if (candidate.entity === "Task") return candidate.status === "Completed";
  if (candidate.entity === "Email") return candidate.status === "Sent" || candidate.status === null || candidate.status === undefined;
  return candidate.status === "Held";
}

/** The most recent qualifying touch instant among candidates, or null (§5.10). */
export function lastMeaningfulTouchAt(
  candidates: readonly TouchCandidate[],
): string | null {
  let latest: number | null = null;
  for (const candidate of candidates) {
    if (!isMeaningfulTouch(candidate)) continue;
    const instant = candidate.completedAt ?? candidate.createdAt ?? null;
    if (instant === null) continue;
    const parsed = Date.parse(instant);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

// ---------------------------------------------------------------------------
// Health trend (§5.4.4)
// ---------------------------------------------------------------------------

export type HealthTrend = "improving" | "stable" | "declining" | "unknown";

/**
 * Trend over a documented comparison window: a delta of at least `threshold` points counts as a
 * direction, anything smaller is stable, and fewer than two points is unknown.
 */
export function healthTrend(
  previous: number | null | undefined,
  current: number | null | undefined,
  threshold = 5,
): HealthTrend {
  if (previous === null || previous === undefined || current === null || current === undefined) {
    return "unknown";
  }
  const delta = current - previous;
  if (delta >= threshold) return "improving";
  if (delta <= -threshold) return "declining";
  return "stable";
}

// ---------------------------------------------------------------------------
// Portfolio queues (§5.2)
// ---------------------------------------------------------------------------

export const PORTFOLIO_QUEUES = [
  "myPortfolio",
  "teamPortfolio",
  "unassigned",
  "unknownHealth",
  "monitorHealth",
  "atRiskHealth",
  "criticalHealth",
  "onboardingNow",
  "onboardingOverdue",
  "upcomingRenewals",
  "missingPlan",
  "missingNextReview",
] as const;
export type PortfolioQueue = (typeof PORTFOLIO_QUEUES)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** `YYYY-MM-DD` in UTC — Customer Success dates are calendar days (§5.9). */
export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function dayValue(value: unknown): string | undefined {
  if (value instanceof Date) return isoDay(value);
  if (typeof value === "string" && value !== "") return value.slice(0, 10);
  return undefined;
}

/** Whole-day difference between two calendar days; negative when `to` is before `from`. */
export function dayDifference(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
