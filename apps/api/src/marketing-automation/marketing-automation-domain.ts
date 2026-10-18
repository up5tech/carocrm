import { createHash } from "node:crypto";

/**
 * Phase 19-MA.2 — pure Marketing Automation domain vocabulary and decisions
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §5.3, §5.5, §6.1–§6.5, §7.1, §7.4).
 *
 * Everything in this file is a constant or a pure function: no Nest dependency, no database, no I/O,
 * no clock read outside an injected `now`. The metadata seed, the settings schema, the write guard, the
 * lifecycle service and the unit tests all read these same lists, so a status or a reason added here
 * reaches the API, the UI and the validation at once — never a second, drifting copy (§0.2, AGENTS.md §5.2).
 *
 * Two rules from the plan shape everything below:
 *  - **Consent before convenience, suppression wins** (§1.2): `evaluateRecipientEligibility` is the only
 *    place a recipient's sendability is decided, and no caller may re-implement it (§0.1 rule 8).
 *  - **Explainable automation** (§1.2): every refusal names the rule that refused it, from a fixed
 *    code list (§7.4), so a block is never a bare `403`.
 */

// ---------------------------------------------------------------------------
// Canonical entity names (§3 of the audit — one record per concern)
// ---------------------------------------------------------------------------

/** The strategic campaign record. The plain canonical name, exactly as Service Desk took plain `Case`. */
export const CAMPAIGN_ENTITY = "Campaign";
/** The audience *definition* record (EspoCRM-documented "target list"), never a recipient list. */
export const TARGET_LIST_ENTITY = "TargetList";
/** How a membership row came to exist (§6.1 `source`): a person, an import, or criteria. */
export const TARGET_LIST_ENTRY_SOURCES = ["Manual", "Import", "Criteria", "Api", "Journey"] as const;
export type TargetListEntrySource = (typeof TARGET_LIST_ENTRY_SOURCES)[number];

/** One auditable membership row of a target list (MA.4 owns resolution; the name is fixed here). */
export const TARGET_LIST_ENTRY_ENTITY = "TargetListEntry";
/** Append-only lifecycle history: the command, the actor, the reason and the report it passed (§5.1). */
export const CAMPAIGN_TRANSITION_ENTITY = "CampaignTransition";
/** Current consent state per address identity × channel × purpose (§6.3). */
export const MARKETING_CONSENT_ENTITY = "MarketingConsent";
/** Append-only audit of every consent mutation (§5.3 invariant 9). */
export const MARKETING_CONSENT_EVENT_ENTITY = "MarketingConsentEvent";
/** Suppression tombstone per address identity, channel and scope (§6.3). */
export const MARKETING_SUPPRESSION_ENTITY = "MarketingSuppression";
/** Hashed, scoped, expiring public unsubscribe / preference / confirmation token (§5.3.1). */
export const MARKETING_PUBLIC_TOKEN_ENTITY = "MarketingPublicToken";
/** Header of a durable audience snapshot (§6.1 "Audience/send snapshot"). */
export const MARKETING_AUDIENCE_SNAPSHOT_ENTITY = "MarketingAudienceSnapshot";
/**
 * Immutable snapshot of an `EmailTemplate`'s content (§6.2 `MarketingTemplateRevision`). The template
 * itself stays platform-owned and editable; a sealed revision is the copy a send can be traced back to.
 */
export const MARKETING_TEMPLATE_REVISION_ENTITY = "MarketingTemplateRevision";
/**
 * One message within a campaign (§5.5, audit §3: "Campaign fields must not be overloaded"). It carries the
 * content revision, the audience snapshot, the validation hash and the approval the send is authorised by,
 * so a campaign can hold several sends (§5.6 "one recipient has one delivery record per intended send
 * slot") without any of them rewriting the campaign's own fields.
 */
export const MARKETING_SEND_ENTITY = "MarketingSend";
/** Append-only send lifecycle history, the exact counterpart of `CampaignTransition` for a send. */
export const MARKETING_SEND_TRANSITION_ENTITY = "MarketingSendTransition";
export const MARKETING_JOURNEY_ENTITY = "MarketingJourney";
export const MARKETING_JOURNEY_VERSION_ENTITY = "MarketingJourneyVersion";
export const MARKETING_JOURNEY_ENROLLMENT_ENTITY = "MarketingJourneyEnrollment";
export const MARKETING_JOURNEY_STEP_ENTITY = "MarketingJourneyStepExecution";

/** The bulk per-recipient ledger (audit §3 `MarketingRecipientDelivery`), a table, not a metadata record. */
export const MARKETING_RECIPIENT_DELIVERIES_TABLE = "marketing_recipient_deliveries";

export const MARKETING_AUTOMATION_ENTITY_TYPES = [
  CAMPAIGN_ENTITY,
  TARGET_LIST_ENTITY,
  TARGET_LIST_ENTRY_ENTITY,
  CAMPAIGN_TRANSITION_ENTITY,
  MARKETING_CONSENT_ENTITY,
  MARKETING_CONSENT_EVENT_ENTITY,
  MARKETING_SUPPRESSION_ENTITY,
  MARKETING_PUBLIC_TOKEN_ENTITY,
  MARKETING_AUDIENCE_SNAPSHOT_ENTITY,
  MARKETING_TEMPLATE_REVISION_ENTITY,
  MARKETING_SEND_ENTITY,
  MARKETING_SEND_TRANSITION_ENTITY,
  MARKETING_JOURNEY_ENTITY,
  MARKETING_JOURNEY_VERSION_ENTITY,
  MARKETING_JOURNEY_ENROLLMENT_ENTITY,
  MARKETING_JOURNEY_STEP_ENTITY,
] as const;
export type MarketingAutomationEntityType = (typeof MARKETING_AUTOMATION_ENTITY_TYPES)[number];

/**
 * The records a marketer navigates to. `TargetListEntry` and `CampaignTransition` are evidence rows —
 * membership and command history — and are read through the module's own endpoints, which apply the parent
 * record's permission; advertising them as lists of internal ids would be a disclosure, not a feature
 * (§9.2, and §15 `19-MA.1` task 5).
 */
export const MARKETING_AUTOMATION_NAVIGABLE_ENTITIES = [
  CAMPAIGN_ENTITY,
  TARGET_LIST_ENTITY,
  // §10.1 puts "Consent & Suppression" in the Marketing menu, restricted by role: the records are
  // navigable, and their default ACL (`own`, and `no` for suppression writes) is what restricts them.
  MARKETING_CONSENT_ENTITY,
  MARKETING_SUPPRESSION_ENTITY,
] as const;

// ---------------------------------------------------------------------------
// Campaign classification (§5.1)
// ---------------------------------------------------------------------------

/**
 * Delivery families. Only the three first-release kinds plus a non-sending `Other` (§3.1 "start with
 * email, newsletter and informational"): a campaign that cannot send must not pretend to be an email
 * campaign, and `Other` is what §2.1's documented non-email campaign types map to here.
 */
