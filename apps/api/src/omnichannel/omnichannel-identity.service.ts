import { randomUUID } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import {
  type ContactResolution,
  type ResolvedCandidate,
  VoiceContactResolverService,
} from '../voice-communications/index.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';

/**
 * Phase 19-OM.7 — identity review and record linking
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.7`; feature contract §6; migration 078).
 *
 * The matching itself stays with `VoiceContactResolverService` (phone normalization, bounded keys,
 * entity-level then record-level ACL, hidden matches never named). This service adds the Omnichannel
 * policy the contract §6 fixes around it:
 *
 *  - **Evidence, not guesses.** A unique readable match is `exact/verified` and linked; two or more
 *    readable matches are `disputed/heuristic`, the auto-link is dropped and the participant is
 *    listed for staff review. An unreadable match is counted by the resolver but never linked.
 *  - **A staff decision wins.** While `link_confidence = manual`, re-resolution never overwrites the
 *    link; only an explicit unlink clears it.
 *  - **Every staff change is authorized and auditable** — `identityLink` capability, Contact/Lead read
 *    through the ACL-aware entity service, and an `audit_log` row carrying the reason.
 *  - **Minimal disclosure.** The review names readable candidates only (type, id, display name from
 *    the resolver); no other field of the CRM record is copied or returned.
 *
 * Auto-links are explainable and reversible because confidence, reason and provenance are stored on
 * the participant rows (migration 077 columns), not inferred later.
 */

export interface OmnichannelIdentityCandidateView {
  readonly entityType: string;
  readonly id: string;
  readonly name: string;
}

export interface OmnichannelParticipantIdentityView {
  readonly participantId: string;
  readonly address: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly displayName: string | null;
  readonly verificationState: string;
  readonly linkConfidence: string;
  readonly linkReason: string | null;
  readonly sourceProvenance: string | null;
  readonly lastSeenAt: string | null;
  readonly resolution: ContactResolution['status'] | 'not_applicable';
  readonly candidates: readonly OmnichannelIdentityCandidateView[];
  readonly hiddenMatches: number;
  readonly truncated: boolean;
}

export interface OmnichannelIdentityReview {
  readonly conversationId: string;
  readonly channel: string;
  readonly participants: readonly OmnichannelParticipantIdentityView[];
}

export interface OmnichannelIdentityConflict {
  readonly participantId: string;
  readonly conversationId: string;
  readonly accountKey: string;
  readonly channel: string;
  readonly address: string;
  readonly linkReason: string | null;
  readonly candidates: number;
  readonly lastSeenAt: string | null;
}

interface ParticipantRow {
  id: string;
  conversation_id: string;
  address: string;
  role: string;
  entity_type: string | null;
  entity_id: string | null;
  display_name: string | null;
  verification_state: string;
  link_confidence: string;
  link_reason: string | null;
  source_provenance: string | null;
  last_seen_at: Date | null;
}

const LINKABLE_TYPES = new Set(['Contact', 'Lead']);

@Injectable()
export class OmnichannelIdentityService {
  constructor(
    @Inject(VoiceContactResolverService) private readonly resolver: VoiceContactResolverService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(OmnichannelPermissionService) private readonly permissions: OmnichannelPermissionService,
  ) {}

  /** Resolve every customer participant, persist the evidence, and report what is readable. */
  async review(conversationId: string): Promise<OmnichannelIdentityReview> {
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const conversation = await this.requireConversation(conversationId);
    const rows = await this.customerParticipants(conversationId);
    const participants: OmnichannelParticipantIdentityView[] = [];
    for (const row of rows) {
      const resolution = await this.resolver.resolve(row.address);
      await this.persistEvidence(row, resolution);
      const refreshed = await this.participant(row.id);
      participants.push(toIdentityView(refreshed ?? row, resolution));
    }
    return { conversationId, channel: conversation.channel, participants };
  }

