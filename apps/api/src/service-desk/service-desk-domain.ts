/**
 * Phase 19-SD — pure Service Desk domain vocabulary and helpers
 * (PLAN_Phase_19_ServiceDesk.md §5.1, §5.2, §7.5).
 *
 * Everything here is a constant or a pure function: no Nest dependency, no database, no I/O. The
 * metadata seed, the settings schema and the write guard all read these same lists, so a status or a
 * source added here reaches the API, the UI and the validation at once — never a second, drifting copy.
 */

/** §5.2 default lifecycle. Labels are configurable; the codes are the server-side contract. */
export const CASE_STATUSES = [
  "New",
  "Open",
  "Pending Customer",
  "Pending Internal",
  "Escalated",
  "Resolved",
  "Closed",
  "Cancelled",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** A case in one of these states is finished for the purposes of SLA, escalation and default lists. */
export const CASE_TERMINAL_STATUSES: readonly CaseStatus[] = ["Closed", "Cancelled"];

export const CASE_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/** Impact scale, deliberately distinct from priority (§5.1 "distinct from priority where configured"). */
export const CASE_SEVERITIES = ["Low", "Normal", "High", "Critical"] as const;

/** Classification taxonomy; a configurable enum rather than customer vocabulary hard-coded in code. */
export const CASE_TYPES = ["Question", "Incident", "Problem", "Service Request"] as const;

/** Intake channel (§5.1 `source`). */
export const CASE_SOURCES = ["Web", "Email", "Portal", "API", "Web Form", "Workflow", "Phone"] as const;

/** Summary SLA state (§5.6). Per-target clock detail lives in the SLA records delivered in SD.8. */
export const CASE_SLA_STATES = ["NotApplicable", "OnTrack", "Warning", "Breached", "Paused", "Met"] as const;

/** The canonical support-case entity. Exactly one — no parallel `ServiceDeskCase` (§0.1). */
export const CASE_ENTITY = "Case";

/** Prefix/padding bounds shared by the settings schema and the numbering service. */
export const CASE_NUMBER_MAX_LENGTH = 32;
export const CASE_NUMBER_PREFIX_MAX = 16;
export const CASE_NUMBER_PADDING_MIN = 1;
export const CASE_NUMBER_PADDING_MAX = 12;

/**
 * Render a case number from a sequence value.
 *
 * The value is produced by a Postgres sequence, so it is unique by construction; padding is
 * presentation only and can never collide because the unpadded integers already differ (§5.1 "use a
 * sequence … do not compute a number by counting existing rows").
 */
export function formatCaseNumber(prefix: string, sequenceValue: number | string | bigint, padding: number): string {
  const value = typeof sequenceValue === "bigint" ? sequenceValue : BigInt(String(sequenceValue));
  return `${prefix}${value.toString().padStart(padding, "0")}`;
}

/**
 * True when a case carries at least one requester reference (§5.1). A resolvable CRM record is
 * preferred, but a channel that only knows a sender address (email-to-case, web form) is valid too.
 */
export function hasRequesterReference(data: Record<string, unknown>): boolean {
  return (
    nonEmpty(data["accountId"]) ||
    nonEmpty(data["contactId"]) ||
    nonEmpty(data["leadId"]) ||
    nonEmpty(data["requesterEmail"]) ||
    nonEmpty(data["requesterName"])
  );
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
}

/** Defaults applied to a new case when the caller supplies none (§14.1 general settings). */
export interface CaseDefaults {
  readonly status: CaseStatus;
  readonly priority: CasePriority;
  readonly type: (typeof CASE_TYPES)[number];
  readonly source: (typeof CASE_SOURCES)[number];
}

export const DEFAULT_CASE_DEFAULTS: CaseDefaults = {
  status: "New",
  priority: "Normal",
  type: "Question",
  source: "Web",
};

/** Default numbering policy: a short prefix and enough digits that numbers read as ticket ids. */
export interface CaseNumberingConfig {
  readonly prefix: string;
  readonly padding: number;
}

export const DEFAULT_CASE_NUMBERING: CaseNumberingConfig = { prefix: "C", padding: 6 };

/** Default allowed resolution codes; configuration narrows or replaces them (§14.1). */
export const DEFAULT_RESOLUTION_CODES: readonly string[] = [
  "Solved",
  "Workaround",
  "Duplicate",
  "No Response",
  "Not Reproducible",
  "Information Provided",
];

/**
 * Keys whose value actually differs from the stored record — a no-op save is not a change. Mirrors
 * the helper the other Phase 19 modules use; kept local so the modules stay independent.
 */
export function changedKeys(data: Record<string, unknown>, previous: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => !sameValue(data[key], previous[key]));
}

