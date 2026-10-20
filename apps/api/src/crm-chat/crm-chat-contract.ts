import type { CRMChatCapabilityKey, CRMChatFeatureKey } from './crm-chat-module.js';

/**
 * Phase 19-CHAT.1 — the machine-readable half of the versioned contract
 * (`PLAN_Phase_19_CRM_Chat.md` §17 `19-CHAT.1`, deliverable: "Versioned TypeScript/OpenAPI contract
 * proposal"; prose in `docs/architecture/crm-chat-contract.md`).
 *
 * The prose contract and this file must agree. Each entry is the *whole* surface Chat may expose, so a
 * route or event that is not listed here is not part of the product and must not be added to a
 * controller without changing this file and bumping `version`. `apps/api/test/crm-chat-contract.test.ts`
 * checks the two halves against each other, so documentation drift becomes a failing test rather than
 * a reviewer's memory.
 *
 * `implemented` marks the routes that exist today (19-CHAT.2). Everything else is specified and stays
 * out of the controller until its phase lands.
 */

/** Bumped whenever a path, request shape, response shape, event or error code changes incompatibly. */
export const CRM_CHAT_CONTRACT_VERSION = '1.1.0';

export type CRMChatHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface CRMChatRouteContract {
  readonly method: CRMChatHttpMethod;
  /** Path below `/api/v1/CRMChat`, e.g. `action/capabilities`. */
  readonly path: string;
  /** Capability the route requires, checked server-side before anything else. */
  readonly capability: CRMChatCapabilityKey | 'none';
  /** Feature flag that must additionally be effective, if any. */
  readonly feature: CRMChatFeatureKey | null;
  /** Sub-phase that owns the route. */
  readonly phase: string;
  /** Whether the route exists in the running application. */
  readonly implemented: boolean;
  readonly summary: string;
}

export const CRM_CHAT_ROUTES: readonly CRMChatRouteContract[] = [
  {
    method: 'GET',
    path: 'action/capabilities',
    capability: 'use',
    feature: null,
    phase: '19-CHAT.2',
    implemented: true,
    summary: 'What this caller may do, feature effectiveness, assistant readiness and limits.',
  },
  {
    method: 'GET',
    path: 'action/health',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.2',
    implemented: true,
    summary: 'Module diagnostics: dependency evidence, structures and safe checks.',
  },
  {
    method: 'GET',
    path: 'action/settings',
    capability: 'admin',
    feature: null,
    phase: '19-CHAT.2',
    implemented: true,
    summary: 'The validated crmChat settings row, its version and its warnings.',
  },
  {
    method: 'POST',
    path: 'action/settings',
    capability: 'admin',
    feature: null,
    phase: '19-CHAT.2',
    implemented: true,
    summary: 'Patch flags, limits, retention or the assistant agent key; returns the new view.',
  },
  {
    method: 'GET',
    path: 'action/conversations',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.4',
    implemented: true,
    summary: 'The caller’s own conversations, paginated with { list, total, offset, count }.',
  },
  {
    method: 'GET',
    path: 'action/conversations/:id',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.4',
    implemented: true,
    summary: 'One conversation the caller owns, with its newest page of messages.',
  },
  {
    method: 'GET',
    path: 'action/conversations/:id/messages',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.4',
    implemented: true,
    summary: 'Keyset-paginated history with a stable `before` sequence cursor.',
  },
  {
    method: 'PATCH',
    path: 'action/conversations/:id',
    capability: 'manage',
    feature: 'workspace',
    phase: '19-CHAT.4',
    implemented: true,
    summary: 'Rename, archive or reopen one conversation the caller owns.',
  },
  {
    method: 'DELETE',
    path: 'action/conversations/:id',
    capability: 'delete',
    feature: 'workspace',
    phase: '19-CHAT.4',
    implemented: true,
    summary: 'Mark one conversation the caller owns deleted; the retention sweep removes it.',
  },
  {
    method: 'POST',
    path: 'action/turns',
    capability: 'use',
    feature: 'readTools',
    phase: '19-CHAT.5',
    implemented: true,
    summary: 'Submit a turn; creates the conversation on first use and returns a run-backed turn.',
  },
  {
    method: 'GET',
    path: 'action/turns/:turnId',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.5',
    implemented: true,
    summary: 'The projected turn state, citations and usage.',
  },
  {
    method: 'POST',
    path: 'action/turns/:turnId/cancel',
    capability: 'manage',
    feature: 'workspace',
    phase: '19-CHAT.5',
    implemented: true,
    summary: 'Ask the runtime to cancel; answers with the state the server actually reached.',
  },
  {
    method: 'GET',
    path: 'action/turns/:turnId/events',
    capability: 'use',
    feature: 'workspace',
    phase: '19-CHAT.6',
    implemented: true,
    summary: 'SSE stream for one turn, resumable with Last-Event-ID.',
  },
  {
    method: 'POST',
    path: 'action/turns/:turnId/feedback',
    capability: 'feedback',
    feature: 'workspace',
    phase: '19-CHAT.11',
    implemented: false,
    summary: 'Rate one assistant answer authored in a conversation the caller owns.',
  },
  {
    method: 'GET',
    path: 'action/actions/:approvalId',
    capability: 'use',
    feature: 'actionProposals',
    phase: '19-CHAT.12',
    implemented: false,
    summary: 'The typed proposal: targets, before/after values, side effects and expiry.',
  },
  {
    method: 'POST',
    path: 'action/actions/:approvalId/confirm',
    capability: 'manage',
    feature: 'actionProposals',
    phase: '19-CHAT.12',
    implemented: false,
    summary: 'Confirm a proposal; requires safety.allowWrites and revalidates at execution time.',
  },
  {
    method: 'POST',
    path: 'action/actions/:approvalId/reject',
    capability: 'manage',
    feature: 'actionProposals',
    phase: '19-CHAT.12',
    implemented: false,
    summary: 'Reject a proposal; the run resumes without executing it.',
  },
  {
    method: 'GET',
    path: 'action/prompts',
    capability: 'prompts',
    feature: 'workspace',
    phase: '19-CHAT.14',
    implemented: false,
    summary: 'The caller’s saved prompt templates.',
  },
  {
    method: 'POST',
    path: 'action/prompts',
    capability: 'prompts',
    feature: 'workspace',
    phase: '19-CHAT.14',
    implemented: false,
    summary: 'Create a template; its text is data and is never executed.',
  },
  {
    method: 'PATCH',
    path: 'action/prompts/:id',
    capability: 'prompts',
    feature: 'workspace',
    phase: '19-CHAT.14',
    implemented: false,
    summary: 'Rename, edit or disable one template the caller owns.',
  },
  {
    method: 'DELETE',
    path: 'action/prompts/:id',
    capability: 'prompts',
    feature: 'workspace',
    phase: '19-CHAT.14',
    implemented: false,
    summary: 'Delete one template the caller owns.',
  },
];

