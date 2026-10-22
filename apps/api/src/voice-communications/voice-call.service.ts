/**
 * Phase 19-VC.7 — call sessions, provider correlation and the Call Activity
 * (`PLAN_Phase_19_Voice_Communications.md` §7.3–§7.4, §15 `19-VC.7`).
 *
 * One logical call is one `voice_call_sessions` row, correlated with the provider by
 * `(account_key, provider_call_id)`. Replayed or out-of-order callbacks update that row through
 * `advanceCallState`, which never lets a terminal state regress — a duplicate `ringing` after
 * `completed` changes nothing (§7.4 "incoming event reconciliation must update one logical call
 * record").
 *
 * The user-facing record is the platform's `Call` Activity. This service creates it once and then
 * updates it, so an agent never sees two calls for one conversation, and it refuses to invent a
 * `completed` outcome the provider never reported (§7.3, §15 acceptance).
 *
 * Writes go through `EntityCrudService`, not raw SQL, so ACL, field permissions, dynamic logic,
 * audit, stream and hooks all apply exactly as they do to a hand-created Call (§7.4 acceptance).
 */
import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { PHONE_NORMALIZER, phoneMatchKeys, type PhoneNormalizer } from './phone-number.js';
import { VoiceCallNotificationService } from './voice-call-notification.service.js';
import {
  advanceCallState,
  CALL_ACTIVITY_DIRECTION,
  CALL_ACTIVITY_STATUS,
  CALL_CONTROL_ACTIONS,
  type CallControlAction,
  callControlCapabilityFor,
  callControlTargetState,
  type CallState,
  canControlCall,
  canTransitionCall,
  isCallTerminal,
  type ProviderCapability,
  sendCapabilityFor,
} from './voice-communications-domain.js';
import { VoiceCommunicationsSettingsService } from './voice-communications-settings.service.js';
import { VoicePolicyService } from './voice-policy.service.js';
import {
  type CallControlResult,
  effectiveCapabilities,
  type InitiateCallResult,
  VoiceProviderError,
  VoiceProviderRegistry,
} from './voice-provider.js';
import { VoiceProviderAccountsService } from './voice-provider-accounts.service.js';

/** The platform Activity entity that carries the user-facing call record (PLAN §27). */
export const CALL_ACTIVITY_ENTITY = 'Call';

export interface CallSessionRow {
  id: string;
  account_key: string;
  endpoint_id: string | null;
  direction: string;
  state: string;
  provider_call_id: string | null;
  from_number: string | null;
  to_number: string | null;
  from_display: string | null;
  to_display: string | null;
  started_at: Date | null;
  answered_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  result: string | null;
  failure_category: string | null;
  initiator_user_id: string | null;
  assigned_user_id: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  recording_ref: string | null;
  activity_id: string | null;
  idempotency_key: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface CallSessionView {
  readonly id: string;
  readonly accountKey: string;
  readonly endpointId: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly state: CallState;
  readonly providerCallId: string | null;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly fromDisplay: string | null;
  readonly toDisplay: string | null;
  readonly startedAt: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly durationSeconds: number | null;
  readonly result: string | null;
  readonly failureCategory: string | null;
  readonly initiatorUserId: string | null;
  readonly assignedUserId: string | null;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly activityId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/** The popup's row: a session plus the controls this caller may actually use on it. */
export interface IncomingCallView extends CallSessionView {
  readonly controls: readonly CallControlAction[];
}

/** States that keep an inbound call on the agent's screen: ringing, and answered but not ended. */
const POPUP_CALL_STATES: readonly CallState[] = ["ringing", "in_progress"];

export interface InitiateCallInput {
  readonly to: string;
  readonly accountKey?: string | undefined;
  readonly endpointKey?: string | undefined;
  /** Client-generated key: a repeated click reuses the same call instead of placing a second one. */
  readonly idempotencyKey: string;
  readonly relatedEntityType?: string | undefined;
  readonly relatedEntityId?: string | undefined;
}

@Injectable()
export class VoiceCallService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(VoicePolicyService) private readonly policy: VoicePolicyService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(VoiceCallNotificationService) private readonly notifications: VoiceCallNotificationService,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  /**
   * Click-to-call (§7.1, §15 `19-VC.8`). The order is the contract: permission and policy first, the
   * durable session second, the provider call last, so a provider outage leaves an actionable
   * `failed` session rather than a phantom call.
   *
   * `idempotencyKey` comes from the client. A repeated click (or a retried request after a network
   * timeout) finds the existing session by that key and returns it unchanged — no second provider
   * call is placed (§7.1 acceptance: "a network timeout does not cause an uncontrolled duplicate
   * call on retry").
   */
  async initiate(input: InitiateCallInput): Promise<{ readonly session: CallSessionView; readonly duplicate: boolean }> {
    // Permission before policy, policy before the durable row, the row before the provider call.
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'create');
    const settings = await this.settings.settings();
    const accountKey = (input.accountKey ?? settings.provider.defaultAccountKey).trim();
    if (accountKey === '') {
      throw new ValidationError('No provider account is configured for calls; name one or set provider.defaultAccountKey.');
    }

    const evaluation = await this.policy.evaluate({ channel: 'voice', address: input.to, accountKey });
    if (!evaluation.allowed) {
      throw new ValidationError('This call is not permitted.', { refusals: evaluation.refusals.map((r) => r.code) });
    }

    const normalized = this.phones.normalize(input.to, settings.policy.defaultRegion);
    if (!normalized.valid || normalized.e164 === null) throw new ValidationError('The destination number is not valid.');
    const toNumber = normalized.e164;

    // A duplicate key must not even reach the provider: return the session it created.
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) return { session: toView(existing), duplicate: true };

