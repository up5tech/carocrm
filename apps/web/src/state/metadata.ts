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


export function filterEntries(definition: EntityDefinition | undefined): FieldEntry[] {
  return definition
    ? Object.entries(definition.fields)
        .filter(
          ([name, field]) =>
            !ALWAYS_HIDDEN.has(name) &&
            field.type !== 'disabled' &&
            (field.inFilter === true || ['varchar', 'enum', 'bool', 'date', 'datetime', 'int', 'currency'].includes(field.type)),
        )
        .slice(0, 12)
        .map(([name, field]) => ({ name, field }))
    : [];
}

/** Views the generated record screens can lay out (PLAN §8). */
type LayoutView = 'list' | 'detail' | 'edit';

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
