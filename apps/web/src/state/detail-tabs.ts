import {
  addTab,
  emptyRelationTabs,
  entityArrangement,
  type EntityRelationTabs,
  moveRelation,
  normalizeArrangement,
  orderTabs,
  type RelationTab,
  type RelationTabMode,
  type RelationTabs,
  removeTab,
  renameTab,
  resolveMode,
  seedArrangement,
  unassignedOf,
  withEntity,
} from '@carocrm/metadata/relation-tabs.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { api } from '../api/client.js';

/**
 * The user's relation-tab arrangement for the record page (PLAN_Phase_20_Settings_UX.md §5.11,
 * sub-phase 20.18).
 *
 * The preference is the **server's** value: it is read through the same `['preferences', name]`
 * query key every other preference uses, so the arrangement follows the account to the next device.
 * A write is optimistic — the page reacts immediately — and a rejected write restores the last
 * stored arrangement and reports the error instead of dropping the draft.
 *
 * The stored value stays the source of truth for writes. The *view* is reconciled against the
 * entity's own relations, so a relation that was renamed or made unreadable disappears from the
 * view without being deleted from the stored arrangement: permissions can come back, and a stored
 * preference must survive a rename.
 */

/** The query key the arrangement shares with the generic preference reader. */
const DETAIL_TABS_QUERY_KEY = ['preferences', 'detailTabs'] as const;

export interface DetailTabsController {
  /** The mode that applies to this entity: its own setting, or the user's default. */
  readonly mode: RelationTabMode;
  /** The reconciled tabs, in display order. */
  readonly tabs: readonly RelationTab[];
  /** The relations no tab places — the implicit *Other* pool. */
  readonly unassigned: readonly string[];
  /**
   * The arrangement the page shows: the stored one, reconciled, or the computed default for an
   * entity the user has never arranged. The editor starts from this.
   */
  readonly effective: EntityRelationTabs;
  /** The stored arrangement of this entity, unreconciled: what a write starts from. */
  readonly stored: EntityRelationTabs;
  /** Whether the user has ever configured this entity. */
  readonly configured: boolean;
  /** The user's default mode for entities they have not configured. */
  readonly defaultMode: RelationTabMode;
  /** Whether the arrangement is still being read. A write is refused until it is known. */
  readonly loading: boolean;
  /** Whether a write is in flight. */
  readonly saving: boolean;
  /** The last write error, if any. The caller shows it inline. */
  readonly error: string | null;
  /** Applies a mutation to the stored arrangement of this entity and writes the preference. */
  readonly update: (mutate: (arrangement: EntityRelationTabs) => EntityRelationTabs) => void;
  /** Writes an arrangement for this entity. The promise rejects when the write is refused. */
  readonly save: (arrangement: EntityRelationTabs) => Promise<void>;
  /** Sets the mode of this entity. Switching back keeps the arrangement. */
  readonly setMode: (mode: RelationTabMode) => void;
  /** The default arrangement of an entity the user has never arranged: one tab per relation. */
  readonly seeded: readonly RelationTab[];
  /** Sets the default mode for every entity the user has not configured. */
  readonly setDefaultMode: (mode: RelationTabMode) => void;
  /** Clears the reported error. */
  readonly dismissError: () => void;
}

/** A stored value is only used when it has the shape the schema guarantees. */
function asPreference(value: unknown): RelationTabs {
  if (typeof value !== 'object' || value === null) return emptyRelationTabs();
  const candidate = value as Partial<RelationTabs>;
  if (candidate.mode !== 'stacked' && candidate.mode !== 'tabs') return emptyRelationTabs();
  if (typeof candidate.entities !== 'object' || candidate.entities === null) return emptyRelationTabs();
  return { mode: candidate.mode, entities: candidate.entities };
}

/**
 * The relation-tab arrangement of one entity.
 *
 * `relationNames` are the entity's own relations. They are the yardstick the stored arrangement is
 * reconciled against, so a name that no longer exists is dropped from the view and a relation that
 * exists but was never placed shows up in the *Other* pool.
 *
 * `labelOf` names a relation in the user's language; it labels the tabs of the default
 * arrangement, which is computed and never stored.
 *
 * `enabled` is false where the tabs are out of scope — the portal stays stacked (§5.11), so it
 * neither fetches the arrangement nor offers the control.
 */
