import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { ConnectionLifecycleService } from './connection-lifecycle.service.js';

/**
 * Phase 19-INT.7 — external id links and record resolution
 * (`PLAN_Phase_19_Advanced_Integrations.md` §8.3; `19-INT.7`).
 *
 * A link is the platform's record that "this provider object is this CRM record". It is the
 * single mechanism that makes a sync idempotent and a duplicate detectable.
 *
 * Three uniqueness rules, enforced by the database rather than by the application:
 *
 *  1. One link per `(connection, object type, external id)` — the same provider object can never
 *     point at two CRM records.
 *  2. One link per `(connection, object type, CRM record)` — a CRM record is never driven by two
 *     provider objects of the same type.
 *  3. A link survives an unlink. The row stays, marked `unlinked`, so the history of what was
 *     connected to what is not lost — and a re-link does not create a second row.
 *
 * **Tenant isolation** is inherited from the connection: a link is only reachable through a
 * connection the caller may act on, and the service asserts that before every operation.
 */

export const LINK_STATUSES = ['linked', 'unlinked', 'conflict'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export interface ExternalLinkView {
  readonly id: string;
  readonly connectionId: string;
  readonly providerKey: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly externalParentId: string | null;
  readonly crmEntityType: string | null;
  readonly crmEntityId: string | null;
  readonly linkStatus: LinkStatus;
  readonly providerVersion: string | null;
  readonly providerUpdatedAt: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly syncedAt: string | null;
  readonly detail: string | null;
}

export interface LinkInput {
  readonly objectType: string;
  readonly externalId: string;
  readonly crmEntityType: string;
  readonly crmEntityId: string;
  readonly providerVersion?: string | null | undefined;
  readonly providerUpdatedAt?: string | null | undefined;
  readonly externalParentId?: string | null | undefined;
  readonly detail?: string | null | undefined;
}

/**
 * One unique-field comparison: a provider field and the CRM field it maps to.
 *
 * Duplicate detection compares the two sides of such a pair. A pair is only meaningful when the
 * provider field is declared unique by the connector's capability declaration.
 */
export interface UniqueFieldPair {
  /** The dotted path into the provider object. */
  readonly providerPath: string;
  /** The CRM field the provider value would be written to. */
  readonly crmField: string;
}

interface LinkRow {
  id: string;
  connection_id: string;
  provider_key: string;
  object_type: string;
  external_id: string;
  external_parent_id: string | null;
  crm_entity_type: string | null;
  crm_entity_id: string | null;
  link_status: string;
  provider_version: string | null;
  provider_updated_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  synced_at: Date | null;
  detail: string | null;
}

@Injectable()
export class ExternalLinkService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ConnectionLifecycleService) private readonly connections: ConnectionLifecycleService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /**
   * Link a provider object to a CRM record.
   *
   * The link is **upserted**: seeing the same provider object again updates the link rather than
   * creating a second one. That is what makes a repeated page harmless.
   */
  async link(connectionId: string, input: LinkInput): Promise<ExternalLinkView> {
    const connection = await this.connections.get(connectionId);
    if (input.objectType.trim() === '' || input.externalId.trim() === '') {
      throw new ValidationError('An external link needs an object type and an external id.');
    }
    if (input.crmEntityType.trim() === '' || input.crmEntityId.trim() === '') {
      throw new ValidationError('An external link needs a CRM entity type and a CRM record id.');
    }
    const now = new Date();
    const rows = await sql<LinkRow>`
      insert into integration_external_links
        (id, connection_id, provider_key, object_type, external_id, external_parent_id,
         crm_entity_type, crm_entity_id, link_status, provider_version, provider_updated_at,
         first_seen_at, last_seen_at, synced_at, detail)
      values
        (${randomUUID()}, ${connectionId}, ${connection.providerKey}, ${input.objectType},
         ${input.externalId}, ${input.externalParentId ?? null}, ${input.crmEntityType},
         ${input.crmEntityId}, 'linked', ${input.providerVersion ?? null},
         ${input.providerUpdatedAt ?? null}, ${now}, ${now}, ${now}, ${input.detail ?? null})
      on conflict (connection_id, object_type, external_id) do update set
        crm_entity_type = excluded.crm_entity_type,
        crm_entity_id = excluded.crm_entity_id,
        external_parent_id = excluded.external_parent_id,
        link_status = 'linked',
        provider_version = excluded.provider_version,
        provider_updated_at = excluded.provider_updated_at,
        last_seen_at = now(),
        synced_at = now(),
        detail = excluded.detail
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new ValidationError('The external link could not be stored.');
    return toView(row);
  }

  /** The link for a provider object, or `null`. */
  async resolve(connectionId: string, objectType: string, externalId: string): Promise<ExternalLinkView | null> {
    await this.connections.get(connectionId);
    const rows = await sql<LinkRow>`
      select * from integration_external_links
      where connection_id = ${connectionId} and object_type = ${objectType} and external_id = ${externalId}
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    return row ? toView(row) : null;
  }

  /** The link for a CRM record, or `null`. */
  async resolveByCrm(
    connectionId: string,
    objectType: string,
    crmEntityType: string,
    crmEntityId: string,
  ): Promise<ExternalLinkView | null> {
    await this.connections.get(connectionId);
    const rows = await sql<LinkRow>`
      select * from integration_external_links
      where connection_id = ${connectionId} and object_type = ${objectType}
        and crm_entity_type = ${crmEntityType} and crm_entity_id = ${crmEntityId}
        and link_status = 'linked'
      limit 1
    `.execute(this.database.db);
    const row = rows.rows[0];
    return row ? toView(row) : null;
  }

  /**
   * Unlink a provider object.
   *
   * The CRM record is **not** deleted — a provider-side delete never hard-deletes a CRM record
   * (feature contract §5.4). The link row stays, marked `unlinked`, so the history is preserved.
   */
  async unlink(connectionId: string, objectType: string, externalId: string): Promise<ExternalLinkView> {
    await this.connections.get(connectionId);
    const rows = await sql<LinkRow>`
      update integration_external_links
      set link_status = 'unlinked', last_seen_at = now()
      where connection_id = ${connectionId} and object_type = ${objectType} and external_id = ${externalId}
      returning *
    `.execute(this.database.db);
    const row = rows.rows[0];
    if (!row) throw new NotFoundError('The external link does not exist.');
    return toView(row);
  }

  /** Every link of a connection. */
  async list(connectionId: string): Promise<readonly ExternalLinkView[]> {
    await this.connections.get(connectionId);
    const rows = await sql<LinkRow>`
      select * from integration_external_links
      where connection_id = ${connectionId}
      order by object_type asc, external_id asc
    `.execute(this.database.db);
    return rows.rows.map((row) => toView(row));
  }

  /**
   * Find the provider objects that may be the same CRM record.
   *
   * Duplicate detection compares the **unique** provider fields of a mapping (an email address, a
   * customer number) against the CRM record each link points at, and only returns *candidates*.
   * The caller decides whether a candidate is the same record — the platform never merges on a
   * guess, because a wrong merge loses data on both sides.
   *
   * A candidate must match on **every** supplied pair. A single match is a coincidence, not a
   * duplicate.
   */
  async findDuplicateCandidates(
    connectionId: string,
    objectType: string,
    providerFields: Readonly<Record<string, unknown>>,
    uniqueFieldPairs: readonly UniqueFieldPair[],
  ): Promise<readonly ExternalLinkView[]> {
    await this.connections.get(connectionId);
    const pairs = uniqueFieldPairs.filter((pair) => pair.providerPath.trim() !== '' && pair.crmField.trim() !== '');
    if (pairs.length === 0) return [];

    // The provider's values are compared as strings: a provider may send a number where the CRM
    // stores a string, and "the same value" must not depend on the JSON type.
    const providerValues = pairs.map((pair) => normalizeValue(readPath(providerFields, pair.providerPath)));
    if (providerValues.some((value) => value === null)) return [];

    const links = await this.list(connectionId);
    const candidates: ExternalLinkView[] = [];
    for (const link of links) {
      if (link.objectType !== objectType) continue;
      if (link.linkStatus !== 'linked') continue;
      if (link.crmEntityType === null || link.crmEntityId === null) continue;
      const record = await this.readCrmRecord(link.crmEntityType, link.crmEntityId);
      if (record === null) continue;
      const matches = pairs.every((pair, index) => {
        const crmValue = normalizeValue(record[pair.crmField]);
        return crmValue !== null && crmValue === providerValues[index];
      });
      if (matches) candidates.push(link);
    }
    return candidates;
  }

  /**
   * Read a CRM record's current field values.
   *
   * A record that cannot be read (it was deleted, or the caller may not see it) is simply not a
   * candidate — a missing record must not fail the whole sync.
   */
  private async readCrmRecord(
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.entities.get(entityType, entityId);
    } catch {
      return null;
    }
  }

  /** Mark a link as conflicting, so the resolver does not treat it as a usable link. */
  async markConflict(connectionId: string, objectType: string, externalId: string): Promise<void> {
    await sql`
      update integration_external_links set link_status = 'conflict', last_seen_at = now()
      where connection_id = ${connectionId} and object_type = ${objectType} and external_id = ${externalId}
    `.execute(this.database.db);
  }
}

function toView(row: LinkRow): ExternalLinkView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    providerKey: row.provider_key,
    objectType: row.object_type,
    externalId: row.external_id,
    externalParentId: row.external_parent_id,
    crmEntityType: row.crm_entity_type,
    crmEntityId: row.crm_entity_id,
    linkStatus: row.link_status as LinkStatus,
    providerVersion: row.provider_version,
    providerUpdatedAt: row.provider_updated_at ? row.provider_updated_at.toISOString() : null,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    syncedAt: row.synced_at ? row.synced_at.toISOString() : null,
    detail: row.detail,
  };
}

/**
 * A comparable form of a value.
 *
 * Two values are the same when they render the same: a provider may send `"42"` where the CRM
 * stores `42`, and a duplicate check must not depend on the JSON type.
 */
function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.toLowerCase();
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase();
  return null;
}

/** Read a dotted path out of an object. A missing segment yields `undefined`. */
function readPath(source: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
