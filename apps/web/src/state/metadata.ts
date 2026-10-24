import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type { EntityDefinition, FieldDefinition, LayoutPanel, Metadata } from '../api/types.js';
import { isComputedField } from './logic.js';

export interface FieldEntry {
  name: string;
  field: FieldDefinition;
}

/** Bookkeeping columns never appear in generated views. */
const ALWAYS_HIDDEN = new Set(['id', 'createdAt', 'modifiedAt', 'createdById', 'modifiedById', 'deletedAt', 'version']);

export function useMetadata() {
  return useQuery<Metadata>({
    queryKey: ['metadata'],
    queryFn: () => api.metadata(),
    staleTime: 30_000,
  });
}

export function useEntity(entity: string | undefined) {
  return useQuery<EntityDefinition>({
    queryKey: ['metadata', entity],
    queryFn: () => {
      if (!entity) throw new Error('Missing entity');
      return api.entity(entity);
    },
    enabled: Boolean(entity),
    staleTime: 30_000,
  });
}

export function visibleEntries(definition: EntityDefinition | undefined, predicate: (field: FieldDefinition) => boolean): FieldEntry[] {
  if (!definition) return [];
  return Object.entries(definition.fields)
    .filter(([name, field]) => !ALWAYS_HIDDEN.has(name) && field.type !== 'disabled' && !predicate(field))
    .map(([name, field]) => ({ name, field }));
}

export function listEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  return definition
    ? Object.entries(definition.fields)
        .filter(([name, field]) => field.inList === true && !ALWAYS_HIDDEN.has(name) && field.type !== 'disabled')
        .map(([name, field]) => ({ name, field }))
    : [];
}

export function detailEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  return visibleEntries(definition, (field) => field.inDetail === false);
}

export function editEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  // Computed fields are filled in by the server, so an editor for them would only ever be rejected.
  return visibleEntries(definition, (field) => field.inEdit === false || isComputedField(field.type));
}


/**
 * The filter panel's candidates, in metadata order.
 *
 * Two rules 19-LS.7 added, because a projection like Lead Score has to be filterable without a per-entity
 * hack anywhere in the SPA:
 *
 * - an explicit `inFilter: false` **means it**. Inclusion used to be a type heuristic, so a provenance
 *   datetime a module deliberately kept out of the panel came back as `datetime` anyway;
 * - the twelve-field ceiling is a scanability guard, not a way to lose a field an administrator asked for,
 *   so explicitly-marked fields are kept and the *automatic* ones are what the cap trims.
 */
const MAX_AUTOMATIC_FILTERS = 12;

const FILTERABLE_TYPES = ['varchar', 'enum', 'bool', 'date', 'datetime', 'int', 'currency'];

export function filterEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  if (!definition) return [];
  const entries: FieldEntry[] = [];
  let automatic = 0;
  for (const [name, field] of Object.entries(definition.fields)) {
    if (ALWAYS_HIDDEN.has(name) || field.type === 'disabled' || field.inFilter === false) continue;
    if (field.inFilter === true) {
      entries.push({ name, field });
      continue;
    }
    if (!FILTERABLE_TYPES.includes(field.type) || automatic >= MAX_AUTOMATIC_FILTERS) continue;
    automatic += 1;
    entries.push({ name, field });
  }
  return entries;
}

/**
 * Plain values a bulk write may set (PLAN_Phase_20_Settings_UX.md §5.3). The entity's `massUpdate`
 * layout picks the set when it has one; without that layout the fields the edit form shows are the
 * candidates. Computed fields are excluded because the server recalculates them, and a link is left
 * out because a record id typed into a box is not a picker — the owner link has its own **Assign**.
 */
export function massUpdateEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  const arranged = layoutFieldEntries(definition, 'massUpdate');
  const source = arranged.length > 0 ? arranged : editEntries(definition);
  return source.filter((entry) => MASS_UPDATE_TYPES.has(entry.field.type));
}

const MASS_UPDATE_TYPES: ReadonlySet<string> = new Set([
  'varchar',
  'text',
  'enum',
  'bool',
  'date',
  'datetime',
  'int',
  'float',
  'currency',
]);

/**
 * Enum fields a board view can build its columns from. The list comes from metadata — only a
 * field that declares its own `values` can produce columns, so a free-text field is never
 * offered and a new enum field needs no frontend change.
 */
export function boardGroupFields(definition: EntityDefinition | undefined): FieldEntry[] {
  if (!definition) return [];
  return Object.entries(definition.fields)
    .filter(([name, field]) => !ALWAYS_HIDDEN.has(name) && field.type === 'enum' && enumValues(field).length > 0)
    .map(([name, field]) => ({ name, field }));
}