    const account = await this.accounts.resolve(accountKey);
    const adapter = this.registry.resolve(account.providerKey);
    const capability = sendCapabilityFor('voice');
    if (capability === null || !effectiveCapabilities(adapter.info, account.capabilities).includes(capability)) {
      throw new ValidationError(`Provider "${account.providerKey}" does not declare ${capability ?? 'voice.outboundCall'}.`);
    }
    if (adapter.initiateCall === undefined) {
      throw new ValidationError('This provider adapter cannot place calls.');
    }

    const endpoint = await this.resolveEndpoint(accountKey, input.endpointKey);
    const id = randomUUID();
    const now = new Date();
    await sql`
      insert into voice_call_sessions
        (id, account_key, endpoint_id, direction, state, to_number, to_display,
         initiator_user_id, assigned_user_id, related_entity_type, related_entity_id,
         idempotency_key, created_at, modified_at)
      values
        (${id}, ${accountKey}, ${endpoint.id}, 'outbound', 'requested', ${toNumber}, ${input.to.trim()},
         ${this.scope.userId ?? null}, ${this.scope.userId ?? null},
         ${input.relatedEntityType ?? null}, ${input.relatedEntityId ?? null},
         ${input.idempotencyKey}, ${now}, ${now})
    `.execute(this.database.db);