// ---------------------------------------------------------------------------
// Case lifecycle and state machine (§5.2, SD.4)
// ---------------------------------------------------------------------------

/** A case in one of these states is finished for standard operation; only an authorized reopen leaves it. */
export const CASE_TERMINAL_STATUSES_SET: ReadonlySet<CaseStatus> = new Set(CASE_TERMINAL_STATUSES);

/** Statuses whose cases are still "active" for assignment workload counts (§5.3 least-busy). */
export const CASE_ACTIVE_STATUSES: readonly CaseStatus[] = CASE_STATUSES.filter(
  (status) => !CASE_TERMINAL_STATUSES_SET.has(status),
);

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === "string" && (CASE_STATUSES as readonly string[]).includes(value);
}

/**
 * Allowed status edges of the default lifecycle (§5.2). Every command's target must be an edge here;
 * the per-command source sets below narrow it further so `start` and `reopen` cannot both be used to
 * reach `Open` from a resolved case. A no-op (from === to) is always allowed and changes nothing.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  New: ["Open", "Pending Customer", "Pending Internal", "Escalated", "Resolved", "Cancelled"],
  Open: ["Pending Customer", "Pending Internal", "Escalated", "Resolved", "Cancelled"],
  "Pending Customer": ["Open", "Pending Internal", "Escalated", "Resolved", "Cancelled"],
  "Pending Internal": ["Open", "Pending Customer", "Escalated", "Resolved", "Cancelled"],
  Escalated: ["Open", "Pending Customer", "Pending Internal", "Resolved", "Cancelled"],
  // Reopening preserves the prior resolution cycle; the timestamps are never erased (§5.2).
  Resolved: ["Open", "Closed", "Cancelled"],
  // `Closed` and `Cancelled` are terminal for standard operation; `Open` is a controlled, authorized reopen.
  Closed: ["Open"],
  Cancelled: ["Open"],
};

export const CASE_TRANSITION_COMMANDS = [
  "start",
  "setPendingCustomer",
  "setPendingInternal",
  "escalate",
  "deEscalate",
  "resolve",
  "close",
  "reopen",
  "cancel",
] as const;
export type CaseTransitionCommand = (typeof CASE_TRANSITION_COMMANDS)[number];

const CASE_COMMAND_TARGET: Readonly<Record<CaseTransitionCommand, CaseStatus>> = {
  start: "Open",
  setPendingCustomer: "Pending Customer",
  setPendingInternal: "Pending Internal",
  escalate: "Escalated",
  deEscalate: "Open",
  resolve: "Resolved",
  close: "Closed",
  reopen: "Open",
  cancel: "Cancelled",
};

/** The source states each named command accepts. A subset of `CASE_TRANSITIONS` by construction. */
const CASE_COMMAND_SOURCES: Readonly<Record<CaseTransitionCommand, readonly CaseStatus[]>> = {
  start: ["New", "Pending Customer", "Pending Internal", "Escalated"],
  setPendingCustomer: ["New", "Open", "Pending Internal", "Escalated"],
  setPendingInternal: ["New", "Open", "Pending Customer", "Escalated"],
  escalate: ["New", "Open", "Pending Customer", "Pending Internal"],
  deEscalate: ["Escalated"],
  resolve: ["New", "Open", "Pending Customer", "Pending Internal", "Escalated"],
  // Closing requires a prior resolution (§5.2 "closing can require a prior Resolved state").
  close: ["Resolved"],
  reopen: ["Resolved", "Closed", "Cancelled"],
  cancel: ["New", "Open", "Pending Customer", "Pending Internal", "Escalated", "Resolved"],
};

