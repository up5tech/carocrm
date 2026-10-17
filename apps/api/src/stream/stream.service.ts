import type { AclAction } from '@carocrm/acl/types/index.js';
import { AuthorizationDeniedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import { sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import type { AuthenticatedPrincipal, RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { StreamItemsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { PostgresRecordStore } from '../entity/entity-record.store.js';
import { ENTITY_STORE } from '../entity/entity-record.store.js';
import { currentTx } from '../entity/tx-context.js';
import {
  canViewStreamVisibility,
  isStreamVisibility,
  type StreamVisibility,
  toStreamVisibility,
} from './stream-visibility.js';

export const STREAM_ITEM_TYPES = ['Note', 'Post', 'Update'] as const;
export type StreamItemType = (typeof STREAM_ITEM_TYPES)[number];

export interface StreamUserDto {
  userId: string;
  userName: string;
  firstName: string | null;
  lastName: string | null;
}

export interface StreamItemDto {
  id: string;
  entityType: string;
  entityId: string;
  type: string;
  /** §5.4 visibility classification: `public` | `internal` | `system`. */
  visibility: StreamVisibility;
  data: Record<string, unknown>;
  post: string | null;
  createdById: string | null;
  createdBy: StreamUserDto | null;
  createdAt: string;
  mentions: StreamUserDto[];
  attachmentIds: string[];
}

export interface CreateStreamItemInput {
  type: StreamItemType;
  notes?: string | undefined;
  post?: string | undefined;
  data?: Record<string, unknown> | undefined;
  attachmentIds?: string[] | undefined;
  mentionIds?: string[] | undefined;
  /**
   * The requested visibility. A caller may name `public` or `internal`; `system` is generated only.
   * A portal principal may only create `public` content, and an internal caller defaults to
   * `internal` — public visibility must always be explicit (§5.4, §10.3).
   */
  visibility?: StreamVisibility | undefined;
  /** Persisted in `data` so a command can recognise and return its own prior write (§12.3). */
  idempotencyKey?: string | undefined;
}

export interface StreamListOptions {
  maxSize: number;
  offset: number;
  order: 'asc' | 'desc';
  types?: string[] | undefined;
}

type StreamRow = Selectable<StreamItemsTable>;
type UserRow = { id: string; user_name: string; first_name: string | null; last_name: string | null };
type ResolvedMention = { userId: string; user: StreamUserDto };

const STREAM_COLUMNS = [
  'id',
  'entity_type',
  'entity_id',
  'type',
  'visibility',
  'data',
  'post',
  'created_by_id',
  'created_at',
  'modified_at',
  'is_deleted',
] as const;

const USER_COLUMNS = ['id', 'user_name', 'first_name', 'last_name'] as const;

/** `@[John Doe]` (the EspoCRM composer form) or a bare `@userName`. */
const MENTION_PATTERN = /@\[([^\]]+)\]|@([a-zA-Z0-9._-]+)/g;

const FULL_NAME_SQL = sql<string>`coalesce(first_name, '') || ' ' || coalesce(last_name, '')`;

function asJsonObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toUserDto(row: UserRow): StreamUserDto {
  return {
    userId: row.id,
    userName: row.user_name,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
  };
}

/**
 * Stream / timeline (PLAN §26, §5.4).
 *
 * Two gates guard every item. The parent record's read ACL scopes *which record* a caller may see;
 * the item's explicit `visibility` scopes *which entries* they may see within it. An internal
 * principal sees every visibility; a portal principal sees only `public` entries — never internal
 * notes or generated system updates (§5.4, §10.3).
 */
@Injectable()
export class StreamService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(ENTITY_STORE) private readonly store: PostgresRecordStore,
  ) {}

  private get db() {
    // A domain command runs several writes with one invariant inside `runInTransaction`; joining the
    // ambient transaction keeps a stream item and its record stamps atomic. Outside one, this is the
    // pool.
    return currentTx() ?? this.database.db;
  }

  /** Loads the parent record and enforces the requested ACL action on it. */
  async assertParentAccess(entityType: string, entityId: string, action: AclAction): Promise<void> {
    if (!(await this.canAccessParent(entityType, entityId, action))) {
      throw new AuthorizationDeniedError(`No ${action} access to ${entityType} ${entityId}.`, { entityType, entityId });
    }
  }

  async create(entityType: string, entityId: string, input: CreateStreamItemInput): Promise<StreamItemDto> {
    if (!STREAM_ITEM_TYPES.includes(input.type)) {
      throw new ValidationError(`Unsupported stream item type "${input.type}".`, { type: input.type });
    }
    if (input.type === 'Update') {
      throw new ValidationError('Update stream items are generated from record changes only.');
    }
    const principal = this.scope.requirePrincipal();
    // EspoCRM: viewing a stream needs record read access, posting needs the `stream` action.
    await this.assertParentAccess(entityType, entityId, 'read');
    await this.assertParentAccess(entityType, entityId, 'stream');

    const visibility = resolveCreateVisibility(input.visibility, principal);

    const text = (input.post ?? input.notes ?? '').trim();
    if (text === '' && (input.attachmentIds?.length ?? 0) === 0) {
      throw new ValidationError('A stream item needs text content or an attachment.');
    }

    const data = { ...asJsonObject(input.data) };
    if (input.type === 'Note' && input.notes !== undefined) data['notes'] = input.notes;
    if (input.attachmentIds?.length) data['fileIds'] = input.attachmentIds;
    if (input.idempotencyKey !== undefined && input.idempotencyKey.trim() !== '') {
      data['idempotencyKey'] = input.idempotencyKey.trim();
    }

    const now = new Date();
    const id = generateId();
    // Mentions are read from whichever field carries the text: a `Post` uses `post`, a `Note` uses
    // `notes`. Both support `@[Name]` / `@userName` and an explicit id list.
    const mentions = await this.resolveMentions(input.post ?? input.notes ?? '', input.mentionIds);

    await this.db
      .insertInto('stream_items')
      .values({
        id,
        entity_type: entityType,
        entity_id: entityId,
        type: input.type,
        visibility,
        data,
        post: input.post ?? null,
        created_by_id: principal.userId,
        created_at: now,
        modified_at: now,
        is_deleted: false,
      })
      .execute();

    if (mentions.length > 0) {
      await this.db
        .insertInto('stream_mentions')
        .values(mentions.map((mention) => ({
          id: generateId(),
          stream_item_id: id,
          user_id: mention.userId,
          char_offset: null,
        })))
        .execute();
      await this.notifyMentioned(mentions, { entityType, entityId, itemId: id, actorId: principal.userId });
    }

    if (input.attachmentIds?.length) {
      await this.linkAttachments(id, entityType, entityId, input.attachmentIds, visibility);
    }

    const created = await this.fetchItem(id);
    if (!created) throw new RecordNotFoundError('StreamItem', id);
    const [dto] = await this.hydrate([created]);
    if (!dto) throw new RecordNotFoundError('StreamItem', id);
    return dto;
  }

  /**
   * Whether the current actor may post to this record — the SPA hint for a composer, never the
   * check (each command re-runs it). Requires both record read and the `stream` action.
   */
  async canStream(entityType: string, entityId: string): Promise<boolean> {
    if (!(await this.canAccessParent(entityType, entityId, 'read'))) return false;
    return this.canAccessParent(entityType, entityId, 'stream');
  }

  /** Soft delete; only the author or an admin may remove an item. */
  async remove(itemId: string): Promise<void> {
    const principal = this.scope.requirePrincipal();
    const row = await this.fetchItem(itemId, { includeDeleted: true });
    if (!row) throw new RecordNotFoundError('StreamItem', itemId);
    if (!this.scope.isAdmin && row.created_by_id !== principal.userId) {
      throw new AuthorizationDeniedError('Only the author can remove a stream item.');
    }
    await this.assertParentAccess(row.entity_type, row.entity_id, 'read');
    await this.db
      .updateTable('stream_items')
      .set({ is_deleted: true, modified_at: new Date() })
      .where('id', '=', itemId)
      .execute();
  }

  async follow(entityType: string, entityId: string): Promise<void> {
    const principal = this.scope.requirePrincipal();
    await this.assertParentAccess(entityType, entityId, 'read');
    await this.db
      .insertInto('stream_followers')
      .values({
        id: generateId(),
        entity_type: entityType,
        entity_id: entityId,
        user_id: principal.userId,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'user_id']).doNothing())
      .execute();
  }

  async unfollow(entityType: string, entityId: string): Promise<void> {
    const principal = this.scope.requirePrincipal();
    await this.db
      .deleteFrom('stream_followers')
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .where('user_id', '=', principal.userId)
      .execute();
  }

  async isFollowed(entityType: string, entityId: string): Promise<boolean> {
    const principal = this.scope.requirePrincipal();
    const row = await this.db
      .selectFrom('stream_followers')
      .select('id')
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Record timeline. */
  async listForRecord(
    entityType: string,
    entityId: string,
    options: StreamListOptions,
  ): Promise<{ list: StreamItemDto[]; total: number; offset: number; count: number }> {
    await this.assertParentAccess(entityType, entityId, 'read');
    const principal = this.scope.requirePrincipal();
    let query = this.db
      .selectFrom('stream_items')
      .select(STREAM_COLUMNS)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .where('is_deleted', '=', false);
    if (options.types?.length) query = query.where('type', 'in', options.types);
    // A portal principal may only ever see customer-visible entries (§5.4, §10.3).
    if (principal.userType === 'portal') query = query.where('visibility', '=', 'public');
    const rows = await query
      .orderBy('created_at', options.order)
      .limit(options.maxSize)
      .offset(options.offset)
      .execute();
    let countQuery = this.db
      .selectFrom('stream_items')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .where('is_deleted', '=', false);
    if (principal.userType === 'portal') countQuery = countQuery.where('visibility', '=', 'public');
    const totalRow = await countQuery.executeTakeFirst();
    const list = await this.hydrate(rows);
    return { list, total: Number(totalRow?.total ?? 0), offset: options.offset, count: list.length };
  }

  /**
   * Global activity stream: `followed` = items on records the caller follows,
   * `own` = items the caller created, `all` = both. Items whose parent record the
   * caller cannot read are dropped, therefore no `total` is reported.
   */
  async listGlobal(
    options: StreamListOptions & { view: 'all' | 'followed' | 'own'; entityType?: string | undefined },
  ): Promise<{ list: StreamItemDto[]; offset: number; count: number }> {
    const principal = this.scope.requirePrincipal();
    const followed = await this.db
      .selectFrom('stream_followers')
      .select(['entity_type', 'entity_id'])
      .where('user_id', '=', principal.userId)
      .execute();
    const followedKey = new Set(followed.map((row) => `${row.entity_type}:${row.entity_id}`));

    let query = this.db
      .selectFrom('stream_items')
      .select(STREAM_COLUMNS)
      .where('is_deleted', '=', false);
    if (options.entityType) query = query.where('entity_type', '=', options.entityType);
    if (options.types?.length) query = query.where('type', 'in', options.types);
    const rows = await query
      .orderBy('created_at', options.order)
      // over-fetch: parent read-ACL filtering happens in memory afterwards
      .limit(options.maxSize * 4 + 40)
      .execute();

    const visible: StreamRow[] = [];
    const accessCache = new Map<string, boolean>();
    for (const row of rows) {
      // Same visibility rule as the record stream: a portal principal never sees internal/system.
      if (!canViewStreamVisibility(toStreamVisibility(row.visibility), principal)) continue;
      const key = `${row.entity_type}:${row.entity_id}`;
      const inScope =
        options.view === 'own'
          ? row.created_by_id === principal.userId
          : options.view === 'followed'
            ? followedKey.has(key)
            : followedKey.has(key) || row.created_by_id === principal.userId;
      if (!inScope) continue;
      let readable = accessCache.get(key);
      if (readable === undefined) {
        readable = await this.canAccessParent(row.entity_type, row.entity_id, 'read');
        accessCache.set(key, readable);
      }
      if (readable) visible.push(row);
      if (visible.length >= options.maxSize) break;
    }

    const list = await this.hydrate(visible);
    return { list, offset: options.offset, count: list.length };
  }

  async listNotifications(options: {
    maxSize: number;
    offset: number;
    unreadOnly: boolean;
  }): Promise<{ list: Array<{ id: string; type: string; data: Record<string, unknown>; isRead: boolean; createdAt: string }>; total: number }> {
    const principal = this.scope.requirePrincipal();
    let query = this.db
      .selectFrom('notifications')
      .select(['id', 'type', 'data', 'is_read', 'created_at'])
      .where('user_id', '=', principal.userId);
    if (options.unreadOnly) query = query.where('is_read', '=', false);
    const rows = await query.orderBy('created_at', 'desc').limit(options.maxSize).offset(options.offset).execute();
    const totalRow = await this.db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        data: asJsonObject(row.data),
        isRead: row.is_read,
        createdAt: row.created_at.toISOString(),
      })),
      total: Number(totalRow?.total ?? 0),
    };
  }

  async markNotificationRead(id: string): Promise<void> {
    const principal = this.scope.requirePrincipal();
    const updated = await this.db
      .updateTable('notifications')
      .set({ is_read: true })
      .where('id', '=', id)
      .where('user_id', '=', principal.userId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw new RecordNotFoundError('Notification', id);
    }
  }

  async markAllNotificationsRead(): Promise<number> {
    const principal = this.scope.requirePrincipal();
    const updated = await this.db
      .updateTable('notifications')
      .set({ is_read: true })
      .where('user_id', '=', principal.userId)
      .where('is_read', '=', false)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows);
  }

  /** Writes an `Update` stream item; used by the record-update hook. */
  async insertUpdateItem(args: {
    entityType: string;
    entityId: string;
    userId: string | null;
    attributes: Array<{ name: string; value: unknown }>;
  }): Promise<void> {
    if (args.attributes.length === 0) return;
    const now = new Date();
    await this.db
      .insertInto('stream_items')
      .values({
        id: generateId(),
        entity_type: args.entityType,
        entity_id: args.entityId,
        type: 'Update',
        visibility: 'system',
        data: { type: 'Updated', attributes: args.attributes },
        post: null,
        created_by_id: args.userId,
        created_at: now,
        modified_at: now,
        is_deleted: false,
      })
      .execute();
  }

  private async canAccessParent(entityType: string, entityId: string, action: AclAction): Promise<boolean> {
    const record = await this.store.findById(entityType, entityId);
    if (!record) return false;
    const decision = await this.acl.canAccessRecord(entityType, action, {
      id: entityId,
      data: record.data,
      assignedUserId: record.assignedUserId,
      createdById: record.createdById,
      ...(Array.isArray(record.data['teams']) ? { teams: record.data['teams'] as string[] } : {}),
    });
    return decision.allowed;
  }

  private async fetchItem(id: string, options: { includeDeleted?: boolean } = {}): Promise<StreamRow | undefined> {
    let query = this.db.selectFrom('stream_items').select(STREAM_COLUMNS).where('id', '=', id);
    if (!options.includeDeleted) query = query.where('is_deleted', '=', false);
    return query.executeTakeFirst();
  }

  private async hydrate(rows: ReadonlyArray<StreamRow>): Promise<StreamItemDto[]> {
    const ids = rows.map((row) => row.id);
    const [mentions, attachments, authors] = await Promise.all([
      this.mentionsFor(ids),
      this.attachmentsFor(ids),
      this.usersByIds(rows.map((row) => row.created_by_id)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      type: row.type,
      visibility: toStreamVisibility(row.visibility),
      data: asJsonObject(row.data),
      post: row.post ?? null,
      createdById: row.created_by_id ?? null,
      createdBy: row.created_by_id ? (authors.get(row.created_by_id) ?? null) : null,
      createdAt: row.created_at.toISOString(),
      mentions: mentions.get(row.id) ?? [],
      attachmentIds: attachments.get(row.id) ?? [],
    }));
  }

  private async usersByIds(userIds: Array<string | null>): Promise<Map<string, StreamUserDto>> {
    const ids = [...new Set(userIds.filter((value): value is string => typeof value === 'string'))];
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom('users').select(USER_COLUMNS).where('id', 'in', ids).execute();
    return new Map(rows.map((row) => [row.id, toUserDto(row)]));
  }

  private async mentionsFor(itemIds: ReadonlyArray<string>): Promise<Map<string, StreamUserDto[]>> {
    const result = new Map<string, StreamUserDto[]>();
    if (itemIds.length === 0) return result;
    const rows = await this.db
      .selectFrom('stream_mentions')
      .innerJoin('users', 'users.id', 'stream_mentions.user_id')
      .select([
        'stream_mentions.stream_item_id as item_id',
        'users.id as id',
        'users.user_name as user_name',
        'users.first_name as first_name',
        'users.last_name as last_name',
      ])
      .where('stream_mentions.stream_item_id', 'in', [...itemIds])
      .execute();
    for (const row of rows) {
      const list = result.get(row.item_id) ?? [];
      list.push(toUserDto(row));
      result.set(row.item_id, list);
    }
    return result;
  }

  private async attachmentsFor(itemIds: ReadonlyArray<string>): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (itemIds.length === 0) return result;
    const rows = await this.db
      .selectFrom('stream_attachments')
      .select(['stream_item_id', 'attachment_id'])
      .where('stream_item_id', 'in', [...itemIds])
      .execute();
    for (const row of rows) {
      const list = result.get(row.stream_item_id) ?? [];
      list.push(row.attachment_id);
      result.set(row.stream_item_id, list);
    }
    return result;
  }

  /** Attachments must already belong to the record being streamed, and inherit the message visibility. */
  private async linkAttachments(
    itemId: string,
    entityType: string,
    entityId: string,
    ids: string[],
    visibility: StreamVisibility,
  ): Promise<void> {
    const unique = [...new Set(ids)];
    const rows = await this.db
      .selectFrom('attachments')
      .select('id')
      .where('id', 'in', unique)
      .where('parent_type', '=', entityType)
      .where('parent_id', '=', entityId)
      .execute();
    if (rows.length !== unique.length) {
      throw new ValidationError('Every stream attachment must already be attached to the same record.', {
        expected: unique,
        found: rows.map((row) => row.id),
      });
    }
    await this.db
      .insertInto('stream_attachments')
      .values(unique.map((attachmentId) => ({ id: generateId(), stream_item_id: itemId, attachment_id: attachmentId })))
      .execute();
    // §5.4 "Attachments inherit the visibility of their message": an attachment on an internal note
    // becomes internal, so the portal download gate refuses it even though the parent case is readable.
    await this.db.updateTable('attachments').set({ visibility }).where('id', 'in', unique).execute();
  }

  private async resolveMentions(post: string, explicitIds?: string[]): Promise<ResolvedMention[]> {
    const found: ResolvedMention[] = [];
    const seen = new Set<string>();
    const tokens = new Set<string>();
    for (const match of post.matchAll(MENTION_PATTERN)) {
      const token = (match[1] ?? match[2] ?? '').trim();
      if (token) tokens.add(token);
    }
    for (const token of tokens) {
      const user = await this.findUserByMention(token);
      if (user && !seen.has(user.userId)) {
        seen.add(user.userId);
        found.push({ userId: user.userId, user });
      }
    }
    const missing = [...new Set(explicitIds ?? [])].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      const rows = await this.db.selectFrom('users').select(USER_COLUMNS).where('id', 'in', missing).execute();
      for (const row of rows) found.push({ userId: row.id, user: toUserDto(row) });
    }
    return found;
  }

  private async findUserByMention(token: string): Promise<StreamUserDto | undefined> {
    const rows = await this.db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('is_deleted', '=', false)
      .where((eb) => eb.or([eb('user_name', 'ilike', token), eb(FULL_NAME_SQL, 'ilike', token)]))
      .limit(1)
      .execute();
    const match = rows[0];
    return match ? toUserDto(match) : undefined;
  }

  private async notifyMentioned(
    mentions: ReadonlyArray<ResolvedMention>,
    context: { entityType: string; entityId: string; itemId: string; actorId: string },
  ): Promise<void> {
    const targets = mentions.filter((mention) => mention.userId !== context.actorId);
    if (targets.length === 0) return;
    // Only internal staff are notified: a portal user must never receive a notification that points
    // at an internal-only note they cannot open (§5.4).
    const internalIds = new Set(
      (
        await this.db
          .selectFrom('users')
          .select('id')
          .where('id', 'in', targets.map((mention) => mention.userId))
          .where('type', 'in', ['regular', 'admin'])
          .execute()
      ).map((row) => row.id),
    );
    const internal = targets.filter((mention) => internalIds.has(mention.userId));
    if (internal.length === 0) return;
    await this.db
      .insertInto('notifications')
      .values(internal.map((mention) => ({
        id: generateId(),
        type: 'Mention',
        user_id: mention.userId,
        data: {
          entityId: context.entityId,
          entityType: context.entityType,
          streamItemId: context.itemId,
          createdById: context.actorId,
        },
        is_read: false,
        created_at: new Date(),
      })))
      .execute();
  }
}

/**
 * The visibility a *new* entry gets (§5.4). A portal principal may only create customer-visible
 * content; an internal caller must ask for `public` explicitly and otherwise gets `internal`. A
 * client can never forge a `system` entry — those are generated from record changes.
 */
function resolveCreateVisibility(
  requested: StreamVisibility | undefined,
  principal: AuthenticatedPrincipal,
): StreamVisibility {
  if (principal.userType === 'portal') {
    if (requested !== undefined && requested !== 'public') {
      throw new AuthorizationDeniedError('Portal users may only create customer-visible messages.', {
        requested,
      });
    }
    return 'public';
  }
  if (requested === undefined) return 'internal';
  if (!isStreamVisibility(requested) || requested === 'system') {
    throw new ValidationError('System stream items are generated by the platform, not created directly.');
  }
  return requested;
}