  /** Staff link — validated by ACL on the target record, recorded with its reason in the audit log. */
  async link(
    conversationId: string,
    input: { readonly participantId?: string | undefined; readonly entityType: string; readonly entityId: string; readonly reason: string },
  ): Promise<OmnichannelIdentityReview> {
    await this.permissions.assert('identityLink');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const participant = await this.requireCustomerParticipant(conversationId, input.participantId);
    const entityType = input.entityType.trim();
    if (!LINKABLE_TYPES.has(entityType)) throw new ValidationError('An identity may link to a Contact or a Lead.');
    // The ACL-aware read is the authorization: a record this caller cannot read cannot be linked.
    const record = await this.entities.get(entityType, input.entityId.trim());
    const displayName = typeof (record as { data?: Record<string, unknown> }).data?.name === 'string'
      ? String((record as { data?: Record<string, unknown> }).data?.name)
      : null;
    const reason = input.reason.trim();
    if (reason === '') throw new ValidationError('A manual link needs a reason.');
    await sql`
      update voice_conversation_participants
      set entity_type = ${entityType}, entity_id = ${input.entityId.trim()}, display_name = ${displayName},
          verification_state = 'verified', link_confidence = 'manual', link_reason = ${reason},
          source_provenance = 'staff_link', last_seen_at = now()
      where id = ${participant.id}
    `.execute(this.database.db);
    await this.audit(conversationId, 'CommunicationIdentityLink', {
      participantId: participant.id,
      address: participant.address,
      from: { entityType: participant.entity_type, entityId: participant.entity_id, confidence: participant.link_confidence },
      to: { entityType, entityId: input.entityId.trim(), confidence: 'manual' },
      reason,
    });
    return this.review(conversationId);
  }

  /** Staff unlink — the manual decision is removed and the audit row keeps who/why. */
  async unlink(
    conversationId: string,
    input: { readonly participantId?: string | undefined; readonly reason: string },
  ): Promise<OmnichannelIdentityReview> {
    await this.permissions.assert('identityLink');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    const participant = await this.requireCustomerParticipant(conversationId, input.participantId);
    const reason = input.reason.trim();
    if (reason === '') throw new ValidationError('An unlink needs a reason.');
    await sql`
      update voice_conversation_participants
      set entity_type = null, entity_id = null, display_name = null,
          verification_state = 'unverified', link_confidence = 'none', link_reason = ${reason},
          source_provenance = 'staff_unlink', last_seen_at = now()
      where id = ${participant.id}
    `.execute(this.database.db);
    await this.audit(conversationId, 'CommunicationIdentityUnlink', {
      participantId: participant.id,
      address: participant.address,
      from: { entityType: participant.entity_type, entityId: participant.entity_id, confidence: participant.link_confidence },
      to: { entityType: null, entityId: null, confidence: 'none' },
      reason,
    });
    return this.review(conversationId);
  }

  /** The review list: disputed or heuristic auto-links of conversations the caller may read. */
  async conflicts(
    limit: number,
    offset = 0,
  ): Promise<{ readonly list: readonly OmnichannelIdentityConflict[]; readonly total: number; readonly limit: number; readonly offset: number; readonly hasMore: boolean }> {
    await this.permissions.assert('identityLink');
    await this.acl.assertAccess('CommunicationConversation', 'read');
    // The total is counted over the whole result, not over the page: a reviewer must know how many
    // conflicts are waiting, otherwise the last page looks like the last conflict.
    const counted = (await sql<{ n: number }>`
      select count(*)::int as n
      from voice_conversation_participants p
      join voice_conversations c on c.id = p.conversation_id
      where p.role = 'customer'
        and (p.verification_state = 'disputed' or p.link_confidence = 'heuristic')
    `.execute(this.database.db)).rows[0];
    const total = Number(counted?.n ?? 0);
    const rows = (await sql<{
      id: string;
      conversation_id: string;
      account_key: string;
      channel: string;
      address: string;
      link_reason: string | null;
      last_seen_at: Date | null;
    }>`
      select p.id, p.conversation_id, c.account_key, c.channel, p.address, p.link_reason, p.last_seen_at
      from voice_conversation_participants p
      join voice_conversations c on c.id = p.conversation_id
      where p.role = 'customer'
        and (p.verification_state = 'disputed' or p.link_confidence = 'heuristic')
      order by p.last_seen_at desc nulls last
      limit ${limit} offset ${offset}
    `.execute(this.database.db)).rows;
    return {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      list: rows.map((row) => ({
        participantId: row.id,
        conversationId: row.conversation_id,
        accountKey: row.account_key,
        channel: row.channel,
        address: row.address,
        linkReason: row.link_reason,
        candidates: row.link_reason?.startsWith('ambiguous_match:') ? Number(row.link_reason.split(':')[1] ?? '0') : 0,
        lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
      })),
    };
  }

