import { z } from 'zod';

/**
 * Record-page relation tabs (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * A record page renders one card per relationship, stacked in metadata order. That is unreadable
 * for an Account or an Opportunity with eight relations, and nothing on the page can be reordered
 * by the person who actually works the record. This module is the arrangement the user builds:
 * per user, per entity, either today's stacked panels or tabs they create, rename, reorder and
 * fill themselves.
 *
 * It is deliberately a **preference**, not entity metadata and not a settings document: two people
 * opening the same Account legitimately want different arrangements. The schema lives here — not in
 * the API — so the server validates a write and the SPA normalizes a read with the same code.
 *
 * Two invariants shape everything below:
 *
 * - **No relation can be lost.** A relation the user placed in no tab renders in an implicit,
 *   non-deletable *Other* tab that is computed on read and never stored. Deleting a tab returns
 *   its relations to that pool; it never deletes them.
 * - **A relation belongs to one tab.** Moving it is a move, never a copy, so the same link list can
 *   never appear twice on a page.
 */

/** How the relation area of a record page renders. `stacked` is today's behaviour. */
export const RelationTabModeSchema = z.enum(['stacked', 'tabs']);
export type RelationTabMode = z.infer<typeof RelationTabModeSchema>;

/** Limits of the arrangement. They are generous enough for any real entity and small enough to store. */
export const RELATION_TAB_MAX_ENTITIES = 200;
export const RELATION_TAB_MAX_TABS = 20;
export const RELATION_TAB_MAX_LABEL = 40;
export const RELATION_TAB_MAX_RELATIONS = 60;
export const RELATION_TAB_MAX_RELATION_NAME = 60;

/**
 * The id of the computed *Other* tab. It is reserved: a user tab may never take it, so a link to
 * `?tab=other` always means the implicit pool and never a user tab.
 */
export const OTHER_TAB_ID = 'other';

/** One user-defined tab: a group of relation names shown together. */
export const RelationTabSchema = z.object({
  /** Stable slug. A rename never changes it, so a `?tab=` link survives the rename. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** User data: what the user typed, deliberately not translated. */
  label: z.string().min(1).max(RELATION_TAB_MAX_LABEL),
  /** Position in the strip. Ties break by the stored order. */
  order: z.number().int().min(0).max(100_000),
  /** Relation names, in the order the panels render. */
  relations: z.array(z.string().min(1).max(RELATION_TAB_MAX_RELATION_NAME)).max(RELATION_TAB_MAX_RELATIONS),
});
export type RelationTab = z.infer<typeof RelationTabSchema>;

/**
 * The arrangement of one entity. The `refine` is the "one relation, one tab" rule: a write that
 * lists the same relation twice is refused with `422` rather than silently rendered twice.
 */
export const EntityRelationTabsSchema = z
  .object({
    mode: RelationTabModeSchema,
    tabs: z.array(RelationTabSchema).max(RELATION_TAB_MAX_TABS),
  })
  .refine(
    (entity) => {
      const seen = new Set<string>();
      for (const tab of entity.tabs) {
        for (const relation of tab.relations) {
          if (seen.has(relation)) return false;
          seen.add(relation);
        }
      }
      return true;
    },
    { message: 'A relation may appear in at most one tab of an entity.' },
  );
export type EntityRelationTabs = z.infer<typeof EntityRelationTabsSchema>;

/**
 * The whole per-user preference. `mode` is the default for entities the user has not configured;
 * an entity entry overrides it. Relation names are deliberately **not** checked against entity
 * metadata here: a preference written before a relation was renamed must keep working, so unknown
 * names are dropped on read (see `normalizeArrangement`) and never refused on write.
 */
export const RelationTabsSchema = z
  .object({
    mode: RelationTabModeSchema,
    entities: z.record(z.string().min(1).max(100), EntityRelationTabsSchema),
  })
  .refine((value) => Object.keys(value.entities).length <= RELATION_TAB_MAX_ENTITIES, {
    message: 'Too many entities in the relation-tab arrangement.',
  });
export type RelationTabs = z.infer<typeof RelationTabsSchema>;

/**
 * The slug a tab id is built from: lowercase, diacritics folded, everything else a dash. It is
 * derived from the label once and then never changes, which is what keeps a `?tab=` link alive
 * across a rename.
 */
export function slugifyTabId(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'tab' : slug;
}

