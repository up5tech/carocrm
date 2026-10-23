/**
 * Phase 12 shared shapes: global search, saved filters, CSV import/export, dashboards (PLAN §30–33).
 */
import { z } from 'zod';

export const TEXTISH_TYPES: ReadonlySet<string> = new Set(['varchar', 'text', 'email', 'phone', 'url', 'enum', 'multiEnum']);

export const NON_EXPORTABLE_TYPES: ReadonlySet<string> = new Set(['password']);

export const IMPORTABLE_TYPES: ReadonlySet<string> = new Set([
  'varchar',
  'text',
  'email',
  'phone',
  'url',
  'enum',
  'multiEnum',
  'int',
  'float',
  'decimal',
  'currency',
  'bool',
  'date',
  'datetime',
]);

export const ENTITY_NAME = /^[A-Z][A-Za-z0-9]{1,49}$/;
/** Attr keys with a trigram index from migration 009; searched first to keep the OR index-usable. */
export const SEARCH_INDEXED_ATTRS: readonly string[] = ['firstName', 'lastName', 'emailAddress', 'phoneNumber'];
export const MAX_GLOBAL_ENTITIES = 25;
export const MAX_SEARCH_TEXT = 200;
export const MAX_PER_ENTITY = 50;
export const MAX_FILTERS_LIMIT = 200;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2_000;
export const MAX_EXPORT_ROWS = 10_000;
/** One list page; the query engine clamps `maxSize` to 500, so export walks this many rows at a time. */
export const EXPORT_PAGE_SIZE = 500;
export const MAX_DASHBOARDS_LIMIT = 200;
export const MAX_DASHLET_ROWS = 200;
export const MAX_DASHLET_SCAN = 2_000;

export const SavedFilterInputSchema = z.object({
  name: z.string().trim().min(1).max(190),
  entityType: z.string().trim().min(1).max(64),
  criteria: z.unknown(),
  visibility: z.enum(['private', 'shared']).default('private'),
});

export const DashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(190),
  layout: z.array(z.unknown()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  isShared: z.boolean().default(false),
});

export const DashletInputSchema = z.object({
  name: z.string().trim().min(1).max(190),
  // `projectTasks` is the Phase 19 Project Task dashlet (PLAN_Phase_19_Projects.md §4.16): the same
  // three generic kinds cannot express "due in the next N days, owned or shared with me".
  // `esignature` is the Phase 19-ES.19 operational dashlet, whose aggregate is computed by the
  // ESignature module under the reader's own record scope.
  kind: z.enum(['list', 'chart', 'kpi', 'projectTasks', 'esignature']),
  position: z.number().int().min(0).max(10_000).default(0),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const DashletConfigSchema = z.object({
  entity: z.string().trim().min(1).max(64),
  filterId: z.string().trim().min(1).max(64).optional(),
  where: z.unknown().optional(),
  maxSize: z.coerce.number().int().min(1).max(MAX_DASHLET_ROWS).default(10),
  groupBy: z.string().trim().min(1).max(64).optional(),
  measure: z.string().trim().min(1).max(64).optional(),
  aggregation: z.enum(['count', 'sum', 'avg']).default('count'),
});

export interface SearchHit {
  entityType: string;
  record: Record<string, unknown>;
}

export interface ImportResult {
  entity: string;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  ids: string[];
}