export function isCaseTransitionCommand(value: unknown): value is CaseTransitionCommand {
  return typeof value === "string" && (CASE_TRANSITION_COMMANDS as readonly string[]).includes(value);
}

export function commandTargetStatus(command: CaseTransitionCommand): CaseStatus {
  return CASE_COMMAND_TARGET[command];
}

/** The commands a case in `from` may run right now — the server's answer the SPA renders (§9.3). */
export function allowedCaseCommands(from: CaseStatus): CaseTransitionCommand[] {
  return CASE_TRANSITION_COMMANDS.filter((command) => CASE_COMMAND_SOURCES[command].includes(from));
}

export interface CaseTransitionInput {
  readonly from: CaseStatus;
  readonly to: CaseStatus;
  readonly command?: CaseTransitionCommand | undefined;
}

export interface CaseTransitionCheck {
  readonly allowed: boolean;
  readonly code?: string;
  readonly message?: string;
}

/**
 * Validate a case transition server-side (§5.2 "validate source state, target state, actor
 * permissions, required fields … on the server"). A named command must be one of its declared source
 * edges and reach exactly its target; a direct status move must be an edge of `CASE_TRANSITIONS`.
 */
export function checkCaseTransition(input: CaseTransitionInput): CaseTransitionCheck {
  if (input.from === input.to && (input.command === undefined || CASE_COMMAND_TARGET[input.command] === input.to)) {
    return { allowed: true };
  }
  if (input.command !== undefined) {
    const target = CASE_COMMAND_TARGET[input.command];
    if (target !== input.to) {
      return {
        allowed: false,
        code: "CASE_TRANSITION_NOT_ALLOWED",
        message: `Command "${input.command}" moves a case to "${target}", not "${input.to}".`,
      };
    }
    if (!CASE_COMMAND_SOURCES[input.command].includes(input.from)) {
      return {
        allowed: false,
        code: "CASE_TRANSITION_NOT_ALLOWED",
        message: `A case in "${input.from}" cannot run "${input.command}".`,
      };
    }
    return { allowed: true };
  }
  const edges = CASE_TRANSITIONS[input.from] ?? [];
  if (!edges.includes(input.to)) {
    return {
      allowed: false,
      code: "CASE_TRANSITION_NOT_ALLOWED",
      message: `A case cannot move from "${input.from}" to "${input.to}".`,
    };
  }
  return { allowed: true };
}

export interface ResolutionRequirementInput {
  readonly resolutionCode?: string | undefined;
  readonly resolutionSummary?: string | undefined;
  readonly requireCode: boolean;
  readonly requireSummary: boolean;
  /** Configured allowed codes; an empty list means any non-empty code is accepted. */
  readonly codes: readonly string[];
}

/**
 * Check the resolution requirement (§5.2 "resolving a case requires a resolution code or summary
 * according to configuration"). Returns the error to surface, or `undefined` when satisfied.
 */
