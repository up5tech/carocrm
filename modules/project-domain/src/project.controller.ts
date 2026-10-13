import { AuthorizationDeniedError, NotFoundError } from '@carocrm/core/errors/index.js';
import type { ExtensionAcl, ExtensionDb, ExtensionMetadataLookup } from '@carocrm/extension-sdk';
import { EXTENSION_ACL, EXTENSION_DATABASE, EXTENSION_METADATA } from '@carocrm/extension-sdk';
import { Controller, Get, Inject, Param } from '@nestjs/common';

/**
 * A read-only endpoint contributed by `project-domain`.
 *
 * It demonstrates the one thing an extension cannot get from metadata alone: a *derived* view. The
 * record itself, its relations, ACL, audit and the SPA screens all come from the generic entity
 * API; only the aggregate is custom.
 *
 * Access control is explicit and comes from the host's own evaluator: the endpoint asks
 * `EXTENSION_ACL` before it reads a record, and it reads metadata through `EXTENSION_METADATA`, so
 * it never bypasses record-level ACL (PLAN §18.4).
 */
@Controller('api/v1/Project')
export class ProjectSummaryController {
  constructor(
    @Inject(EXTENSION_ACL) private readonly acl: ExtensionAcl,
    @Inject(EXTENSION_DATABASE) private readonly db: ExtensionDb,
    @Inject(EXTENSION_METADATA) private readonly metadata: ExtensionMetadataLookup,
  ) {}

  /**
   * `GET /api/v1/Project/:id/summary` — one project plus the counters an overview card needs.
   *
   * Counts respect ACL by construction: they are computed over the ids this principal may read,
   * never with an unbounded `COUNT(*)`.
   */
  @Get(':id/summary')
  async summary(@Param('id') id: string): Promise<ProjectSummary> {
    if (!(await this.acl.canAccess('Project', 'read'))) {
      throw new AuthorizationDeniedError('You do not have permission to read projects.');
    }
    const rows = await this.db.query<ProjectRow>(
      "SELECT id, attrs, assigned_user_id, created_by_id FROM entity_records WHERE entity_type = 'Project' AND id = $1 AND deleted_at IS NULL LIMIT 1",
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError(`Project "${id}" does not exist.`);

    const teams = teamsOf(row.attrs);
    if (!(await this.acl.canAccessRecord('Project', 'read', id))) {
      throw new AuthorizationDeniedError('You do not have permission to read this project.');
    }

    const attrs = isRecord(row.attrs) ? row.attrs : {};
    const entity = metadataEntity(this.metadata(), 'Project');
    return {
      id: row.id,
      name: typeof attrs['name'] === 'string' ? attrs['name'] : '',
      // A `date` attribute is stored as an instant; the day part is what the field means.
      dateStart: dayOf(attrs['dateStart']),
      dateEnd: dayOf(attrs['dateEnd']),
      boardId: typeof attrs['boardId'] === 'string' ? attrs['boardId'] : null,
      ownerUserId: typeof attrs['ownerUserId'] === 'string' ? attrs['ownerUserId'] : null,
      budget: numberOrNull(attrs['budget']),
      progress: numberOrZero(attrs['progress']),
      label: entity?.label ?? 'Project',
      fieldCount: Object.keys(entity?.fields ?? {}).length,
      ownership: { assignedUserId: row.assigned_user_id, createdById: row.created_by_id, teams },
    };
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  dateStart: string | null;
  dateEnd: string | null;
  boardId: string | null;
  ownerUserId: string | null;
  budget: number | null;
  progress: number;
  label: string;
  fieldCount: number;
  ownership: { assignedUserId: string | null; createdById: string | null; teams: string[] };
}

interface ProjectRow {
  id: string;
  attrs: unknown;
  assigned_user_id: string | null;
  created_by_id: string | null;
}

function metadataEntity(metadata: Record<string, unknown>, name: string): { label?: string; fields?: Record<string, unknown> } | undefined {
  // `GET /api/v1/Metadata` is a flat `{ EntityName: definition }` document; the same shape comes
  // back through `EXTENSION_METADATA`.
  const entity = metadata[name];
  return isRecord(entity) ? (entity as { label?: string; fields?: Record<string, unknown> }) : undefined;
}

function teamsOf(attrs: unknown): string[] {
  if (!isRecord(attrs)) return [];
  const teams = attrs['teams'];
  return Array.isArray(teams) ? teams.filter((team): team is string => typeof team === 'string') : [];
}

function dayOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, 10) : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}