    let result: InitiateCallResult;
    try {
      result = await adapter.initiateCall({
        account,
        from: endpoint.address,
        to: toNumber,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      // An uncertain outcome must not be recorded as a completed call: the category is kept, and the
      // session stays inspectable (§7.1 "preserve an actionable failure state").
      const category = error instanceof VoiceProviderError ? error.category : 'unknown';
      const detail = error instanceof Error ? error.message : 'The provider refused the call.';
      await this.patchSession(id, { state: 'failed', failureCategory: category, result: detail, endedAt: now });
      const failed = await this.requireRow(id);
      await this.syncActivity(failed);
      // Re-read: `syncActivity` records the Activity id on the row, and the caller must see it.
      return { session: toView(await this.requireRow(id)), duplicate: false };
    }

    const updated = await this.patchSession(id, {
      state: result.accepted ? result.state : 'failed',
      providerCallId: result.providerCallId,
      failureCategory: result.accepted ? null : (result.errorCategory ?? 'unknown'),
      result: result.error ?? null,
      startedAt: now,
    });
    await this.syncActivity(updated);
    return { session: toView(await this.requireRow(id)), duplicate: false };
  }

  /**
   * Reconcile a provider call event into the logical session (§7.4). The session is found by
   * `(account_key, provider_call_id)`; a callback that arrives before any session exists (an inbound
   * call nobody dialled) creates one — a single inbound event must not produce two records.
   *
   * `advanceCallState` is what makes replay safe: a terminal state never regresses, so replayed or
   * out-of-order callbacks update the same row and only the first one creates the Activity.
   */
  async applyCallEvent(input: {
    readonly accountKey: string;
    readonly providerCallId: string;
    readonly event: {
      readonly state: CallState;
      readonly direction: 'inbound' | 'outbound';
      readonly from: string | null;
      readonly to: string | null;
      readonly occurredAt: string | null;
      readonly durationSeconds: number | null;
      readonly failureCategory: string | null;
      readonly vendorStatus: string | null;
    };
  }): Promise<{ readonly id: string; readonly changed: boolean; readonly state: CallState }> {
    let row = await this.findByProviderCall(input.accountKey, input.providerCallId);
    let created = false;
    if (row === undefined) {
      const id = randomUUID();
      const now = new Date();
      // An inbound callback names the number that rang: resolve it to the configured endpoint so the
      // popup can be routed to that endpoint's team (§7.2). No endpoint means no team routing.
      const endpoint = input.event.direction === 'inbound' && input.event.to !== null
        ? await this.findEndpointByAddress(input.accountKey, input.event.to)
        : undefined;
      await sql`
        insert into voice_call_sessions
          (id, account_key, endpoint_id, direction, state, provider_call_id, from_number, to_number,
           started_at, failure_category, created_at, modified_at)
        values
          (${id}, ${input.accountKey}, ${endpoint?.id ?? null}, ${input.event.direction}, ${input.event.state},
           ${input.providerCallId}, ${input.event.from}, ${input.event.to},
           ${input.event.occurredAt === null ? now : new Date(input.event.occurredAt)},
           ${input.event.failureCategory}, ${now}, ${now})
        on conflict (account_key, provider_call_id) where provider_call_id is not null do nothing
      `.execute(this.database.db);
      row = await this.findByProviderCall(input.accountKey, input.providerCallId);
      if (row === undefined) {
        // Another worker won the insert concurrently; treat this callback as a duplicate.
        return { id, changed: false, state: input.event.state };
      }
      created = true;
    }

    const previous = row.state as CallState;
    const next = advanceCallState(previous, input.event.state);
    // A freshly created row must still run the side effects below (the popup for a ringing inbound
    // call is the important one); only a *repeat* callback is a no-op.
    if (!created && next === previous && row.provider_call_id === input.providerCallId) {
      return { id: row.id, changed: false, state: next };
    }

    const occurredAt = input.event.occurredAt === null ? null : new Date(input.event.occurredAt);
    const updated = await this.patchSession(row.id, {
      state: next,
      providerCallId: row.provider_call_id ?? input.providerCallId,
      ...(input.event.from !== null && row.from_number === null ? { fromNumber: input.event.from } : {}),
      ...(input.event.to !== null && row.to_number === null ? { toNumber: input.event.to } : {}),
      ...(next === 'in_progress' && row.answered_at === null ? { answeredAt: occurredAt ?? new Date() } : {}),
      ...(input.event.durationSeconds !== null ? { durationSeconds: input.event.durationSeconds } : {}),
      ...(input.event.failureCategory !== null ? { failureCategory: input.event.failureCategory } : {}),
      ...(occurredAt !== null ? { endedAt: occurredAt } : {}),
    });
    await this.syncActivity(updated);
    if (next === "ringing" && updated.direction === "inbound") {
      // The popup is addressed to the call's owner or the endpoint's team, never broadcast (§7.2).
      await this.notifications.incomingCall({
        sessionId: updated.id,
        accountKey: updated.account_key,
        endpointId: updated.endpoint_id,
        assignedUserId: updated.assigned_user_id,
        fromDisplay: updated.from_display,
        fromNumber: updated.from_number,
      });
    }
    return { id: updated.id, changed: true, state: next };
  }

  /**
   * Create or update the platform `Call` for a session (§7.4). Created lazily on the first state the
   * provider actually accepted, so a call that never left `requested` produces no Activity, and
   * `unknown` never becomes a `Held` call (§15 acceptance).
   *
   * The write goes through `EntityCrudService` while running under the documented service identity,
   * so audit, stream, field permissions and dynamic logic all see an ordinary Call mutation.
   */
  private async syncActivity(session: CallSessionRow): Promise<void> {
    if (session.state === 'requested') return;
    const payload: Record<string, unknown> = {
      name: session.direction === 'inbound'
        ? `Incoming call ${session.from_display ?? session.from_number ?? ''}`.trim()
        : `Outgoing call ${session.to_display ?? session.to_number ?? ''}`.trim(),
      direction: CALL_ACTIVITY_DIRECTION[session.direction === 'inbound' ? 'inbound' : 'outbound'],
      status: CALL_ACTIVITY_STATUS[session.state as CallState],
      // The entity API speaks JSON: timestamps are ISO strings, never Date objects.
      dateStart: (session.answered_at ?? session.started_at ?? session.created_at).toISOString(),
      ...(session.ended_at !== null ? { dateEnd: session.ended_at.toISOString() } : {}),
      ...(session.duration_seconds !== null ? { duration: session.duration_seconds } : {}),
      ...(session.result !== null && session.result !== '' ? { description: session.result } : {}),
    };

    if (session.activity_id !== null) {
      await this.entities.update(CALL_ACTIVITY_ENTITY, session.activity_id, payload);
      return;
    }
    const created = await this.entities.create(CALL_ACTIVITY_ENTITY, payload);
    const activityId = typeof created['id'] === 'string' ? created['id'] : null;
    if (activityId === null) return;
    await this.patchSession(session.id, { activityId });
    if (session.related_entity_type !== null && session.related_entity_id !== null) {
      await this.linkActivity(activityId, session.related_entity_type, session.related_entity_id);
    }
  }

  /** ACL-scoped list. The `Call` entity's own read level decides the scope, never a module guess. */
  async list(query: {
    readonly limit: number;
    readonly offset: number;
    readonly state?: string | undefined;
    readonly states?: readonly string[] | undefined;
  }): Promise<readonly CallSessionView[]> {
    const scope = await this.readScope();
    if (scope === 'none') return [];
    const userId = this.scope.userId ?? null;
    const states = query.states ?? (query.state === undefined ? [] : [query.state]);
    const statePredicate =
      states.length === 0 ? sql`true` : sql`state in (${sql.join(states.map((value) => sql.val(value)))})`;
    const rows = await sql<CallSessionRow>`
      select * from voice_call_sessions
      where ${statePredicate}
        and ${
          scope === 'all'
            ? sql`true`
            : scope === 'own'
              ? sql`assigned_user_id = ${userId}`
              : sql`(assigned_user_id = ${userId} or assigned_user_id in (
                   select ut.user_id from users_teams ut
                   where ut.team_id in (select t2.team_id from users_teams t2 where t2.user_id = ${userId})))`
        }
      order by created_at desc
      limit ${query.limit} offset ${query.offset}
    `.execute(this.database.db);
    return rows.rows.map(toView);
  }

  /**
   * Inbound calls this caller may see that are still live: ringing, or answered and not yet ended.
   * Each row names the controls the server will actually honour for it, so the popup never shows a
   * hang-up the provider cannot perform (§7.2, §11.2).
   */
  async incoming(): Promise<readonly IncomingCallView[]> {
    const rows = await this.list({ limit: 20, offset: 0, states: POPUP_CALL_STATES });
    const grantedByAccount = new Map<string, readonly ProviderCapability[]>();
    const views: IncomingCallView[] = [];
    for (const session of rows) {
      if (session.direction !== 'inbound') continue;
      views.push({
        ...session,
        controls: await this.controlsFor(session.accountKey, session.state, grantedByAccount),
      });
    }
    return views;
  }

  /**
   * Answer or end a call the agent can see (§7.1, §11.2). The order is the contract: permission, then
   * session visibility, then the live state, then the granted capability, and the provider control
   * last — a provider that refuses leaves the session exactly as it was instead of a call the CRM
   * believes has finished.
   */
  async control(id: string, action: CallControlAction): Promise<CallSessionView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'edit');
    const row = await this.requireRow(id);
    await this.assertCanRead(row);
    const current = row.state as CallState;
    if (!canControlCall(current, action)) {
      throw new ValidationError(`A call in state "${current}" cannot be ${action === 'answer' ? 'answered' : 'ended'}.`);
    }

