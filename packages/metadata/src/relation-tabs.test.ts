import { describe, expect, it } from 'vitest';

import {
  addTab,
  type EntityRelationTabs,
  EntityRelationTabsSchema,
  moveRelation,
  normalizeArrangement,
  orderTabs,
  OTHER_TAB_ID,
  removeTab,
  renameTab,
  resolveEntityTabs,
  seedArrangement,
  slugifyTabId,
  tabsOf,
  unassignedOf,
  uniqueTabId,
} from './relation-tabs.js';

/**
 * The relation-tab arrangement (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * These helpers are the whole contract between the API (which validates a write) and the SPA (which
 * normalizes a read), so the cases below are the ones the product promises: no relation is ever
 * lost, a relation lives in exactly one tab, an unknown relation name is dropped instead of
 * refused, and a tab id survives a rename so a shared link keeps working.
 */
describe('relation-tab arrangement', () => {
  describe('slugifyTabId', () => {
    it('turns a label into a stable lowercase slug', () => {
      expect(slugifyTabId('People')).toBe('people');
      expect(slugifyTabId('Activity Feed')).toBe('activity-feed');
      expect(slugifyTabId('Người dùng')).toBe('nguoi-dung');
      expect(slugifyTabId('  Contacts & Leads  ')).toBe('contacts-leads');
    });

    it('falls back to a usable id when the label has nothing to slugify', () => {
      expect(slugifyTabId('***')).toBe('tab');
      expect(slugifyTabId('')).toBe('tab');
    });

    it('keeps the slug inside the id pattern', () => {
      const slug = slugifyTabId('A'.repeat(80));
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    });
  });

  describe('uniqueTabId', () => {
    it('suffixes a taken id', () => {
      expect(uniqueTabId('people', [])).toBe('people');
      expect(uniqueTabId('people', ['people'])).toBe('people-2');
      expect(uniqueTabId('people', ['people', 'people-2'])).toBe('people-3');
    });
  });

  describe('normalizeArrangement', () => {
    const stored: EntityRelationTabs = {
      mode: 'tabs',
      tabs: [
        { id: 'people', label: 'People', order: 0, relations: ['contacts', 'leads'] },
        { id: 'activity', label: 'Activity', order: 10, relations: ['tasks'] },
      ],
    };

    it('keeps the tabs, their order and their relations', () => {
      const result = normalizeArrangement(stored, ['contacts', 'leads', 'tasks', 'opportunities']);
      expect(result.mode).toBe('tabs');
      expect(result.tabs.map((tab) => tab.id)).toEqual(['people', 'activity']);
      expect(result.tabs[0]?.relations).toEqual(['contacts', 'leads']);
    });

    it('drops a relation the entity no longer has, without touching the rest', () => {
      const result = normalizeArrangement(stored, ['contacts', 'tasks']);
      expect(result.tabs[0]?.relations).toEqual(['contacts']);
      expect(result.tabs[1]?.relations).toEqual(['tasks']);
    });

    it('keeps a relation in its first tab when a stored value lists it twice', () => {
      const duplicated: EntityRelationTabs = {
        mode: 'tabs',
        tabs: [
          { id: 'a', label: 'A', order: 0, relations: ['contacts'] },
          { id: 'b', label: 'B', order: 1, relations: ['contacts'] },
        ],
      };
      const result = normalizeArrangement(duplicated, ['contacts']);
      expect(result.tabs[0]?.relations).toEqual(['contacts']);
      expect(result.tabs[1]?.relations).toEqual([]);
    });

    it('falls back to stacked for an arrangement that was never stored', () => {
      expect(normalizeArrangement(undefined, ['contacts']).mode).toBe('stacked');
      expect(normalizeArrangement(undefined, ['contacts']).tabs).toEqual([]);
    });
  });

  describe('unassignedOf', () => {
    it('lists the relations no tab places, in the entity’s own order', () => {
      const arrangement: EntityRelationTabs = {
        mode: 'tabs',
        tabs: [{ id: 'people', label: 'People', order: 0, relations: ['contacts'] }],
      };
      expect(unassignedOf(arrangement, ['contacts', 'leads', 'tasks'])).toEqual(['leads', 'tasks']);
    });

    it('is empty when every relation is placed', () => {
      const arrangement: EntityRelationTabs = {
        mode: 'tabs',
        tabs: [{ id: 'people', label: 'People', order: 0, relations: ['contacts', 'leads'] }],
      };
      expect(unassignedOf(arrangement, ['contacts', 'leads'])).toEqual([]);
    });
  });

  describe('moveRelation', () => {
    const arrangement: EntityRelationTabs = {
      mode: 'tabs',
      tabs: [
        { id: 'people', label: 'People', order: 0, relations: ['contacts'] },
        { id: 'activity', label: 'Activity', order: 1, relations: ['tasks'] },
      ],
    };

    it('moves a relation between tabs exactly once', () => {
      const moved = moveRelation(arrangement, 'contacts', 'activity');
      expect(moved.tabs[0]?.relations).toEqual([]);
      expect(moved.tabs[1]?.relations).toEqual(['tasks', 'contacts']);
      const placed = moved.tabs.flatMap((tab) => tab.relations);
      expect(placed.filter((name) => name === 'contacts')).toHaveLength(1);
    });

    it('takes a relation out of every tab when the target is null', () => {
      const moved = moveRelation(arrangement, 'contacts', null);
      expect(moved.tabs.flatMap((tab) => tab.relations)).toEqual(['tasks']);
    });

    it('ignores a move to a tab that does not exist', () => {
      expect(moveRelation(arrangement, 'contacts', 'nope')).toBe(arrangement);
    });
  });

  describe('addTab, renameTab, removeTab and orderTabs', () => {
    const empty: EntityRelationTabs = { mode: 'tabs', tabs: [] };

    it('adds an empty tab with a slugified id', () => {
      const added = addTab(empty, 'People');
      expect(added.tabs).toHaveLength(1);
      expect(added.tabs[0]?.id).toBe('people');
      expect(added.tabs[0]?.label).toBe('People');
      expect(added.tabs[0]?.relations).toEqual([]);
    });

    it('never takes the reserved Other id', () => {
      const added = addTab(empty, 'Other');
      expect(added.tabs[0]?.id).not.toBe(OTHER_TAB_ID);
    });

    it('ignores an empty label', () => {
      expect(addTab(empty, '   ')).toBe(empty);
    });

    it('keeps the id when a tab is renamed', () => {
      const added = addTab(empty, 'People');
      const renamed = renameTab(added, added.tabs[0]?.id ?? '', 'Contacts & Leads');
      expect(renamed.tabs[0]?.id).toBe('people');
      expect(renamed.tabs[0]?.label).toBe('Contacts & Leads');
    });

    it('returns a removed tab’s relations to the pool instead of deleting them', () => {
      const withRelation = moveRelation(addTab(empty, 'People'), 'contacts', 'people');
      const removed = removeTab(withRelation, 'people');
      expect(removed.tabs).toHaveLength(0);
      expect(unassignedOf(removed, ['contacts'])).toEqual(['contacts']);
    });

    it('reorders the tabs and keeps a tab the sequence does not mention', () => {
      const arrangement: EntityRelationTabs = {
        mode: 'tabs',
        tabs: [
          { id: 'a', label: 'A', order: 0, relations: [] },
          { id: 'b', label: 'B', order: 1, relations: [] },
          { id: 'c', label: 'C', order: 2, relations: [] },
        ],
      };
      const reordered = orderTabs(arrangement, ['c', 'a']);
      expect(reordered.tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b']);
      expect(reordered.tabs.map((tab) => tab.order)).toEqual([0, 1, 2]);
    });

    it('sorts by order, breaking ties by the stored position', () => {
      const arrangement: EntityRelationTabs = {
        mode: 'tabs',
        tabs: [
          { id: 'b', label: 'B', order: 5, relations: [] },
          { id: 'a', label: 'A', order: 5, relations: [] },
          { id: 'c', label: 'C', order: 1, relations: [] },
        ],
      };
      expect(tabsOf(arrangement).map((tab) => tab.id)).toEqual(['c', 'b', 'a']);
    });
  });

  describe('seedArrangement', () => {
    const labelOf = (relation: string): string => relation.charAt(0).toUpperCase() + relation.slice(1);

    it('gives every relation a tab of its own, in the entity’s order', () => {
      const seeded = seedArrangement(['cases', 'contacts'], labelOf);
      expect(seeded.map((tab) => tab.id)).toEqual(['cases', 'contacts']);
      expect(seeded.map((tab) => tab.label)).toEqual(['Cases', 'Contacts']);
      expect(seeded.map((tab) => tab.relations)).toEqual([['cases'], ['contacts']]);
      expect(seeded.map((tab) => tab.order)).toEqual([0, 1]);
    });

    it('places every relation, so the Other pool stays empty', () => {
      const seeded = seedArrangement(['cases', 'contacts'], labelOf);
      expect(unassignedOf({ mode: 'tabs', tabs: seeded }, ['cases', 'contacts'])).toEqual([]);
    });

    it('never takes the reserved Other id', () => {
      const seeded = seedArrangement(['other'], labelOf);
      expect(seeded[0]?.id).not.toBe(OTHER_TAB_ID);
    });

    it('keeps the ids unique when two relations slugify alike', () => {
      const seeded = seedArrangement(['salesOrders', 'sales_orders'], labelOf);
      expect(new Set(seeded.map((tab) => tab.id)).size).toBe(2);
      expect(seeded.every((tab) => tab.id !== OTHER_TAB_ID)).toBe(true);
    });

    it('falls back to the relation name when the display label is empty', () => {
      const seeded = seedArrangement(['cases'], () => '   ');
      expect(seeded[0]?.label).toBe('cases');
    });
  });

  describe('resolveEntityTabs', () => {
    const labelOf = (relation: string): string => relation.charAt(0).toUpperCase() + relation.slice(1);

    it('renders the stacked page for an entity that was never arranged', () => {
      const resolved = resolveEntityTabs(undefined, ['contacts', 'leads'], labelOf);
      expect(resolved.mode).toBe('stacked');
      expect(resolved.tabs).toEqual([]);
    });

    it('drops a relation the entity no longer has and reports the unplaced ones', () => {
      const resolved = resolveEntityTabs(
        { mode: 'tabs', tabs: [{ id: 'people', label: 'People', order: 0, relations: ['contacts', 'gone'] }] },
        ['contacts', 'leads'],
        labelOf,
      );
      expect(resolved.mode).toBe('tabs');
      expect(resolved.tabs[0]?.relations).toEqual(['contacts']);
      expect(resolved.unassigned).toEqual(['leads']);
    });

    it('gives every relation a tab of its own when the entity has no arrangement yet', () => {
      const resolved = resolveEntityTabs({ mode: 'tabs', tabs: [] }, ['cases', 'contacts'], labelOf);
      expect(resolved.tabs.map((tab) => tab.id)).toEqual(['cases', 'contacts']);
      expect(resolved.unassigned).toEqual([]);
    });
  });

  describe('EntityRelationTabsSchema', () => {
    const valid = {
      mode: 'tabs',
      tabs: [{ id: 'people', label: 'People', order: 10, relations: ['contacts'] }],
    };

    it('accepts a valid arrangement', () => {
      expect(EntityRelationTabsSchema.safeParse(valid).success).toBe(true);
    });

    it('refuses a relation listed in two tabs', () => {
      const duplicated = {
        mode: 'tabs',
        tabs: [
          { id: 'a', label: 'A', order: 0, relations: ['contacts'] },
          { id: 'b', label: 'B', order: 1, relations: ['contacts'] },
        ],
      };
      expect(EntityRelationTabsSchema.safeParse(duplicated).success).toBe(false);
    });

    it('refuses a label longer than 40 characters', () => {
      const oversized = { mode: 'tabs', tabs: [{ id: 'a', label: 'x'.repeat(41), order: 0, relations: [] }] };
      expect(EntityRelationTabsSchema.safeParse(oversized).success).toBe(false);
    });

    it('refuses more than 20 tabs', () => {
      const many = {
        mode: 'tabs',
        tabs: Array.from({ length: 21 }, (_unused, index) => ({
          id: `tab-${index}`,
          label: `Tab ${index}`,
          order: index,
          relations: [],
        })),
      };
      expect(EntityRelationTabsSchema.safeParse(many).success).toBe(false);
    });

    it('refuses an id that is not a slug', () => {
      const bad = { mode: 'tabs', tabs: [{ id: 'People!', label: 'People', order: 0, relations: [] }] };
      expect(EntityRelationTabsSchema.safeParse(bad).success).toBe(false);
    });

    it('refuses the reserved Other id', () => {
      const reserved = { mode: 'tabs', tabs: [{ id: OTHER_TAB_ID, label: 'Other', order: 0, relations: [] }] };
      expect(EntityRelationTabsSchema.safeParse(reserved).success).toBe(false);
    });

    it('refuses two tabs that share an id', () => {
      const duplicatedIds = {
        mode: 'tabs',
        tabs: [
          { id: 'a', label: 'A', order: 0, relations: [] },
          { id: 'a', label: 'A again', order: 1, relations: [] },
        ],
      };
      expect(EntityRelationTabsSchema.safeParse(duplicatedIds).success).toBe(false);
    });

    it('refuses an unknown mode', () => {
      expect(EntityRelationTabsSchema.safeParse({ mode: 'grid', tabs: [] }).success).toBe(false);
    });
  });
});