export const CAMPAIGN_TYPES = ["Email", "Newsletter", "Informational", "Other"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/** Campaigns of these types are allowed to own a send definition; the rest are planning records only. */
export const SENDING_CAMPAIGN_TYPES: readonly CampaignType[] = ["Email", "Newsletter", "Informational"];

/**
 * Communication purposes (§5.3). `ServiceNotice` is the transactional/required family and is the only
 * purpose that may skip marketing consent — which is precisely why §5.1 forbids reaching it by relabelling
 * a promotional campaign as "informational". The link between the two is enforced in
 * `checkPurposeConsistency`, not left to an operator's good intentions.
 */
export const CAMPAIGN_PURPOSES = [
  "Newsletter",
  "ProductMarketing",
  "EventUpdate",
  "ServiceNotice",
] as const;
export type CampaignPurpose = (typeof CAMPAIGN_PURPOSES)[number];

/** Purposes that require marketing consent before any message (plan §5.3 "communication purpose"). */
export const CONSENT_REQUIRED_PURPOSES: readonly CampaignPurpose[] = [
  "Newsletter",
  "ProductMarketing",
  "EventUpdate",
];

/**
 * The §5.1 and §9.3 requirement made executable. Consent is gated by **purpose**, never by the content
 * label: relabelling a promotional campaign as "informational" must not open a loophole, so the exemption
 * lives only in `ServiceNotice` and only when an operator has deliberately acknowledged it.
 */
export function purposeRequiresConsent(purpose: CampaignPurpose): boolean {
  return CONSENT_REQUIRED_PURPOSES.includes(purpose);
}

/**
 * `ServiceNotice` is the single purpose that can send without marketing consent, and §9.3 requires it to be
 * an explicit, attributable classification instead of a dropdown default. A campaign that claims it without
 * the acknowledgement is a blocker, not a warning: an unacknowledged exemption is the exact loophole the
 * plan names.
 */
export function serviceNoticeNeedsAcknowledgement(purpose: CampaignPurpose): boolean {
  return purpose === "ServiceNotice";
}

/**
 * Classification sanity: a `Newsletter` campaign carrying `ServiceNotice` purpose is contradictory on its
 * face, so the two independent fields are checked against each other before a send is ever allowed.
 */
export function purposeTypeMismatch(type: CampaignType, purpose: CampaignPurpose): string | undefined {
  if (type === "Newsletter" && purpose === "ServiceNotice") {
    return 'A "Newsletter" campaign cannot carry the ServiceNotice purpose; a newsletter is marketing communication and needs marketing consent (§5.1).';
  }
  return undefined;
}

/** Time zone identifiers are validated by the platform's `Intl` support, never by a hard-coded list. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const CAMPAIGN_CODE_MAX_LENGTH = 64;
export const CAMPAIGN_TIMEZONE_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Campaign lifecycle (§5.1, MA.3)
// ---------------------------------------------------------------------------

/** Draft → Scheduled → Running → Paused → Completed, with Failed and Archived where justified (§5.1). */
export const CAMPAIGN_STATUSES = [
  "Draft",
  "Scheduled",
  "Running",
  "Paused",
  "Completed",
  "Failed",
  "Archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Nothing may be queued or sent for a campaign in one of these states (§5.1 "draft campaigns do not send"). */
export const CAMPAIGN_CLOSED_STATUSES: readonly CampaignStatus[] = ["Completed", "Failed", "Archived"];

/** The states a live campaign can occupy: the only ones an emergency stop or a pause decision acts on. */
export const CAMPAIGN_LIVE_STATUSES: readonly CampaignStatus[] = ["Scheduled", "Running", "Paused"];

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

export function isCampaignType(value: unknown): value is CampaignType {
  return typeof value === "string" && (CAMPAIGN_TYPES as readonly string[]).includes(value);
}

export function isCampaignPurpose(value: unknown): value is CampaignPurpose {
  return typeof value === "string" && (CAMPAIGN_PURPOSES as readonly string[]).includes(value);
}

/**
 * Legal status edges. `Archived` is terminal and unreachable from a live campaign by `archive` alone —
 * stopping an active campaign is the explicit `cancel` command, which is the difference between retiring
 * a plan and abandoning a send (§5.1, §10.2 "explicit confirmation where production messages are affected").
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  Draft: ["Scheduled", "Running", "Archived"],
  // Unscheduling returns a campaign to Draft rather than inventing a sixth state for "was scheduled".
  Scheduled: ["Draft", "Running", "Archived"],
  Running: ["Paused", "Completed", "Failed", "Archived"],
  Paused: ["Running", "Completed", "Failed", "Archived"],
  Completed: ["Archived"],
  Failed: ["Archived"],
  Archived: [],
};

export const CAMPAIGN_COMMANDS = [
  "schedule",
  "unschedule",
  "start",
  "pause",
  "resume",
  "complete",
  "cancel",
  "archive",
] as const;
export type CampaignCommand = (typeof CAMPAIGN_COMMANDS)[number];

const CAMPAIGN_COMMAND_TARGET: Readonly<Record<CampaignCommand, CampaignStatus>> = {
  schedule: "Scheduled",
  unschedule: "Draft",
  start: "Running",
  pause: "Paused",
  resume: "Running",
  complete: "Completed",
  cancel: "Archived",
  archive: "Archived",
};

/** The source states each named command accepts — always a subset of `CAMPAIGN_TRANSITIONS`. */
const CAMPAIGN_COMMAND_SOURCES: Readonly<Record<CampaignCommand, readonly CampaignStatus[]>> = {
  schedule: ["Draft"],
  unschedule: ["Scheduled"],
  // A campaign with no schedule may start straight from Draft; `Failed` never restarts by a user command.
  start: ["Draft", "Scheduled"],
  pause: ["Running"],
  resume: ["Paused"],
  // Completion is an operator decision on a live campaign; a Paused one can be closed out without resuming.
  complete: ["Running", "Paused"],
  cancel: ["Draft", "Scheduled", "Running", "Paused"],
  // Retiring a finished campaign only; a live campaign must be cancelled first.
  archive: ["Completed", "Failed"],
};

/**
 * `Failed` is produced by the delivery runtime (MA.9) and by nothing a user can press, so no command
 * targets it. It is still a legal *source* of `archive`, which keeps a failed campaign auditable rather
 * than deletable.
 */
export const CAMPAIGN_SYSTEM_ONLY_STATUSES: readonly CampaignStatus[] = ["Failed"];

export function isCampaignCommand(value: unknown): value is CampaignCommand {
  return typeof value === "string" && (CAMPAIGN_COMMANDS as readonly string[]).includes(value);
}

export function campaignCommandTarget(command: CampaignCommand): CampaignStatus {
  return CAMPAIGN_COMMAND_TARGET[command];
}

export function campaignCommandSources(command: CampaignCommand): readonly CampaignStatus[] {
  return CAMPAIGN_COMMAND_SOURCES[command];
}

/** The commands an actor in this state may run, in declaration order — what the SPA renders verbatim. */
export function allowedCampaignCommands(status: CampaignStatus): CampaignCommand[] {
  return CAMPAIGN_COMMANDS.filter((command) => CAMPAIGN_COMMAND_SOURCES[command].includes(status));
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly code?: string;
  readonly message?: string;
}

/**
 * The single transition validator. A no-op (from === to) is allowed and changes nothing, matching the
 * lifecycle convention the other Phase 19 domains already follow.
 */
export function checkCampaignTransition(input: {
  from: CampaignStatus;
  to?: CampaignStatus | undefined;
  command?: CampaignCommand | undefined;
}): TransitionCheck {
  const { from } = input;
  const to = input.command !== undefined ? CAMPAIGN_COMMAND_TARGET[input.command] : input.to;
  if (to === undefined) {
    return { allowed: false, code: "CAMPAIGN_TRANSITION_UNDECLARED", message: "A campaign transition needs a command or a target status." };
  }
  // A caller that names both must name them consistently; a claim that `start` leads somewhere else is a
  // misunderstanding about the lifecycle, and silently honouring either half would be a wrong answer.
  if (input.command !== undefined && input.to !== undefined && input.to !== to) {
    return {
      allowed: false,
      code: "CAMPAIGN_TRANSITION_NOT_ALLOWED",
      message: `Command "${input.command}" moves a campaign to "${to}", not "${input.to}".`,
    };
  }
  if (from === to) return { allowed: true };
  if (input.command !== undefined && !CAMPAIGN_COMMAND_SOURCES[input.command].includes(from)) {
    return {
      allowed: false,
      code: "CAMPAIGN_TRANSITION_NOT_ALLOWED",
      message: `Command "${input.command}" cannot run on a campaign in status "${from}" (it applies to ${CAMPAIGN_COMMAND_SOURCES[input.command].join(", ") || "no status"}).`,
    };
  }
  if (!CAMPAIGN_TRANSITIONS[from].includes(to)) {
    const targets = CAMPAIGN_TRANSITIONS[from];
    return {
      allowed: false,
      code: "CAMPAIGN_TRANSITION_NOT_ALLOWED",
      message:
        targets.length === 0
          ? `A campaign in status "${from}" is final and cannot move to "${to}".`
          : `A campaign in status "${from}" cannot move to "${to}". Allowed: ${targets.join(", ")}.`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Campaign validation report (§5.1, §8.4 — blocking findings and warnings)
// ---------------------------------------------------------------------------

export const CAMPAIGN_FINDING_CODES = [
  "NAME_REQUIRED",
  "TYPE_REQUIRED",
  "PURPOSE_REQUIRED",
  "PURPOSE_TYPE_MISMATCH",
  "SERVICE_NOTICE_UNACKNOWLEDGED",
  "TIMEZONE_INVALID",
  "SCHEDULE_ORDER",
  "BUDGET_INVALID",
  "AUDIENCE_REQUIRED",
  "AUDIENCE_NOT_READABLE",
  "CONTENT_REQUIRED",
  "CONTENT_NOT_READABLE",
  "SENDER_REQUIRED",
  "SENDER_UNKNOWN",
  "TRACKING_NOT_CONFIGURED",
  "TRACKING_DISCLOSURE",
  "CONSENT_NOT_CONFIGURED",
  "PROVIDER_NOT_BOUND",
  "GLOBAL_SEND_PAUSED",
  // Phase 19-MA.6 — content findings (§5.4): what the linked template renders and carries.
  "CONTENT_LINK_INVALID",
  "CONTENT_FOOTER_MISSING",
  "CONTENT_MARKUP_REMOVED",
  "CONTENT_PLACEHOLDER_UNKNOWN",
] as const;
export type CampaignFindingCode = (typeof CAMPAIGN_FINDING_CODES)[number];

export interface CampaignFinding {
  readonly code: CampaignFindingCode;
  readonly level: "blocker" | "warning";
  readonly message: string;
  readonly field?: string;
}

/** A validation report is the answer to "may this be scheduled/started", and it is explainable (§8.4). */
export interface CampaignValidationReport {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly valid: boolean;
  readonly blockers: readonly CampaignFinding[];
  readonly warnings: readonly CampaignFinding[];
  readonly checkedAt: string;
  /**
   * Stable hash of the facts the decision was made on. §5.5 requires a material change to invalidate a
   * prior approval, so the hash covers audience, content, sender, policy and schedule — not the name.
   */
  readonly validationHash: string;
}

export function blocker(code: CampaignFindingCode, message: string, field?: string): CampaignFinding {
  return { code, level: "blocker", message, ...(field !== undefined ? { field } : {}) };
}

export function warning(code: CampaignFindingCode, message: string, field?: string): CampaignFinding {
  return { code, level: "warning", message, ...(field !== undefined ? { field } : {}) };
}

// ---------------------------------------------------------------------------
// Send definition lifecycle (§5.5 — contract declared now, runtime in MA.8)
// ---------------------------------------------------------------------------

/**
 * The queue job that drives delivery (§11.1 candidate jobs, MA.9 task 1). Defined here so the send
 * service (which enqueues it on `queue`/`resume`) and the delivery worker (which reads it for health)
 * cannot drift apart; the worker process registers the handler under this same name.
 */
export const DELIVERY_BATCH_JOB = "marketing.deliveryBatch";

export const SEND_STATUSES = [
  "Draft",
  "Validated",
  "Scheduled",
  "Queued",
  "Sending",
  "Sent",
  "Completed",
  "Paused",
  "Cancelled",
  "Failed",
] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];

/**
 * §5.5's lifecycle. `Validated` is invalidated by any material change, which is why `Draft` is reachable
 * from every pre-send state, and `Paused`/`Cancelled` are distinguished from `Failed` (an operator stop is
 * not an execution error).
 */
export const SEND_TRANSITIONS: Readonly<Record<SendStatus, readonly SendStatus[]>> = {
  Draft: ["Validated", "Cancelled"],
  Validated: ["Draft", "Scheduled", "Cancelled"],
  // Re-validation is an edge in its own right: running the dry run again is how a stale approval is replaced
  // (§5.5), and it must not require the operator to walk the send back to Draft by hand first.
  Scheduled: ["Draft", "Validated", "Queued", "Paused", "Cancelled"],
  // `Queued` and `Paused` join `Scheduled` in allowing `Draft`: "Validated is invalidated by any material
  // change, which is why Draft is reachable from every pre-send state" (§5.5). A send whose content or
  // audience changed while it sat queued has no approval left, and Draft is where it must go back to.
  Queued: ["Draft", "Validated", "Sending", "Paused", "Cancelled"],
  // `Sending` is deliberately not re-validatable: messages are on the wire, and changing what the send means
  // underneath the worker is exactly the ambiguity the snapshot exists to prevent (§5.2).
  Sending: ["Sent", "Paused", "Failed"],
  Sent: ["Completed"],
  Completed: [],
  Paused: ["Draft", "Validated", "Queued", "Cancelled"],
  Cancelled: [],
  Failed: ["Draft", "Validated", "Cancelled"],
};

export const SEND_COMMANDS = [
  "validate",
  "schedule",
  "queue",
  "pause",
  "resume",
  "cancel",
  "complete",
  "fail",
] as const;
export type SendCommand = (typeof SEND_COMMANDS)[number];

/**
 * The target of each named command. `fail` is the one command the delivery runtime (MA.9) owns — it is a
 * legal edge of the machine but is never exposed as a route, so an operator cannot declare a send failed.
 */
export const SEND_COMMAND_TARGET: Readonly<Record<SendCommand, SendStatus>> = {
  validate: "Validated",
  schedule: "Scheduled",
  queue: "Queued",
  pause: "Paused",
  resume: "Queued",
  cancel: "Cancelled",
  complete: "Completed",
  fail: "Failed",
};

/**
 * The source states each named command accepts — always a subset of `SEND_TRANSITIONS`.
 *
 * `validate` is deliberately re-runnable from every pre-send state (a re-validation after a material change
 * is how a stale approval is replaced), and `pause` covers `Queued` because a send that has been queued but
 * not yet handed to a worker is still an operator's to stop.
 */
export const SEND_COMMAND_SOURCES: Readonly<Record<SendCommand, readonly SendStatus[]>> = {
  validate: ["Draft", "Validated", "Scheduled", "Queued", "Paused", "Failed"],
  schedule: ["Validated"],
  queue: ["Scheduled"],
  pause: ["Scheduled", "Queued", "Sending"],
  resume: ["Paused"],
  cancel: ["Draft", "Validated", "Scheduled", "Queued", "Sending", "Paused", "Failed"],
  complete: ["Sent"],
  fail: ["Sending"],
};

/** Commands a user may never run; MA.9's runtime produces these outcomes and nothing a client can press. */
export const SEND_SYSTEM_ONLY_COMMANDS: readonly SendCommand[] = ["fail"];

/** Statuses a send can no longer be stopped from: the state machine's terminal states. */
export const SEND_TERMINAL_STATUSES: readonly SendStatus[] = ["Completed", "Cancelled"];

/** Pre-send states: nothing has been handed to a provider, so a material change may return the send to Draft. */
export const SEND_PRE_SEND_STATUSES: readonly SendStatus[] = ["Draft", "Validated", "Scheduled", "Queued", "Paused"];

export function isSendStatus(value: unknown): value is SendStatus {
  return typeof value === "string" && (SEND_STATUSES as readonly string[]).includes(value);
}

export function isSendCommand(value: unknown): value is SendCommand {
  return typeof value === "string" && (SEND_COMMANDS as readonly string[]).includes(value);
}

export function sendCommandTarget(command: SendCommand): SendStatus {
  return SEND_COMMAND_TARGET[command];
}

export function sendCommandSources(command: SendCommand): readonly SendStatus[] {
  return SEND_COMMAND_SOURCES[command];
}

/** The commands an actor in this state may run, in declaration order — what the SPA renders verbatim. */
export function allowedSendCommands(status: SendStatus): SendCommand[] {
  return SEND_COMMANDS.filter(
    (command) =>
      SEND_COMMAND_SOURCES[command].includes(status) && !SEND_SYSTEM_ONLY_COMMANDS.includes(command),
  );
}

/** The same single transition validator the campaign lifecycle uses, applied to the send machine (§5.5). */
export function checkSendTransition(input: {
  from: SendStatus;
  to?: SendStatus | undefined;
  command?: SendCommand | undefined;
}): TransitionCheck {
  const { from } = input;
  const to = input.command !== undefined ? SEND_COMMAND_TARGET[input.command] : input.to;
  if (to === undefined) {
    return {
      allowed: false,
      code: "SEND_TRANSITION_UNDECLARED",
      message: "A send transition needs a command or a target status.",
    };
  }
  if (input.command !== undefined && input.to !== undefined && input.to !== to) {
    return {
      allowed: false,
      code: "SEND_TRANSITION_NOT_ALLOWED",
      message: `Command "${input.command}" moves a send to "${to}", not "${input.to}".`,
    };
  }
  if (from === to) return { allowed: true };
  if (input.command !== undefined && !SEND_COMMAND_SOURCES[input.command].includes(from)) {
    return {
      allowed: false,
      code: "SEND_TRANSITION_NOT_ALLOWED",
      message: `Command "${input.command}" cannot run on a send in status "${from}" (it applies to ${SEND_COMMAND_SOURCES[input.command].join(", ") || "no status"}).`,
    };
  }
  if (!SEND_TRANSITIONS[from].includes(to)) {
    const targets = SEND_TRANSITIONS[from];
    return {
      allowed: false,
      code: "SEND_TRANSITION_NOT_ALLOWED",
      message:
        targets.length === 0
          ? `A send in status "${from}" is final and cannot move to "${to}".`
          : `A send in status "${from}" cannot move to "${to}". Allowed: ${targets.join(", ")}.`,
    };
  }
  return { allowed: true };
}
// ---------------------------------------------------------------------------
// Send definition: findings, dry run and the delivery ledger mapping (§5.5, §6.5 — MA.8)
// ---------------------------------------------------------------------------

/**
 * Every way a send definition can be refused or cautioned, from a fixed list (§7.4 "explainable"). A
 * refusal names the rule and the thing to fix, exactly as a campaign finding does — "the send is blocked"
 * is not an answer an operator can act on.
 */
export const SEND_FINDING_CODES = [
  "SEND_CAMPAIGN_CLOSED",
  "SEND_CAMPAIGN_INVALID",
  "SEND_CHANNEL_UNSUPPORTED",
  "SEND_AUDIENCE_EMPTY",
  "SEND_NO_ELIGIBLE_RECIPIENTS",
  "SEND_CONTENT_UNSEALED",
  "SEND_PROVIDER_NOT_LIVE",
  "SEND_GLOBAL_SEND_PAUSED",
  "SEND_CAMPAIGN_NOT_LIVE",
  "SEND_APPROVAL_REQUIRED",
  "SEND_APPROVAL_STALE",
  "SEND_AUDIENCE_TRUNCATED",
  "SEND_CONSENT_POLICY",
] as const;
export type SendFindingCode = (typeof SEND_FINDING_CODES)[number];

/** The same shape as a campaign finding, because an operator reads both reports side by side (§8.4). */
export interface SendFinding {
  readonly code: SendFindingCode;
  readonly level: "blocker" | "warning";
  readonly message: string;
  readonly field?: string;
}

export function sendBlocker(code: SendFindingCode, message: string, field?: string): SendFinding {
  return { code, level: "blocker", message, ...(field !== undefined ? { field } : {}) };
}

export function sendWarning(code: SendFindingCode, message: string, field?: string): SendFinding {
  return { code, level: "warning", message, ...(field !== undefined ? { field } : {}) };
}

/** One category of the forecast, with the reasons that category exists at all (§5.5 dry run). */
export interface AudienceCategoryCount {
  readonly category: AudienceCategory;
  readonly count: number;
  /** Stable reason codes (suppression reason, consent block, duplicate rule) seen in this category. */
  readonly reasons: readonly string[];
}

/** A named recipient the caller may read, so a dry run explains itself without disclosing hidden records. */
export interface SendForecastRecipient {
  readonly entityType: string;
  readonly entityId: string;
  readonly name: string | null;
  readonly category: AudienceCategory;
  readonly reasons: readonly string[];
}

/** The audience half of a dry run: counts per category, and the snapshot a validation would freeze. */
export interface SendAudienceForecast {
  readonly snapshotId: string | null;
  readonly compositionHash: string;
  readonly resolved: number;
  readonly eligible: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly categories: readonly AudienceCategoryCount[];
  readonly sample: readonly SendForecastRecipient[];
  readonly truncated: boolean;
  readonly limit: number;
  readonly notes: readonly string[];
}

export interface SendApprovalState {
  readonly approvedById: string | null;
  readonly approvedAt: string | null;
  readonly approvalHash: string | null;
  /** True when the approval was given for exactly the material facts as they are now (§5.5). */
  readonly current: boolean;
  readonly note: string | null;
}

/**
 * The §5.5 dry run: what would be sent, to how many people, and why the rest are excluded — plus the
 * campaign report it inherits and the approval state the decision rests on. Produced without writing
 * anything, so an operator (or a test) can ask the question as often as they like.
 */
export interface SendDryRunReport {
  readonly sendId: string;
  readonly campaignId: string;
  readonly slot: number;
  readonly status: SendStatus;
  /** Blockers empty. A dry run is `valid` when nothing about it would be refused right now. */
  readonly valid: boolean;
  readonly blockers: readonly SendFinding[];
  readonly warnings: readonly SendFinding[];
  /** The campaign report this send inherits, findings and all (§5.1). */
  readonly campaign: CampaignValidationReport;
  readonly audience: SendAudienceForecast;
  readonly approval: SendApprovalState;
  /** The fingerprint of the facts an approval is bound to; the value `validate` records and `schedule` checks. */
  readonly materialHash: string;
  readonly checkedAt: string;
}

/**
 * Which ledger state a forecast category lands in (§6.5, and the `RECIPIENT_DELIVERY_TRANSITIONS` machine
 * above). Written once, so the eligibility reason an operator saw in the dry run is the state the delivery
 * worker will act on later — never two vocabularies for one decision.
 *
 * `Eligible` means "would be sent"; `Blocked` is a recipient a gate refused (consent, suppression, segment
 * exclusion); `Skipped` is a recipient with no message to send to (no address, a duplicate of another
 * record, an unreadable record). Only `Eligible` rows are handed to the provider by MA.9.
 */
export const DELIVERY_STATE_FOR_CATEGORY: Readonly<Record<AudienceCategory, RecipientDeliveryStatus>> = {
  eligible: "Eligible",
  duplicateRecord: "Skipped",
  duplicateAddress: "Skipped",
  noEmailAddress: "Skipped",
  invalidAddress: "Skipped",
  recordUnreadable: "Skipped",
  excludedBySegment: "Blocked",
  suppressedGlobal: "Blocked",
  suppressedComplaint: "Blocked",
  suppressedBounce: "Blocked",
  suppressedOther: "Blocked",
  optedOut: "Blocked",
  consentUnknown: "Blocked",
  consentPending: "Blocked",
  frequencyCapped: "Blocked",
};

/** The three ledger states a forecast can produce, so a count never invents a fourth. */
export const FORECAST_DELIVERY_STATES: readonly RecipientDeliveryStatus[] = ["Eligible", "Blocked", "Skipped"];

/** Ledger states that are still someone's to stop: only these are cancelled when a send is cancelled. */
export const OPEN_DELIVERY_STATES: readonly RecipientDeliveryStatus[] = ["Pending", "Eligible", "Queued"];

// ---------------------------------------------------------------------------
// Consent, preferences and suppression (§5.3 — matrix declared now, endpoints in MA.5)
// ---------------------------------------------------------------------------

export const CONSENT_CHANNELS = ["Email"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** §5.3's state list; `Unknown` is a real state and never means "assume yes" (invariant 5). */
export const CONSENT_STATUSES = [
  "Unknown",
  "PendingConfirmation",
  "Consented",
  "OptedOut",
  "Suppressed",
  "Invalid",
] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/** The only consent states that authorise a marketing send for a purpose. */
export const CONSENT_GRANTING_STATUSES: readonly ConsentStatus[] = ["Consented"];

/** How consent was established (§5.3 "consent basis/type"). */
export const CONSENT_BASES = [
  "ExplicitOptIn",
  "DoubleOptIn",
  "LegacyImport",
  "ManualRecord",
  "Contractual",
  "ProviderConfirmed",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

/**
 * §5.3's state machine. Withdrawing is always available; re-subscribing requires affirmative action
 * (invariant 7, §5.3.2), and a `Suppressed` person is only left by a reviewed operator decision, never by
 * a form post.
 */
export const CONSENT_TRANSITIONS: Readonly<Record<ConsentStatus, readonly ConsentStatus[]>> = {
  Unknown: ["PendingConfirmation", "Consented", "OptedOut", "Suppressed", "Invalid"],
  PendingConfirmation: ["Unknown", "Consented", "OptedOut", "Suppressed"],
  Consented: ["OptedOut", "Suppressed", "Invalid", "Unknown"],
  // Leaving OptedOut is the re-consent path: it needs affirmative evidence, which is a *new* consent row
  // decision rather than a status edit, so the only direct edge is the one a reviewed operator takes.
  OptedOut: ["Consented", "Suppressed"],
  Suppressed: ["OptedOut"],
  Invalid: ["Unknown", "Consented"],
};

export function isConsentStatus(value: unknown): value is ConsentStatus {
  return typeof value === "string" && (CONSENT_STATUSES as readonly string[]).includes(value);
}

/** Is a move between two consent states legal? (§5.3; the history table records the ones that were not refused.) */
export function checkConsentTransition(from: ConsentStatus, to: ConsentStatus): TransitionCheck {
  if (from === to) return { allowed: true };
  if (!CONSENT_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      code: "CONSENT_TRANSITION_NOT_ALLOWED",
      message: `Consent state "${from}" cannot move to "${to}". Allowed: ${CONSENT_TRANSITIONS[from].join(", ") || "no state"}.`,
    };
  }
  return { allowed: true };
}

/** Every consent mutation records actor, prior/new state and reason (§5.3 invariant 9). */
export const CONSENT_SOURCES = [
  "WebForm",
  "PreferenceCenter",
  "UnsubscribeLink",
  "ProviderWebhook",
  "ManualRecord",
  "Import",
  "Api",
  "SalesRep",
  "System",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SUPPRESSION_SCOPES = ["Global", "Channel", "Purpose", "TargetList"] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

/** §5.3 reason list. `HardBounce` and `Complaint` arrive only from a provider event (MA.10). */
export const SUPPRESSION_REASONS = [
  "GlobalOptOut",
  "Complaint",
  "HardBounce",
  "InvalidAddress",
  "ManualBlock",
  "OperatorBlock",
  "LegalRestriction",
  "UnknownUser",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Scopes and reasons that outrank everything else, including a fresh explicit opt-in (§1.2). */
export const ABSOLUTE_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "LegalRestriction",
  "OperatorBlock",
];

export const SUPPRESSION_OVERRIDABLE: Readonly<Record<SuppressionReason, boolean>> = {
  GlobalOptOut: false,
  Complaint: false,
  HardBounce: false,
  InvalidAddress: true,
  ManualBlock: true,
  OperatorBlock: false,
  LegalRestriction: false,
  UnknownUser: true,
};

// ---------------------------------------------------------------------------
// Audience composition (§5.2, MA.4)
// ---------------------------------------------------------------------------

/**
 * Record types an audience may name. §5.2 starts with Contacts and Leads and requires an explicit
 * compatibility contract (plus a recipient-address rule) before any other entity joins them — an Account
 * has an `emailAddress` but is not a person to mail.
 */
export const SEGMENT_ENTITY_TYPES = ["Contact", "Lead"] as const;
export type SegmentEntityType = (typeof SEGMENT_ENTITY_TYPES)[number];

export function isSegmentEntityType(value: unknown): value is SegmentEntityType {
  return typeof value === "string" && (SEGMENT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** How a snapshot was produced. A preview is never mistaken for the list a send will use (§5.5). */
export const SNAPSHOT_MODES = ["preview", "final"] as const;
export type AudienceSnapshotMode = (typeof SNAPSHOT_MODES)[number];

export const SNAPSHOT_STATUSES = ["Generated", "Invalidated"] as const;
export type AudienceSnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

/**
 * The documented de-duplication rule (§5.2 "De-duplicate a recipient across matching records using
 * documented rules"): one message per normalised address, kept on the *person* record preferred over a
 * lead, then the oldest record, then the id. Records are never merged and identity is never rewritten —
 * this is a send-time choice about which record carries the message (§1.2 "reuse over duplication").
 */
export function recipientPrecedence(entityType: string): number {
  return entityType === "Contact" ? 0 : 1;
}

/**
 * Preview categories (§5.5's dry-run list). Every recipient lands in exactly one headline category, in
 * this order, so the counts add up to the resolved population and an operator can see *why* the eligible
 * number is smaller than the audience number.
 */
export const AUDIENCE_CATEGORY_CODES = [
  "eligible",
  "duplicateRecord",
  "duplicateAddress",
  "noEmailAddress",
  "invalidAddress",
  "excludedBySegment",
  "suppressedGlobal",
  "suppressedComplaint",
  "suppressedBounce",
  "suppressedOther",
  "optedOut",
  "consentUnknown",
  "consentPending",
  "frequencyCapped",
  "recordUnreadable",
] as const;
export type AudienceCategory = (typeof AUDIENCE_CATEGORY_CODES)[number];

/** Headline category for an eligibility decision — the mapping the preview counts and the snapshot share. */
export function categoryForDecision(decision: {
  eligible: boolean;
  code: EligibilityBlockCode | "ELIGIBLE";
  duplicateRecord?: boolean | undefined;
  duplicateAddress?: boolean | undefined;
}): AudienceCategory {
  if (!decision.eligible) {
    switch (decision.code) {
      case "NO_EMAIL_ADDRESS":
        return "noEmailAddress";
      case "INVALID_ADDRESS":
        return "invalidAddress";
      case "EXCLUDED_BY_TARGET_LIST":
        return "excludedBySegment";
      case "GLOBALLY_SUPPRESSED":
        return "suppressedGlobal";
      case "COMPLAINT_SUPPRESSED":
        return "suppressedComplaint";
      case "HARD_BOUNCE_SUPPRESSED":
        return "suppressedBounce";
      case "CHANNEL_SUPPRESSED":
      case "PURPOSE_SUPPRESSED":
      case "TARGET_LIST_SUPPRESSED":
        return "suppressedOther";
      case "OPTED_OUT":
        return "optedOut";
      case "CONSENT_UNKNOWN":
        return "consentUnknown";
      case "CONSENT_PENDING":
        return "consentPending";
      case "FREQUENCY_CAP_REACHED":
        return "frequencyCapped";
      case "RECORD_UNREADABLE":
        return "recordUnreadable";
      case "ELIGIBLE":
        // Unreachable: an eligible decision is not blocked. Kept exhaustive so a new code cannot be
        // counted as eligible by accident.
        return "eligible";
      default: {
        const exhaustive: never = decision.code;
        throw new Error(`Unsupported eligibility code "${String(exhaustive)}".`);
      }
    }
  }
  if (decision.duplicateRecord === true) return "duplicateRecord";
  if (decision.duplicateAddress === true) return "duplicateAddress";
  return "eligible";
}

// ---------------------------------------------------------------------------
// Public tokens (§5.3.1, §5.3.2)
// ---------------------------------------------------------------------------

/**
 * What a public token may do. Keeping the operation *in* the token is what stops an unsubscribe link from
 * becoming a preference-writing link, and a confirmation link from unsubscribing someone.
 */
export const PUBLIC_TOKEN_SCOPES = ["Unsubscribe", "Preferences", "OptInConfirmation"] as const;
export type PublicTokenScope = (typeof PUBLIC_TOKEN_SCOPES)[number];

export const PUBLIC_TOKEN_STATUSES = ["Active", "Used", "Expired", "Revoked"] as const;
export type PublicTokenStatus = (typeof PUBLIC_TOKEN_STATUSES)[number];

/** Token lifetimes in days (§13 "public unsubscribe/preference token lifetime"). */
export const PUBLIC_TOKEN_TTL_DAYS: Readonly<Record<PublicTokenScope, number>> = {
  // An unsubscribe link must keep working long after a message is read — a broken opt-out is worse than a
  // long-lived URL, and the action is idempotent and single-direction.
  Unsubscribe: 365,
  Preferences: 90,
  // A confirmation link is a short-lived step in a double-opt-in flow, not a standing credential.
  OptInConfirmation: 7,
};

/** §5.3 invariant 10: calling an idempotent operation twice is a success, not an error. */
export function isConsentTerminalForPurpose(status: ConsentStatus): boolean {
  return status === "OptedOut" || status === "Suppressed" || status === "Invalid";
}

// ---------------------------------------------------------------------------
// The eligibility decision matrix (§5.3, §7.1 `MarketingEligibilityService`)
// ---------------------------------------------------------------------------

/** Stable reason codes for every block, so a refusal is machine-explainable (§7.4). */
export const ELIGIBILITY_BLOCK_CODES = [
  "RECORD_UNREADABLE",
  "NO_EMAIL_ADDRESS",
  "INVALID_ADDRESS",
  "GLOBALLY_SUPPRESSED",
  "CHANNEL_SUPPRESSED",
  "PURPOSE_SUPPRESSED",
  "TARGET_LIST_SUPPRESSED",
  "COMPLAINT_SUPPRESSED",
  "HARD_BOUNCE_SUPPRESSED",
  "EXCLUDED_BY_TARGET_LIST",
  "OPTED_OUT",
  "CONSENT_UNKNOWN",
  "CONSENT_PENDING",
  "FREQUENCY_CAP_REACHED",
] as const;
export type EligibilityBlockCode = (typeof ELIGIBILITY_BLOCK_CODES)[number];

/** Codes that no retry can lift, so a pending message must be dropped rather than rescheduled (§5.3). */
export const TERMINAL_ELIGIBILITY_CODES: readonly EligibilityBlockCode[] = [
  "GLOBALLY_SUPPRESSED",
  "COMPLAINT_SUPPRESSED",
  "HARD_BOUNCE_SUPPRESSED",
];

export interface RecipientEligibilityInput {
  /** Resolved email address of the canonical record; empty or whitespace is a block, not an assumption. */
  readonly emailAddress?: string | undefined;
  readonly channel: ConsentChannel;
  readonly purpose: CampaignPurpose;
  /** Consent state for this address × channel × purpose, or `Unknown` when there is no record. */
  readonly consentStatus: ConsentStatus;
  /** Suppressions that apply to this address. Order in the input is irrelevant: the matrix sorts by severity. */
  readonly suppressions?: readonly SuppressionFact[] | undefined;
  /** True when the recipient was named by an excluded target list (§5.2 "exclusion wins"). */
  readonly excluded?: boolean | undefined;
  /** False when the caller's ACL cannot read the person record — never a silent skip (§5.2, §9.2). */
  readonly recordReadable?: boolean | undefined;
  /** Messages already delivered to this recipient in the cap window, and the configured cap (0 = no cap). */
  readonly messagesInWindow?: number | undefined;
  readonly frequencyCap?: number | undefined;
  /** Overrides the purpose default; `ServiceNotice` on an acknowledged campaign is the one exemption (§5.1). */
  readonly consentRequired?: boolean | undefined;
}

export interface SuppressionFact {
  readonly reason: SuppressionReason;
  readonly scope: SuppressionScope;
}

export interface RecipientEligibilityDecision {
  readonly eligible: boolean;
  readonly code: EligibilityBlockCode | "ELIGIBLE";
  readonly reasons: readonly EligibilityBlockCode[];
  /** True when a later rule could never clear this recipient, so a retry must not be scheduled (§5.3). */
  readonly terminal: boolean;
}

/** Severity order of the suppression reasons; the strongest fact about a recipient becomes the headline. */
const SUPPRESSION_SEVERITY: Readonly<Record<SuppressionReason, number>> = {
  LegalRestriction: 0,
  OperatorBlock: 1,
  Complaint: 2,
  HardBounce: 3,
  GlobalOptOut: 4,
  InvalidAddress: 5,
  UnknownUser: 6,
  ManualBlock: 7,
};

function suppressionCode(suppression: SuppressionFact): EligibilityBlockCode {
  // A reason outranks a scope: a complaint is a complaint wherever it was recorded (§1.2 "suppression wins").
  if (suppression.reason === "Complaint") return "COMPLAINT_SUPPRESSED";
  if (suppression.reason === "HardBounce") return "HARD_BOUNCE_SUPPRESSED";
  if (suppression.reason === "InvalidAddress" || suppression.reason === "UnknownUser") return "INVALID_ADDRESS";
  if (suppression.scope === "Global") return "GLOBALLY_SUPPRESSED";
  if (suppression.scope === "Channel") return "CHANNEL_SUPPRESSED";
  if (suppression.scope === "Purpose") return "PURPOSE_SUPPRESSED";
  return "TARGET_LIST_SUPPRESSED";
}

/**
 * The single recipient-eligibility gate (§5.3). Evaluation order *is* the policy:
 *
 *  1. a caller who cannot read the person record gets `RECORD_UNREADABLE`, not a silent skip and not a
 *     count that leaks a record (§5.2, §9.2);
 *  2. an address that is absent or malformed blocks before anything, since every other question is moot;
 *  3. **suppression wins** over consent, membership and automation (§1.2) — the reason is reported, never
 *     swallowed, and a legal/operator block is absolute (`SUPPRESSION_OVERRIDABLE`);
 *  4. exclusion beats inclusion (§5.2);
 *  5. then consent for this purpose: `Unknown` and `PendingConfirmation` both block, because missing
 *     evidence is never read as consent (§5.3 invariant 5);
 *  6. then the frequency cap, which is a send-time policy rather than a permission (§5.5).
 *
 * `code` is the headline (first, most severe) reason while `reasons` lists every block that applies, which
 * is what lets §5.5's dry-run breakdown count each category without a second implementation.
 *
 * Campaign-level gates are deliberately **not** here: whether the campaign itself may send
 * (`checkCampaignSendable`) is a different question from whether this person may be emailed, and a dry run
 * on a Draft campaign must still be able to answer the second question.
 */
export function evaluateRecipientEligibility(
  input: RecipientEligibilityInput,
): RecipientEligibilityDecision {
  const reasons: EligibilityBlockCode[] = [];

  if (input.recordReadable === false) reasons.push("RECORD_UNREADABLE");

  const address = normalizeEmailAddress(input.emailAddress);
  if (address === "") reasons.push("NO_EMAIL_ADDRESS");
  else if (!looksLikeEmailAddress(address)) reasons.push("INVALID_ADDRESS");

  const ordered = [...(input.suppressions ?? [])].sort(
    (left, right) => SUPPRESSION_SEVERITY[left.reason] - SUPPRESSION_SEVERITY[right.reason],
  );
  for (const suppression of ordered) {
    const code = suppressionCode(suppression);
    if (!reasons.includes(code)) reasons.push(code);
  }

  if (input.excluded === true) reasons.push("EXCLUDED_BY_TARGET_LIST");

  const consentRequired = input.consentRequired ?? purposeRequiresConsent(input.purpose);
  if (consentRequired) {
    if (!CONSENT_GRANTING_STATUSES.includes(input.consentStatus)) {
      const code = consentBlockCode(input.consentStatus);
      if (!reasons.includes(code)) reasons.push(code);
    }
  }

  const cap = input.frequencyCap ?? 0;
  if (cap > 0 && (input.messagesInWindow ?? 0) >= cap) reasons.push("FREQUENCY_CAP_REACHED");

  if (reasons.length === 0) {
    return { eligible: true, code: "ELIGIBLE", reasons: [], terminal: false };
  }
  const headline = reasons[0] as EligibilityBlockCode;
  return {
    eligible: false,
    code: headline,
    reasons,
    terminal: reasons.some((code) => TERMINAL_ELIGIBILITY_CODES.includes(code)),
  };
}

function consentBlockCode(status: ConsentStatus): EligibilityBlockCode {
  switch (status) {
    case "Unknown":
      return "CONSENT_UNKNOWN";
    case "PendingConfirmation":
      return "CONSENT_PENDING";
    case "OptedOut":
      return "OPTED_OUT";
    case "Suppressed":
      return "GLOBALLY_SUPPRESSED";
    case "Invalid":
      return "INVALID_ADDRESS";
    case "Consented":
      // Unreachable: only a non-granting state calls this. Kept exhaustive so a new state cannot pass silently.
      return "CONSENT_UNKNOWN";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unsupported consent state "${String(exhaustive)}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Campaign sendability gate (§5.1, §13)
// ---------------------------------------------------------------------------

export interface CampaignSendabilityInput {
  readonly status: CampaignStatus;
  readonly globalSendPaused?: boolean | undefined;
  readonly sendType?: boolean | undefined;
}

export interface CampaignSendabilityDecision {
  readonly sendable: boolean;
  readonly code: "CAMPAIGN_NOT_SENDABLE" | "GLOBAL_SEND_PAUSED" | "SENDABLE";
  readonly message: string;
}

/**
 * Whether *this campaign* may put messages on the wire right now. Kept apart from recipient eligibility so
 * an emergency stop (§13) is one obvious check on every path — queueing, retry, journey action, manual send
 * — and cannot be bypassed by a caller that only looks at consent (§0.1 rule 8).
 */
export function checkCampaignSendable(input: CampaignSendabilityInput): CampaignSendabilityDecision {
  if (input.globalSendPaused === true) {
    return {
      sendable: false,
      code: "GLOBAL_SEND_PAUSED",
      message: "Marketing sending is stopped globally by an operator; no message may be queued or sent (§13).",
    };
  }
  if (!CAMPAIGN_LIVE_STATUSES.includes(input.status)) {
    return {
      sendable: false,
      code: "CAMPAIGN_NOT_SENDABLE",
      message: `A campaign in status "${input.status}" cannot send; only Scheduled, Running or Paused campaigns hold live recipients (§5.1).`,
    };
  }
  return { sendable: true, code: "SENDABLE", message: "Campaign may queue messages." };
}

// ---------------------------------------------------------------------------
// Delivery, events, journeys (§6.4, §6.5 — contracts declared now)
// ---------------------------------------------------------------------------

export const RECIPIENT_DELIVERY_STATUSES = [
  "Pending",
  "Eligible",
  "Blocked",
  "Queued",
  "Sending",
  "Sent",
  "Delivered",
  "Bounced",
  "Complained",
  "Unsubscribed",
  "Failed",
  "Skipped",
] as const;
export type RecipientDeliveryStatus = (typeof RECIPIENT_DELIVERY_STATUSES)[number];

/** A provider-confirmed terminal state: a retry must never be scheduled from one (§5.3 invariant 2). */
export const RECIPIENT_DELIVERY_TERMINAL: readonly RecipientDeliveryStatus[] = [
  "Delivered",
  "Bounced",
  "Complained",
  "Unsubscribed",
  "Failed",
  "Skipped",
];

/**
 * Delivery is the one marketing-owned state machine that must survive a queue restart, so its edges are
 * declared here and unit-tested rather than implied by worker code (`MarketingDeliveryWorker`, MA.9).
 */
export const RECIPIENT_DELIVERY_TRANSITIONS: Readonly<
  Record<RecipientDeliveryStatus, readonly RecipientDeliveryStatus[]>
> = {
  Pending: ["Eligible", "Blocked", "Queued", "Skipped"],
  Eligible: ["Queued", "Blocked", "Skipped"],
  Blocked: [],
  Queued: ["Sending", "Blocked", "Skipped"],
  Sending: ["Sent", "Failed", "Blocked"],
  Sent: ["Delivered", "Bounced", "Complained", "Unsubscribed", "Failed"],
  Delivered: ["Unsubscribed", "Complained"],
  Bounced: [],
  Complained: [],
  Unsubscribed: [],
  Failed: ["Queued"],
  Skipped: [],
};

export const MARKETING_EVENT_TYPES = [
  "Accepted",
  "Delivered",
  "Bounced",
  "Complained",
  "Unsubscribed",
  "Opened",
  "Clicked",
  "ProviderError",
  "Blocked",
  "Sent",
] as const;
export type MarketingEventType = (typeof MARKETING_EVENT_TYPES)[number];

/** Events a provider can actually report; open/click are best-effort and labelled as such (§1.1 item 9). */
export const PROVIDER_REPORTED_EVENT_TYPES: readonly MarketingEventType[] = [
  "Accepted",
  "Delivered",
  "Bounced",
  "Complained",
  "Unsubscribed",
  "Opened",
  "Clicked",
  "ProviderError",
];

/** §5.9: which engagement events justify adding a person to the suppression list automatically (MA.10). */
export const SUPPRESSING_EVENT_REASONS: Readonly<Partial<Record<MarketingEventType, SuppressionReason>>> = {
  Complained: "Complaint",
  Bounced: "HardBounce",
  Unsubscribed: "GlobalOptOut",
};

export const JOURNEY_STATUSES = ["Draft", "Scheduled", "Active", "Paused", "Completed", "Archived"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

export const JOURNEY_VERSION_STATUSES = ["Draft", "Published", "Retired"] as const;
export type JourneyVersionStatus = (typeof JOURNEY_VERSION_STATUSES)[number];

/** §5.6/§6.4: a published version is immutable, so `Published` has no edge back to `Draft`. */
export const JOURNEY_VERSION_TRANSITIONS: Readonly<
  Record<JourneyVersionStatus, readonly JourneyVersionStatus[]>
> = {
  Draft: ["Published", "Retired"],
  Published: ["Retired"],
  Retired: [],
};

export const ENROLLMENT_STATUSES = [
  "Active",
  "Waiting",
  "Suspended",
  "Completed",
  "Exited",
  "Failed",
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ENROLLMENT_TRANSITIONS: Readonly<Record<EnrollmentStatus, readonly EnrollmentStatus[]>> = {
  Active: ["Waiting", "Suspended", "Completed", "Exited", "Failed"],
  Waiting: ["Active", "Suspended", "Exited", "Failed"],
  Suspended: ["Active", "Waiting", "Exited"],
  Completed: [],
  Exited: [],
  // A failed execution resumes only through an explicit `retryStep` (MA.13), never by a timer alone.
  Failed: ["Active", "Exited"],
};

export const ENROLLMENT_EXIT_REASONS = [
  "GoalReached",
  "ConditionUnmet",
  "ExitedBySegment",
  "ConsentWithdrawn",
  "Suppressed",
  "Unsubscribed",
  "GlobalSendPaused",
  "JourneyPaused",
  "ManuallyExited",
  "ReEntered",
  "Completed",
] as const;
export type EnrollmentExitReason = (typeof ENROLLMENT_EXIT_REASONS)[number];

export const STEP_EXECUTION_STATUSES = [
  "Pending",
  "Running",
  "Waiting",
  "Completed",
  "Skipped",
  "Failed",
] as const;
export type StepExecutionStatus = (typeof STEP_EXECUTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Retention and audit metadata (§6.8, §9.3 — declared as data, enforced by MA.18's jobs)
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  readonly record: string;
  /** Days of detail kept; `null` means "kept until privacy-reviewed deletion", never "delete on a timer". */
  readonly defaultDays: number | null;
  readonly containsPersonalData: boolean;
  readonly note: string;
}

/**
 * Each class of marketing record gets its own stated retention rather than inheriting one global number,
 * because §6.8 requires it and because a suppression tombstone outliving an event stream is the whole
 * point: deleting suppression evidence can cause a previously opted-out person to be emailed again.
 */
export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { record: CAMPAIGN_ENTITY, defaultDays: null, containsPersonalData: false, note: "Business record; deleted only with the customer's data request." },
  { record: TARGET_LIST_ENTITY, defaultDays: null, containsPersonalData: false, note: "Configuration; criteria are not recipient data." },
  { record: TARGET_LIST_ENTRY_ENTITY, defaultDays: null, containsPersonalData: true, note: "References a CRM record by id; deletion follows the person's own retention." },
  { record: "MarketingRecipientDelivery", defaultDays: 730, containsPersonalData: true, note: "Keeps the eligibility decision, not the rendered body." },
  { record: "MarketingEvent", defaultDays: 365, containsPersonalData: true, note: "Detail expires; aggregates can be rebuilt from what remains (§6.7)." },
  { record: "MarketingConsent", defaultDays: null, containsPersonalData: true, note: "Evidence must outlive the campaigns it authorises." },
  { record: "MarketingConsentEvent", defaultDays: 1_825, containsPersonalData: true, note: "§5.3 invariant 9 history; the audit trail is the defence." },
  { record: "MarketingSuppression", defaultDays: null, containsPersonalData: true, note: "Tombstone: never timer-deleted, or an opt-out silently expires (§6.8)." },
  { record: "MarketingTemplateRevision", defaultDays: 1_095, containsPersonalData: false, note: "Immutable content; bodies can be large, so they expire before the audit reference." },
  { record: "MarketingProviderWebhookInbox", defaultDays: 30, containsPersonalData: true, note: "Raw envelope only until normalised; §9.3 minimises payload retention." },
];

/** Fields the audit trail must always carry on a marketing record (§6.7, §9.3). */
export const AUDIT_FIELD_NAMES = [
  "createdAt",
  "modifiedAt",
  "createdById",
  "modifiedById",
  "deletedAt",
] as const;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Keys whose value actually differs from the stored record; mirrors the other Phase 19 domains. */
export function changedKeys(data: Record<string, unknown>, previous: Record<string, unknown>): string[] {
  return Object.keys(data).filter((key) => !sameValue(data[key], previous[key]));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A normalised email identity: trimmed and lower-cased. Never used to *merge* records (§5.2). */
export function normalizeEmailAddress(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Cheap shape check for an address. Deliberately permissive: transport-level validity belongs to the
 * provider (MA.7), while this only refuses a value that cannot be an address at all.
 */
export function looksLikeEmailAddress(value: unknown): boolean {
  const address = normalizeEmailAddress(value);
  return address.length <= 320 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address);
}

/**
 * Deterministic fingerprint of the facts a validation decision was made on (§5.5: a material change must
 * invalidate a prior approval). It is a change detector over ids, timestamps and policy values — never a
 * security token, so no secret or salt is involved and it must not be reused as one (§7.3).
 */
export function fingerprint(values: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(values)).digest("hex").slice(0, 32);
}

/** Key-sorted JSON, so the same facts always produce the same string regardless of insertion order. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