    const account = await this.accounts.resolve(row.account_key);
    const adapter = this.registry.resolve(account.providerKey);
    const capability = callControlCapabilityFor(action);
    // Name the real cause: an adapter that cannot do it and an account that was never granted it need
    // different fixes from the operator.
    if (!adapter.info.capabilities.includes(capability)) {
      throw new ValidationError(`Provider "${account.providerKey}" does not implement ${capability}.`);
    }
    if (!account.capabilities.includes(capability)) {
      throw new ValidationError(
        `Provider account "${account.key}" is not granted ${capability}; grant it on the account before this call can be controlled.`,
      );
    }
    if (adapter.controlCall === undefined) throw new ValidationError('This provider adapter cannot control calls.');
    if (row.provider_call_id === null) {
      throw new ValidationError('This call has no provider id, so the provider cannot be told about it.');
    }

    let result: CallControlResult;
    try {
      result = await adapter.controlCall({
        account,
        providerCallId: row.provider_call_id,
        action,
        state: current,
      });
    } catch (error) {
      const detail = error instanceof VoiceProviderError
        ? `${error.message} (${error.category})`
        : 'The provider refused the control.';
      throw new ValidationError(detail);
    }
    if (!result.accepted) {
      throw new ValidationError(result.error ?? 'The provider refused the control.');
    }