export function enumValues(field: FieldDefinition): string[] {
  return field.values ?? field.enum ?? [];
}

/**
 * Conventional pipeline field names, tried in order before falling back to the first enum
 * field. The CRM's own pipeline entities (Opportunity `stage`, Lead/Task/Email `status`) all
 * use one of them, so a board opens on the column a sales reader expects; every enum field
 * stays selectable on the page itself, so the guess is never a restriction.
 */
const BOARD_GROUP_PREFERENCE = ['stage', 'status', 'state'];

export function defaultBoardGroupField(definition: EntityDefinition | undefined): string | undefined {
  const entries = boardGroupFields(definition);
  // An entity can name its own board grouping in metadata (PLAN_Phase_20 §4.5); it wins when the
  // field is still a valid grouping, so a renamed field falls back rather than breaking the board.
  const configured = definition?.nav?.board?.defaultGroupBy;
  if (typeof configured === 'string' && entries.some((entry) => entry.name === configured)) return configured;
  const preferred = BOARD_GROUP_PREFERENCE.find((name) => entries.some((entry) => entry.name === name));
  return preferred ?? entries[0]?.name;
}

/** Views the generated record screens can lay out (PLAN §8). */
type LayoutView = 'list' | 'detail' | 'edit' | 'massUpdate' | 'panel' | 'popup';

/**
 * Panels of the first layout declared for a view, in position order (PLAN §8).
 * Entities without a layout return an empty list so callers can fall back to field order.
 */
export function layoutPanelsFor(definition: EntityDefinition | undefined, view: LayoutView): LayoutPanel[] {
  for (const group of Object.values(definition?.layouts ?? {})) {
    const layout = group.find((candidate) => candidate.type === view);
    const panels = layout?.panels;
    if (panels) return [...panels].sort((a, b) => a.position - b.position);
  }
  return [];
}

/**
 * Fields a column layout names, in order and with their definitions. Unknown or retired names are
 * skipped, so a stale layout can never break a table.
 */
export function layoutFieldEntries(definition: EntityDefinition | undefined, view: LayoutView): FieldEntry[] {
  if (!definition) return [];
  const seen = new Set<string>();
  const entries: FieldEntry[] = [];
  for (const name of layoutPanelsFor(definition, view).flatMap((panel) => panel.fields ?? [])) {
    const field = definition.fields[name];
    if (!field || field.type === 'disabled' || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, field });
  }
  return entries;
}

/**
 * Reorders entries to follow the field order declared by `panels` (PLAN §8).
 * Entries no panel mentions keep their original relative order, after the laid-out ones.
 * Without panels the input list is returned untouched, so callers need no special case.
 */
export function orderByLayout<T extends FieldEntry>(entries: T[], panels: LayoutPanel[]): T[] {
  if (panels.length === 0) return entries;
  // A Set preserves the union order (panel position, then declared field order) and drops repeats.
  const covered = layoutFieldNames(panels);
  const ordered: T[] = [];
  for (const name of covered) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry) ordered.push(entry);
  }
  for (const entry of entries) {
    if (!covered.has(entry.name)) ordered.push(entry);
  }
  return ordered;
}

/** Field names a panel lays out, used to split entries into panel sections. */
export function panelFieldNames(panel: LayoutPanel): Set<string> {
  return new Set(panel.fields ?? []);
}

/** Field names laid out by any panel, so callers can group the remainder separately. */
export function layoutFieldNames(panels: LayoutPanel[]): Set<string> {
  return new Set(panels.flatMap((panel) => panel.fields ?? []));
}

export function labelOf(definition: EntityDefinition | undefined, name: string): string {
  return fieldLabel(name, definition?.fields[name]);
}

/** Metadata rarely carries per-field labels; "billingAddressCity" must read as "Billing Address City". */
export function fieldLabel(name: string, field?: FieldDefinition, metadata?: Metadata): string {
  if (field?.label) return field.label;
  const target = field?.entityKey ? metadata?.[field.entityKey] : undefined;
  if (target?.label) return target.label;
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function recordLabel(record: Record<string, unknown> | undefined, definition?: EntityDefinition): string {
  if (!record) return '';
  const display = definition?.record?.displayField;
  if (display && typeof record[display] === 'string' && record[display]) return String(record[display]);
  if (typeof record['name'] === 'string' && record['name']) return String(record['name']);
  const first = Object.values(record).find((value) => typeof value === 'string' && value.length > 0);
  return typeof first === 'string' ? first : String(record['id'] ?? '');
}

export function navEntities(metadata: Metadata | undefined, principalType: string | undefined): EntityDefinition[] {
  if (!metadata) return [];
  return Object.values(metadata)
    .filter((entity) => entity.isEntity && entity.client?.web !== false)
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter(() => principalType !== undefined);
}