export function checkResolutionRequirement(input: ResolutionRequirementInput): string | undefined {
  const code = (input.resolutionCode ?? "").trim();
  const summary = (input.resolutionSummary ?? "").trim();
  if (input.requireCode && code === "") {
    return "A resolution code is required to resolve a case.";
  }
  if (input.requireSummary && summary === "") {
    return "A resolution summary is required to resolve a case.";
  }
  if (input.codes.length > 0 && code !== "" && !input.codes.includes(code)) {
    return `"${code}" is not a configured resolution code.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Queues, assignment and routing (§5.3, SD.5)
// ---------------------------------------------------------------------------

/** How a queue picks the next owner (§5.3 assignment strategies). `manual` keeps it unassigned. */
export const CASE_ASSIGNMENT_STRATEGIES = ["manual", "roundRobin", "leastBusy"] as const;
export type CaseAssignmentStrategy = (typeof CASE_ASSIGNMENT_STRATEGIES)[number];

export function isCaseAssignmentStrategy(value: unknown): value is CaseAssignmentStrategy {
  return typeof value === "string" && (CASE_ASSIGNMENT_STRATEGIES as readonly string[]).includes(value);
}

/** What happens when no eligible member exists: retain in the queue or use the configured fallback (§5.3). */
export const CASE_FALLBACK_BEHAVIORS = ["unassigned", "fallbackOwner"] as const;
export type CaseFallbackBehavior = (typeof CASE_FALLBACK_BEHAVIORS)[number];

export function isCaseFallbackBehavior(value: unknown): value is CaseFallbackBehavior {
  return typeof value === "string" && (CASE_FALLBACK_BEHAVIORS as readonly string[]).includes(value);
}

/** Comparison operators a routing rule condition may declare — declarative, never executable (§5.3). */
export const ROUTING_OPERATORS = ["equals", "notEquals", "in"] as const;
export type RoutingOperator = (typeof ROUTING_OPERATORS)[number];

/**
 * Case attributes a routing rule may match on. An allowlist, so no stored condition can name an
 * arbitrary column or expression (§5.3 "never evaluate arbitrary JavaScript or SQL").
 */
export const ROUTING_FIELDS = ["source", "priority", "type", "severity", "status"] as const;

export interface RoutingCondition {
  readonly field: (typeof ROUTING_FIELDS)[number];
  readonly operator: RoutingOperator;
  readonly value: string | readonly string[];
}

export interface RoutingConditionCheck {
  readonly ok: boolean;
  readonly message?: string;
}

/** Validate one routing condition, used both at save time and before evaluation (§5.3, §11.1). */
export function checkRoutingCondition(condition: unknown): RoutingConditionCheck {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    return { ok: false, message: "A routing condition must be an object." };
  }
  const record = condition as Record<string, unknown>;
  const field = record["field"];
  if (typeof field !== "string" || !(ROUTING_FIELDS as readonly string[]).includes(field)) {
    return { ok: false, message: `Unsupported routing condition field "${String(field)}".` };
  }
  const operator = record["operator"];
  if (typeof operator !== "string" || !(ROUTING_OPERATORS as readonly string[]).includes(operator)) {
    return { ok: false, message: `Unsupported routing operator "${String(operator)}".` };
  }
  const value = record["value"];
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
      return { ok: false, message: "An \"in\" condition needs a non-empty list of string values." };
    }
  } else if (typeof value !== "string") {
    return { ok: false, message: "A routing condition value must be a string." };
  }
  return { ok: true };
}

export function checkRoutingConditions(conditions: readonly unknown[]): RoutingConditionCheck {
  for (const condition of conditions) {
    const check = checkRoutingCondition(condition);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/** Does `data` satisfy every condition of a rule? All conditions are ANDed, evaluated in declared order. */
export function routingConditionsMatch(
  conditions: readonly RoutingCondition[],
  data: Record<string, unknown>,
): boolean {
  return conditions.every((condition) => {
    const actual = typeof data[condition.field] === "string" ? (data[condition.field] as string) : "";
    if (condition.operator === "equals") return actual === condition.value;
    if (condition.operator === "notEquals") return actual !== condition.value;
    const list = Array.isArray(condition.value) ? condition.value : [condition.value];
    return list.includes(actual);
  });
}

/**
 * The next member in a round-robin ring, given the last assigned user and a deterministic ordering.
 * Pure so the concurrency-safe cursor update is a thin transaction around a testable decision (§5.3).
 */
export function nextRoundRobinMember(
  orderedUserIds: readonly string[],
  lastAssignedUserId: string | undefined,
): string | undefined {
  if (orderedUserIds.length === 0) return undefined;
  if (lastAssignedUserId === undefined) return orderedUserIds[0];
  const index = orderedUserIds.indexOf(lastAssignedUserId);
  if (index === -1) return orderedUserIds[0];
  return orderedUserIds[(index + 1) % orderedUserIds.length];
}

/** The least-busy member: fewest active cases, ties broken by id for a deterministic, fair result. */
export function leastBusyMember(
  orderedUserIds: readonly string[],
  activeCounts: ReadonlyMap<string, number>,
): string | undefined {
  let best: string | undefined;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const userId of orderedUserIds) {
    const count = activeCounts.get(userId) ?? 0;
    if (count < bestCount) {
      best = userId;
      bestCount = count;
    }
  }
  return best;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (typeof left === "object" && typeof right === "object" && left !== null && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}