    // The provider's own state wins when it is a legal successor; otherwise the control's outcome is
    // the state the machine expects, never something invented.
    const target = canTransitionCall(current, result.state) ? result.state : callControlTargetState(current, action);
    const now = new Date();
    const updated = await this.patchSession(row.id, {
      state: target,
      ...(target === 'in_progress' && row.answered_at === null ? { answeredAt: now } : {}),
      ...(isCallTerminal(target) && row.ended_at === null ? { endedAt: now } : {}),
      ...(isCallTerminal(target) && row.duration_seconds === null ? { durationSeconds: elapsedSeconds(row.answered_at, now) } : {}),
      // An agent who answers an unassigned inbound call owns it, so their own-scoped views keep it.
      ...(action === 'answer' && row.assigned_user_id === null && this.scope.userId !== undefined
        ? { assignedUserId: this.scope.userId }
        : {}),
    });
    await this.syncActivity(updated);
    return toView(updated);
  }

  async get(id: string): Promise<CallSessionView> {
    const row = await this.requireRow(id);
    await this.assertCanRead(row);
    return toView(row);
  }

  /** A call note is a normal Call edit: ACL, audit and field permissions apply (§7.4). */
  async note(id: string, description: string): Promise<CallSessionView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'edit');
    const row = await this.requireRow(id);
    await this.assertCanRead(row);
    const text = description.trim();
    if (text === '') throw new ValidationError('A call note cannot be empty.');
    const activityId = row.activity_id;
    if (activityId !== null && row.state !== 'requested') {
      const existing = await this.entities.get(CALL_ACTIVITY_ENTITY, activityId, 'description');
      const prior = typeof existing['description'] === 'string' ? existing['description'] : '';
      await this.entities.update(CALL_ACTIVITY_ENTITY, activityId, {
        description: prior === '' ? text : `${prior}\n${text}`,
      });
    }
    const patched = await this.patchSession(id, { result: text });
    return toView(patched);
  }

  /** Link the call to a permitted CRM record; the relation is stored on the session and the Activity. */
  async link(id: string, entityType: string, entityId: string): Promise<CallSessionView> {
    await this.acl.assertAccess(CALL_ACTIVITY_ENTITY, 'edit');
    const row = await this.requireRow(id);
    await this.assertCanRead(row);
    const allowed = await this.acl.canUser(entityType, 'read');
    if (allowed === 'no') throw new ValidationError(`You may not read "${entityType}" records.`);
    // `get` throws when the record is absent, so this also proves the target exists.
    await this.entities.get(entityType, entityId, 'id');
    const patched = await this.patchSession(id, { relatedEntityType: entityType, relatedEntityId: entityId });
    if (patched.activity_id !== null) await this.linkActivity(patched.activity_id, entityType, entityId);
    return toView(patched);
  }

  /**
   * Caller context for the incoming-call popup (§7.2). Only records this user may read are returned,
   * and an ambiguous match stays ambiguous — the popup disambiguates instead of this service choosing.
   */
  async contextFor(id: string): Promise<{
    readonly session: CallSessionView;
    readonly matches: readonly { readonly entityType: string; readonly id: string; readonly name: string }[];
    readonly hiddenMatches: number;
  }> {
    const row = await this.requireRow(id);
    await this.assertCanRead(row);
    const address = row.direction === 'inbound' ? (row.from_number ?? '') : (row.to_number ?? '');
    const matches: { entityType: string; id: string; name: string }[] = [];
    if (address !== '') {
      const resolved = await this.resolverMatches(address);
      matches.push(...resolved.matches);
    }
    return { session: toView(row), matches, hiddenMatches: await this.countHidden(address) };
  }

  /** Exposed for the resolver so the popup and the resolver endpoint share one rule. */
  private async resolverMatches(address: string): Promise<{ matches: { entityType: string; id: string; name: string }[] }> {
    const keys = phoneMatchKeys(this.phones.normalize(address, (await this.settings.settings()).policy.defaultRegion));
    if (keys.length === 0) return { matches: [] };
    const keyList = sql.join(keys.map((key) => sql.val(key)));
    const rows = await sql<{ id: string; entity_type: string; name: string | null; attrs: unknown; assigned_user_id: string | null; created_by_id: string | null; team_ids: unknown }>`
      select id, entity_type, name, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where deleted_at is null
        and entity_type in ('Contact', 'Lead', 'Account')
        and regexp_replace(coalesce(attrs->>'phoneNumber', ''), '[^0-9]', '', 'g') in (${keyList})
      limit 50
    `.execute(this.database.db);
    const matches: { entityType: string; id: string; name: string }[] = [];
    for (const row of rows.rows) {
      const decision = await this.acl.canAccessRecord(row.entity_type, 'read', {
        id: row.id,
        data: typeof row.attrs === 'object' && row.attrs !== null ? (row.attrs as Record<string, unknown>) : {},
        ...(row.assigned_user_id !== null ? { assignedUserId: row.assigned_user_id } : {}),
        ...(row.created_by_id !== null ? { createdById: row.created_by_id } : {}),
        ...(Array.isArray(row.team_ids) ? { teams: row.team_ids as string[] } : {}),
      });
      if (!decision.allowed) continue;
      matches.push({ entityType: row.entity_type, id: row.id, name: row.name ?? row.id });
    }
    return { matches };
  }

  private async countHidden(address: string): Promise<number> {
    if (address === '') return 0;
    const keys = phoneMatchKeys(this.phones.normalize(address, (await this.settings.settings()).policy.defaultRegion));
    if (keys.length === 0) return 0;
    const keyList = sql.join(keys.map((key) => sql.val(key)));
    const rows = await sql<{ id: string; entity_type: string; attrs: unknown; assigned_user_id: string | null; created_by_id: string | null; team_ids: unknown }>`
      select id, entity_type, attrs, assigned_user_id, created_by_id, team_ids
      from entity_records
      where deleted_at is null
        and entity_type in ('Contact', 'Lead', 'Account')
        and regexp_replace(coalesce(attrs->>'phoneNumber', ''), '[^0-9]', '', 'g') in (${keyList})
      limit 50
    `.execute(this.database.db);
    let hidden = 0;
    for (const row of rows.rows) {
      const decision = await this.acl.canAccessRecord(row.entity_type, 'read', {
        id: row.id,
        data: typeof row.attrs === 'object' && row.attrs !== null ? (row.attrs as Record<string, unknown>) : {},
        ...(row.assigned_user_id !== null ? { assignedUserId: row.assigned_user_id } : {}),
        ...(row.created_by_id !== null ? { createdById: row.created_by_id } : {}),
        ...(Array.isArray(row.team_ids) ? { teams: row.team_ids as string[] } : {}),
      });
      if (!decision.allowed) hidden += 1;
    }
    return hidden;
  }

  // ------------------------------------------------------------------------- internals

  /**
   * Controls this account really supports for a call in `state`: the adapter's declaration intersected
   * with the account's grant, cached per account for one popup refresh. An unresolvable account yields
   * no controls, so the popup degrades to the informational card instead of a button that will fail.
   */
  private async controlsFor(
    accountKey: string,
    state: CallState,
    cache: Map<string, readonly ProviderCapability[]>,
  ): Promise<readonly CallControlAction[]> {
    let granted = cache.get(accountKey);
    if (granted === undefined) {
      try {
        const account = await this.accounts.resolve(accountKey);
        granted = effectiveCapabilities(this.registry.resolve(account.providerKey).info, account.capabilities);
      } catch {
        granted = [];
      }
      cache.set(accountKey, granted);
    }
    return CALL_CONTROL_ACTIONS.filter(
      (action) => canControlCall(state, action) && granted.includes(callControlCapabilityFor(action)),
    );
  }

  private async readScope(): Promise<'all' | 'own' | 'team' | 'none'> {
    const level = await this.acl.canUser(CALL_ACTIVITY_ENTITY, 'read');
    if (level === 'no') return 'none';
    if (level === 'all' || level === 'yes') return 'all';
    if (level === 'own') return 'own';
    return 'team';
  }

  private async assertCanRead(row: CallSessionRow): Promise<void> {
    const scope = await this.readScope();
    if (scope === 'none') throw new NotFoundError('No call session access.');
    if (scope === 'all') return;
    const userId = this.scope.userId;
    if (userId !== undefined && row.assigned_user_id === userId) return;
    if (scope === 'team' && userId !== undefined) {
      const membership = await sql<{ team_id: string }>`
        select ut.team_id from users_teams ut
        where ut.user_id = ${userId}
      `.execute(this.database.db);
      if (membership.rows.length > 0 && row.assigned_user_id !== null) {
        const shares = await sql<{ user_id: string }>`
          select user_id from users_teams
          where team_id in (${sql.join(membership.rows.map((r) => sql.val(r.team_id)))})
            and user_id = ${row.assigned_user_id}
          limit 1
        `.execute(this.database.db);
        if (shares.rows.length > 0) return;
      }
    }
    throw new NotFoundError('No call session access.');
  }

  /** The caller id endpoint for the account: the named one, else the first active voice endpoint. */
  private async resolveEndpoint(accountKey: string, endpointKey?: string | undefined): Promise<{ id: string; address: string }> {
    const wanted = (endpointKey ?? "").trim();
    const row = wanted === ""
      ? (await sql<{ id: string; address: string }>`
          select id, address from voice_endpoints
          where account_key = ${accountKey} and channel = 'voice' and active = true
          order by created_at asc limit 1
        `.execute(this.database.db)).rows[0]
      : (await sql<{ id: string; address: string }>`
          select id, address from voice_endpoints
          where account_key = ${accountKey} and key = ${wanted} and channel = 'voice' and active = true
          limit 1
        `.execute(this.database.db)).rows[0];
    if (row === undefined) {
      throw new ValidationError(
        wanted === ""
          ? "No active voice endpoint is configured for this account; register the sender number first."
          : `Endpoint "${wanted}" is not an active voice endpoint for this account.`,
      );
    }
    return { id: row.id, address: row.address };
  }

  private async linkActivity(activityId: string, entityType: string, entityId: string): Promise<void> {
    // The Call relation set is the activity convention (accounts/contacts/users). A lead or other
    // target uses the generic relation row the platform links store.
    const relation =
      entityType === 'Account' ? 'accounts' : entityType === 'Contact' ? 'contacts' : entityType === 'User' ? 'users' : null;
    if (relation === null) {
      await sql`
        insert into entity_links (id, entity_type_a, record_id_a, relation_name, entity_type_b, record_id_b, created_at)
        values (${randomUUID()}, ${CALL_ACTIVITY_ENTITY}, ${activityId}, ${`voice${entityType}`}, ${entityType}, ${entityId}, now())
        on conflict do nothing
      `.execute(this.database.db);
      return;
    }
    await this.entities.update(CALL_ACTIVITY_ENTITY, activityId, { [relation]: [entityId] });
  }

  private async findEndpointByAddress(accountKey: string, address: string): Promise<{ id: string } | undefined> {
    return (await sql<{ id: string }>`
      select id from voice_endpoints
      where account_key = ${accountKey} and channel = 'voice' and address = ${address}
      limit 1
    `.execute(this.database.db)).rows[0];
  }

  private async findByProviderCall(accountKey: string, providerCallId: string): Promise<CallSessionRow | undefined> {
    return (await sql<CallSessionRow>`
      select * from voice_call_sessions
      where account_key = ${accountKey} and provider_call_id = ${providerCallId}
      limit 1
    `.execute(this.database.db)).rows[0];
  }

  private async findByIdempotencyKey(key: string): Promise<CallSessionRow | undefined> {
    const trimmed = key.trim();
    if (trimmed === '') return undefined;
    return (await sql<CallSessionRow>`
      select * from voice_call_sessions where idempotency_key = ${trimmed} limit 1
    `.execute(this.database.db)).rows[0];
  }

  private async requireRow(id: string): Promise<CallSessionRow> {
    const row = (await sql<CallSessionRow>`
      select * from voice_call_sessions where id = ${id}
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Call session "${id}" does not exist.`);
    return row;
  }

  /** A partial write that always refreshes `modified_at`; returns the stored row. */
  private async patchSession(
    id: string,
    patch: {
      readonly state?: CallState | undefined;
      readonly providerCallId?: string | null | undefined;
      readonly fromNumber?: string | null | undefined;
      readonly toNumber?: string | null | undefined;
      readonly startedAt?: Date | null | undefined;
      readonly answeredAt?: Date | null | undefined;
      readonly endedAt?: Date | null | undefined;
      readonly durationSeconds?: number | null | undefined;
      readonly failureCategory?: string | null | undefined;
      readonly result?: string | null | undefined;
      readonly activityId?: string | null | undefined;
      readonly relatedEntityType?: string | null | undefined;
      readonly relatedEntityId?: string | null | undefined;
      readonly assignedUserId?: string | null | undefined;
    },
  ): Promise<CallSessionRow> {
    // Built as expressions, not interpolated SQL: every value stays a bound parameter, and the
    // column names are a closed set written by this file.
    const assignments = [sql`modified_at = now()`];
    if (patch.state !== undefined) assignments.push(sql`state = ${patch.state}`);
    if (patch.providerCallId !== undefined) assignments.push(sql`provider_call_id = ${patch.providerCallId}`);
    if (patch.fromNumber !== undefined) assignments.push(sql`from_number = ${patch.fromNumber}`);
    if (patch.toNumber !== undefined) assignments.push(sql`to_number = ${patch.toNumber}`);
    if (patch.startedAt !== undefined) assignments.push(sql`started_at = ${patch.startedAt}`);
    if (patch.answeredAt !== undefined) assignments.push(sql`answered_at = ${patch.answeredAt}`);
    if (patch.endedAt !== undefined) assignments.push(sql`ended_at = ${patch.endedAt}`);
    if (patch.durationSeconds !== undefined) assignments.push(sql`duration_seconds = ${patch.durationSeconds}`);
    if (patch.failureCategory !== undefined) assignments.push(sql`failure_category = ${patch.failureCategory}`);
    if (patch.result !== undefined) assignments.push(sql`result = ${patch.result}`);
    if (patch.activityId !== undefined) assignments.push(sql`activity_id = ${patch.activityId}`);
    if (patch.relatedEntityType !== undefined) assignments.push(sql`related_entity_type = ${patch.relatedEntityType}`);
    if (patch.relatedEntityId !== undefined) assignments.push(sql`related_entity_id = ${patch.relatedEntityId}`);
    if (patch.assignedUserId !== undefined) assignments.push(sql`assigned_user_id = ${patch.assignedUserId}`);

    const combined = assignments.reduce((left, right) => sql`${left}, ${right}`);
    await sql`update voice_call_sessions set ${combined} where id = ${id}`.execute(this.database.db);
    return this.requireRow(id);
  }
}

/** Whole seconds between the answer and the end; null for a call that was never answered. */
function elapsedSeconds(from: Date | null, to: Date): number | null {
  if (from === null) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

function toView(row: CallSessionRow): CallSessionView {
  return {
    id: row.id,
    accountKey: row.account_key,
    endpointId: row.endpoint_id,
    direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
    state: row.state as CallState,
    providerCallId: row.provider_call_id,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    fromDisplay: row.from_display,
    toDisplay: row.to_display,
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    answeredAt: row.answered_at === null ? null : new Date(row.answered_at).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
    durationSeconds: row.duration_seconds,
    result: row.result,
    failureCategory: row.failure_category,
    initiatorUserId: row.initiator_user_id,
    assignedUserId: row.assigned_user_id,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    activityId: row.activity_id,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}