  /**
   * Persist the evidence for one participant. A manual staff link is never overwritten; an
   * ambiguous result drops an earlier *automatic* link because the evidence no longer supports it.
   */
  private async persistEvidence(row: ParticipantRow, resolution: ContactResolution): Promise<void> {
    if (row.link_confidence === 'manual') return;
    const now = new Date();
    if (resolution.status === 'matched' && resolution.candidates.length === 1) {
      const candidate = resolution.candidates[0] as ResolvedCandidate;
      await sql`
        update voice_conversation_participants
        set entity_type = ${candidate.entityType}, entity_id = ${candidate.id},
            verification_state = 'verified', link_confidence = 'exact',
            link_reason = 'unique_address_match', source_provenance = 'contact_resolver', last_seen_at = ${now}
        where id = ${row.id}
      `.execute(this.database.db);
      return;
    }
    if (resolution.status === 'ambiguous') {
      await sql`
        update voice_conversation_participants
        set entity_type = null, entity_id = null, display_name = null,
            verification_state = 'disputed', link_confidence = 'heuristic',
            link_reason = ${`ambiguous_match:${String(resolution.candidates.length + resolution.hiddenMatches)}`},
            source_provenance = 'contact_resolver', last_seen_at = ${now}
        where id = ${row.id}
      `.execute(this.database.db);
      return;
    }
    if (row.entity_id !== null) return; // nothing new to say; keep an existing automatic link
    const reason =
      resolution.status === 'invalid'
        ? 'invalid_address'
        : resolution.hiddenMatches > 0
          ? 'unmatched_or_unreadable'
          : 'no_readable_match';
    await sql`
      update voice_conversation_participants
      set verification_state = 'unverified', link_confidence = 'none', link_reason = ${reason},
          source_provenance = 'contact_resolver', last_seen_at = ${now}
      where id = ${row.id}
    `.execute(this.database.db);
  }

  private async requireConversation(conversationId: string): Promise<{ id: string; channel: string }> {
    const row = (await sql<{ id: string; channel: string }>`
      select id, channel from voice_conversations where id = ${conversationId}
    `.execute(this.database.db)).rows[0];
    if (row === undefined) throw new ValidationError(`Conversation "${conversationId}" does not exist.`);
    return row;
  }

  private async customerParticipants(conversationId: string): Promise<ParticipantRow[]> {
    return (await sql<ParticipantRow>`
      select * from voice_conversation_participants
      where conversation_id = ${conversationId} and role = 'customer'
      order by created_at asc
    `.execute(this.database.db)).rows;
  }

  private async participant(id: string): Promise<ParticipantRow | undefined> {
    return (await sql<ParticipantRow>`select * from voice_conversation_participants where id = ${id}`.execute(this.database.db)).rows[0];
  }

  private async requireCustomerParticipant(conversationId: string, participantId: string | undefined): Promise<ParticipantRow> {
    const participants = await this.customerParticipants(conversationId);
    if (participants.length === 0) throw new ValidationError('The conversation has no customer participant to link.');
    if (participantId === undefined) return participants[0] as ParticipantRow;
    const found = participants.find((row) => row.id === participantId);
    if (found === undefined) throw new ValidationError('That participant does not belong to this conversation.');
    return found;
  }

  /** Kernel audit sink for a dedicated-table change (the lead-score threshold precedent). */
  private async audit(conversationId: string, action: string, data: Record<string, unknown>): Promise<void> {
    await sql`
      insert into audit_log (id, entity_type, record_id, username, user_id, action, "order", data)
      values (${`audit_${randomUUID()}`}, 'CommunicationConversation', ${conversationId},
              ${this.scope.principal?.userName ?? null}, ${this.scope.userId ?? null}, ${action}, 0,
              ${JSON.stringify(data)}::jsonb)
    `.execute(this.database.db);
  }
}

function toIdentityView(row: ParticipantRow, resolution: ContactResolution): OmnichannelParticipantIdentityView {
  return {
    participantId: row.id,
    address: row.address,
    entityType: row.entity_type,
    entityId: row.entity_id,
    displayName: row.display_name,
    verificationState: row.verification_state,
    linkConfidence: row.link_confidence,
    linkReason: row.link_reason,
    sourceProvenance: row.source_provenance,
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
    resolution: resolution.status,
    candidates: resolution.candidates.map((candidate) => ({
      entityType: candidate.entityType,
      id: candidate.id,
      name: candidate.name,
    })),
    hiddenMatches: resolution.hiddenMatches,
    truncated: resolution.truncated,
  };
}