/** A tab id that is not taken yet: `people`, `people-2`, `people-3`, … */
export function uniqueTabId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const stem = base.slice(0, 40 - suffix.length).replace(/-+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/** An arrangement with no tabs yet. */
export function emptyEntityArrangement(mode: RelationTabMode = 'stacked'): EntityRelationTabs {
  return { mode, tabs: [] };
}

/** The whole preference with nothing configured. */
export function emptyRelationTabs(): RelationTabs {
  return { mode: 'stacked', entities: {} };
}

/** The tabs of an arrangement, in display order. Ties break by the stored position. */
export function tabsOf(entity: EntityRelationTabs | null | undefined): RelationTab[] {
  if (!entity) return [];
  return entity.tabs
    .map((tab, index) => ({ tab, index }))
    .sort((a, b) => a.tab.order - b.tab.order || a.index - b.index)
    .map((entry) => ({ ...entry.tab, relations: [...entry.tab.relations] }));
}

/**
 * The default arrangement of an entity the user has never arranged: **one tab per relation**.
 *
 * It is computed, never stored. A user who switches an entity to tab mode and never touches the
 * editor keeps an empty stored value, so the preference stays exactly as small as the user made
 * it; the first edit materializes the arrangement.
 *
 * Why one tab per relation and not a single *Other* tab holding everything: the mode promises a
 * strip, and one tab with every relation in it is today's stacked page under another name — and it
 * would fetch every relation on the first paint, which is the cost the mode exists to remove. The
 * *Other* pool stays what it is for: the relations the user has moved out of a tab.
 *
 * `labelOf` supplies the tab label — the relation's own display name. A seeded tab that the user
 * keeps keeps that label; a tab the user renames is user data and is never translated again.
 */
export function seedArrangement(
  relationNames: readonly string[],
  labelOf: (relation: string) => string,
): RelationTab[] {
  const taken: string[] = [OTHER_TAB_ID];
  return relationNames.map((relation, index) => {
    const id = uniqueTabId(slugifyTabId(relation), taken);
    taken.push(id);
    const label = labelOf(relation).trim();
    return {
      id,
      label: (label === '' ? relation : label).slice(0, RELATION_TAB_MAX_LABEL),
      order: index,
      relations: [relation],
    };
  });
}

/**
 * The relations that no tab places — the pool the implicit *Other* tab renders. They are computed
 * from the entity's own relations, so a relation that exists but was never placed is never lost.
 */
export function unassignedOf(entity: EntityRelationTabs, relationNames: readonly string[]): string[] {
  const assigned = new Set(entity.tabs.flatMap((tab) => tab.relations));
  return relationNames.filter((relation) => !assigned.has(relation));
}

/**
 * Reconciles a stored arrangement with the relations an entity actually has.
 *
 * Unknown relation names are dropped (the relation was renamed or removed since the preference was
 * written), a relation listed in two tabs keeps its first tab, and the tab order is preserved. The
 * dropped relations are *not* deleted from the stored preference: the stored value stays the
 * source of truth for writes, and only the view is reconciled.
 */
export function normalizeArrangement(
  stored: EntityRelationTabs | null | undefined,
  relationNames: readonly string[],
): EntityRelationTabs {
  const known = new Set(relationNames);
  const assigned = new Set<string>();
  const seenIds = new Set<string>();
  const tabs: RelationTab[] = [];
  for (const tab of tabsOf(stored)) {
    if (seenIds.has(tab.id)) continue;
    seenIds.add(tab.id);
    const relations: string[] = [];
    for (const relation of tab.relations) {
      if (!known.has(relation) || assigned.has(relation)) continue;
      assigned.add(relation);
      relations.push(relation);
    }
    tabs.push({ id: tab.id, label: tab.label, order: tab.order, relations });
  }
  return { mode: stored?.mode === 'tabs' ? 'tabs' : 'stacked', tabs };
}

/**
 * Moves a relation into a tab, or out of every tab (`tabId === null`, which is how it reaches the
 * *Other* pool). A move, never a copy: the relation leaves the tab it was in.
 */
export function moveRelation(entity: EntityRelationTabs, relation: string, tabId: string | null): EntityRelationTabs {
  if (tabId !== null && !entity.tabs.some((tab) => tab.id === tabId)) return entity;
  return {
    ...entity,
    tabs: entity.tabs.map((tab) => ({
      ...tab,
      relations:
        tab.id === tabId
          ? [...tab.relations.filter((name) => name !== relation), relation]
          : tab.relations.filter((name) => name !== relation),
    })),
  };
}

/**
 * Appends an empty tab. Empty tabs are allowed while editing — create the tab first, move the
 * relations in later — and hidden in read mode.
 */
export function addTab(entity: EntityRelationTabs, label: string): EntityRelationTabs {
  const trimmed = label.trim();
  if (trimmed === '') return entity;
  const id = uniqueTabId(slugifyTabId(trimmed), [OTHER_TAB_ID, ...entity.tabs.map((tab) => tab.id)]);
  const order = entity.tabs.reduce((max, tab) => Math.max(max, tab.order), -1) + 1;
  return {
    ...entity,
    tabs: [...entity.tabs, { id, label: trimmed.slice(0, RELATION_TAB_MAX_LABEL), order, relations: [] }],
  };
}

/**
 * Removes a tab. Its relations are not deleted: they leave every tab and land in the implicit
 * *Other* pool, so no relation can disappear with a tab.
 */
export function removeTab(entity: EntityRelationTabs, tabId: string): EntityRelationTabs {
  return { ...entity, tabs: entity.tabs.filter((tab) => tab.id !== tabId) };
}

/** Renames a tab. The id stays exactly as it was, so links to the tab keep working. */
export function renameTab(entity: EntityRelationTabs, tabId: string, label: string): EntityRelationTabs {
  const trimmed = label.trim();
  if (trimmed === '') return entity;
  return {
    ...entity,
    tabs: entity.tabs.map((tab) => (tab.id === tabId ? { ...tab, label: trimmed.slice(0, RELATION_TAB_MAX_LABEL) } : tab)),
  };
}

/**
 * Reorders the tabs to the given id sequence. Tabs the sequence does not mention keep their
 * relative order at the end, so a stale sequence can never lose a tab.
 */
export function orderTabs(entity: EntityRelationTabs, tabIds: readonly string[]): EntityRelationTabs {
  const byId = new Map(entity.tabs.map((tab) => [tab.id, tab]));
  const ordered: RelationTab[] = [];
  const used = new Set<string>();
  for (const id of tabIds) {
    const tab = byId.get(id);
    if (!tab || used.has(id)) continue;
    used.add(id);
    ordered.push(tab);
  }
  for (const tab of entity.tabs) {
    if (!used.has(tab.id)) ordered.push(tab);
  }
  return { ...entity, tabs: ordered.map((tab, index) => ({ ...tab, order: index })) };
}

/**
 * The mode that applies to an entity: its own setting when it has one, the user's default
 * otherwise. An entity the user never configured follows the default, which is `stacked` — so a user
 * who never opens the control sees today's page.
 */
export function resolveMode(preference: RelationTabs | null | undefined, entity: string): RelationTabMode {
  const stored = preference?.entities[entity];
  if (stored?.mode === 'tabs') return 'tabs';
  if (stored?.mode === 'stacked') return 'stacked';
  return preference?.mode === 'tabs' ? 'tabs' : 'stacked';
}

/** The preference with one entity's arrangement replaced. Other entities are untouched. */
export function withEntity(preference: RelationTabs, entity: string, arrangement: EntityRelationTabs): RelationTabs {
  return { ...preference, entities: { ...preference.entities, [entity]: arrangement } };
}

/** The arrangement stored for an entity, or an empty one. */
export function entityArrangement(preference: RelationTabs | null | undefined, entity: string): EntityRelationTabs {
  return preference?.entities[entity] ?? emptyEntityArrangement();
}

/** What the record page needs to render one entity's relation area. */
export interface ResolvedRelationTabs {
  /** The mode that applies to this entity. */
  readonly mode: RelationTabMode;
  /** The tabs in display order, reconciled against the entity's relations. */
  readonly tabs: readonly RelationTab[];
  /** The relations no tab places — the implicit *Other* pool. */
  readonly unassigned: readonly string[];
}

/**
 * Resolves the relation area of one entity: the mode, the reconciled tabs and the unassigned pool.
 * The stored arrangement stays untouched — only this view is reconciled.
 */
export function resolveEntityTabs(
  preference: RelationTabs | null | undefined,
  entity: string,
  relationNames: readonly string[],
): ResolvedRelationTabs {
  const arrangement = normalizeArrangement(entityArrangement(preference, entity), relationNames);
  return { mode: resolveMode(preference, entity), tabs: tabsOf(arrangement), unassigned: unassignedOf(arrangement, relationNames) };
}