/** Error codes the Chat surface may answer with; every one already exists in the platform. */
export const CRM_CHAT_ERROR_CODES: readonly {
  readonly code: string;
  readonly status: number;
  readonly meaning: string;
}[] = [
  { code: 'AUTHENTICATION_REQUIRED', status: 401, meaning: 'No session.' },
  { code: 'AUTHORIZATION_DENIED', status: 403, meaning: 'The caller does not hold the capability.' },
  { code: 'FEATURE_DISABLED', status: 403, meaning: 'An administrator has the feature switched off.' },
  { code: 'INVALID_QUERY', status: 400, meaning: 'The request body or query is malformed.' },
  { code: 'VALIDATION_FAILED', status: 422, meaning: 'A value reached the service and is not acceptable.' },
  { code: 'NOT_FOUND', status: 404, meaning: 'No such conversation, turn or proposal — for this caller.' },
  { code: 'CONCURRENCY_CONFLICT', status: 409, meaning: 'The record changed since it was read (stale approval, title clash).' },
  { code: 'RATE_LIMITED', status: 429, meaning: 'The kernel rate limiter, or a per-user turn/budget limit, refused the request.' },
  { code: 'CHAT_TURN_LIMITED', status: 429, meaning: 'The caller already has the maximum active turns.' },
  { code: 'CHAT_AGENT_UNAVAILABLE', status: 503, meaning: 'The configured assistant is not ready; details.state explains why.' },
  { code: 'CHAT_PROVIDER_UNAVAILABLE', status: 503, meaning: 'The provider failed; the turn is reported as failed, never as succeeded.' },
  { code: 'CHAT_APPROVAL_REQUIRED', status: 409, meaning: 'The turn is waiting for a confirmed proposal.' },
  { code: 'CHAT_CONTEXT_TOO_LARGE', status: 422, meaning: 'More context references than limits.maxContextRefs.' },
];

/** Stream events, in the order the contract describes them. `assistant.delta` is deliberately absent. */
export const CRM_CHAT_STREAM_EVENTS: readonly string[] = [
  'turn.started',
  'tool.started',
  'tool.completed',
  'citation.added',
  'action.proposed',
  'approval.required',
  'assistant.message',
  'usage.summary',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'heartbeat',
];

/** Everything the contract forbids Chat from doing, kept as data so a review can point at it. */
export const CRM_CHAT_BLOCKED_CAPABILITIES: readonly string[] = [
  'bulk-destructive-operations',
  'acl-and-role-changes',
  'credential-management',
  'payments',
  'invoice-issue-or-void',
  'campaign-sends',
  'external-messaging',
  'provider-configuration',
  'tool-registration',
  'raw-sql',
];