export function useDetailTabs(
  entity: string | undefined,
  relationNames: readonly string[],
  labelOf: (relation: string) => string,
  enabled = true,
): DetailTabsController {
  const client = useQueryClient();
  const [draft, setDraft] = useState<RelationTabs | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: DETAIL_TABS_QUERY_KEY,
    queryFn: () => api.preference('detailTabs'),
    staleTime: 60_000,
    enabled,
  });

  const server = useMemo(() => asPreference(query.data?.value), [query.data]);
  const preference = draft ?? server;

  const writer = useMutation({
    mutationFn: (value: RelationTabs) => api.savePreference('detailTabs', value),
    onSuccess: (saved) => {
      // The saved row is the truth from now on; the optimistic overlay can go.
      client.setQueryData(DETAIL_TABS_QUERY_KEY, saved);
      setDraft(null);
      setError(null);
    },
    onError: (cause) => {
      // The write was refused: restore the last stored arrangement and explain why.
      setDraft(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    },
  });

  const save = useCallback(
    (arrangement: EntityRelationTabs): Promise<void> => {
      if (!entity || !enabled) return Promise.resolve();
      // A write before the stored value is known would overwrite it with an empty arrangement.
      if (query.isPending) return Promise.resolve();
      const next = withEntity(preference, entity, arrangement);
      setDraft(next);
      setError(null);
      return writer.mutateAsync(next).then(() => undefined);
    },
    [entity, enabled, preference, query.isPending, writer],
  );

  const update = useCallback(
    (mutate: (arrangement: EntityRelationTabs) => EntityRelationTabs) => {
      if (!entity) return;
      void save(mutate(entityArrangement(preference, entity))).catch(() => undefined);
    },
    [entity, preference, save],
  );

  const mode = enabled ? resolveMode(preference, entity ?? '') : 'stacked';

  // The default arrangement of an entity the user has never arranged: one tab per relation. It is
  // computed, never stored — the first write materializes it.
  const seeded = useMemo(() => seedArrangement(relationNames, labelOf), [relationNames, labelOf]);

  const setMode = useCallback(
    (next: RelationTabMode) => {
      update((arrangement) => ({
        ...arrangement,
        mode: next,
        // Switching to tab mode materializes the default arrangement — one tab per relation — so
        // the strip the user sees is the arrangement that is stored. Switching back keeps it
        // (PLAN §5.11 rule 10): the mode is a rendering, not a reset.
        tabs: next === 'tabs' && arrangement.tabs.length === 0 ? [...seeded] : arrangement.tabs,
      }));
    },
    [update, seeded],
  );

  const setDefaultMode = useCallback(
    (next: RelationTabMode) => {
      if (!enabled || query.isPending) return;
      const nextPreference: RelationTabs = { ...preference, mode: next };
      setDraft(nextPreference);
      setError(null);
      writer.mutate(nextPreference);
    },
    [enabled, preference, query.isPending, writer],
  );

  // The stored arrangement is what a write starts from, so it must keep its identity while the
  // preference is unchanged: the record page memoizes on it, and a fresh object on every render
  // would recompute the tab strip (and re-run the `?tab=` effect) for nothing.
  const stored = useMemo(() => entityArrangement(preference, entity ?? ''), [preference, entity]);

  // An entity the user has never arranged has no stored entry; it shows the default arrangement.
  // An entity they have arranged shows exactly what they arranged — including an arrangement they
  // emptied, whose relations then live in the *Other* pool.
  const configured = preference.entities[entity ?? ''] !== undefined;
  const effective = useMemo(
    () =>
      configured
        ? normalizeArrangement(stored, relationNames)
        : { mode, tabs: [...seeded] },
    [configured, stored, relationNames, mode, seeded],
  );

  const tabs = useMemo(() => effective.tabs, [effective.tabs]);
  const unassigned = useMemo(() => unassignedOf(effective, relationNames), [effective, relationNames]);

  return {
    mode,
    tabs,
    unassigned,
    effective,
    stored,
    configured,
    seeded,
    defaultMode: preference.mode,
    loading: query.isPending,
    saving: writer.isPending,
    error,
    update,
    save,
    setMode,
    setDefaultMode,
    dismissError: () => setError(null),
  };
}

/**
 * The tab mutations the manage mode offers, applied to a stored arrangement.
 *
 * They are pure and live beside the read side so the two cannot drift: a move removes the relation
 * from the tab it was in, and a removed tab returns its relations to the pool rather than deleting
 * them.
 */
export const detailTabMutations = {
  add: (arrangement: EntityRelationTabs, label: string): EntityRelationTabs => addTab(arrangement, label),
  rename: (arrangement: EntityRelationTabs, tabId: string, label: string): EntityRelationTabs =>
    renameTab(arrangement, tabId, label),
  remove: (arrangement: EntityRelationTabs, tabId: string): EntityRelationTabs => removeTab(arrangement, tabId),
  move: (arrangement: EntityRelationTabs, relation: string, tabId: string | null): EntityRelationTabs =>
    moveRelation(arrangement, relation, tabId),
  reorder: (arrangement: EntityRelationTabs, tabIds: readonly string[]): EntityRelationTabs =>
    orderTabs(arrangement, tabIds),
};
