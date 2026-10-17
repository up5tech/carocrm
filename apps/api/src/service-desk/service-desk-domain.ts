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

/**
 * Keys whose value actually differs from the stored record — a no-op save is not a change. Mirrors
 * the helper the other Phase 19 modules use; kept local so the modules stay independent.
 */
export function changedKeys(data: Record<string, unknown>, previous: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => !sameValue(data[key], previous[key]));
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
