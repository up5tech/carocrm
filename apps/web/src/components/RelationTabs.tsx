import { type EntityRelationTabs, OTHER_TAB_ID, resolveEntityTabs } from '@carocrm/metadata/relation-tabs.js';
import { Tabs } from 'antd';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { t } from '../state/i18n.js';

/**
 * The record page's relation area (PLAN_Phase_20_Settings_UX.md §5.11, sub-phase 20.18).
 *
 * The page is a **renderer**: the arrangement — stacked panels or named tabs — is the entity's
 * `detailTabs` metadata, written by an administrator in Entity Manager → Layout → detail. Nothing
 * here edits it; the record page has no tab editor, no mode switch and no preference of its own.
 *
 * What it deliberately does not do:
 *
 * - **It does not change the relation model.** Every panel is the same `/Related` call as the
 *   stacked page; tabs are presentation over them.
 * - **It does not change ACL.** A relation the caller cannot read renders nothing, and a tab whose
 *   relations are all unreadable is hidden — the stored arrangement is untouched, because
 *   permissions can come back.
 * - **It does not lose a relation.** Relations no tab names render in the implicit *Other* tab,
 *   which is computed on read and never stored.
 */

/** How a relation panel reports that the caller may not read it. */
export type RelationAccess = 'granted' | 'denied';

export interface RelationTabsProps {
  /** The entity's stored arrangement — the `detailTabs` section of its definition. */
  arrangement: EntityRelationTabs | undefined;
  /** The entity's own relations — the yardstick the arrangement is reconciled against. */
  relationNames: readonly string[];
  /** The display name of a relation. */
  labelOf: (relation: string) => string;
  /** Renders the panel of one relation; the callback reports whether the relation is readable. */
  renderPanel: (relation: string, report: (access: RelationAccess) => void) => ReactNode;
}

/**
 * The relation area of a record page: the stacked panels, or the tabs the entity's layout arranges.
 *
 * The component owns the tab strip and the `?tab=` link. The `?tab=` parameter is the tab's
 * address: a pasted link, a refresh and the browser's back button all land on the tab they name, and
 * an id the entity no longer has falls back to the first tab with the URL corrected.
 */
export function RelationTabs({ arrangement, relationNames, labelOf, renderPanel }: RelationTabsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());

  // A different arrangement is a different page; what was learned about the old one is stale.
  const arrangementKey = arrangement === undefined ? '' : JSON.stringify(arrangement);
  useEffect(() => {
    setDenied(new Set());
  }, [arrangementKey]);

  const resolved = useMemo(
    // `labelOf` only names the tabs of an entity in tab mode that has no arrangement yet — it is
    // computed, never stored, so the metadata is never rewritten by rendering it.
    () => resolveEntityTabs(arrangement, relationNames, labelOf),
    [arrangement, relationNames, labelOf],
  );

  /** The tabs the strip shows: never the empty ones, and never a tab the caller may not read. */
  const groups = useMemo(() => {
    if (resolved.mode !== 'tabs') return [];
    const tabs = resolved.tabs
      .filter((tab) => tab.relations.length > 0)
      .map((tab) => ({ id: tab.id, label: tab.label, relations: [...tab.relations] }));
    if (resolved.unassigned.length > 0) {
      tabs.push({ id: OTHER_TAB_ID, label: t('web.detail.tabs.unassigned'), relations: [...resolved.unassigned] });
    }
    return tabs.filter((tab) => !tab.relations.every((relation) => denied.has(relation)));
  }, [resolved, denied]);

  /**
   * The tab that is on screen. The URL is the single source of truth, so a link survives a reload;
   * an id the entity does not have falls back to the first tab, and the URL is corrected below.
   */
  const requestedTab = searchParams.get('tab');
  const activeKey = useMemo(() => {
    if (requestedTab !== null && groups.some((group) => group.id === requestedTab)) return requestedTab;
    return groups[0]?.id ?? '';
  }, [requestedTab, groups]);

  // Only tab mode carries the parameter — a stacked page keeps today's clean URL, so an entity
  // switched back to panels drops it.
  useEffect(() => {
    if (resolved.mode !== 'tabs') {
      if (!searchParams.has('tab')) return;
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      setSearchParams(next, { replace: true });
      return;
    }
    if (requestedTab === activeKey) return;
    const next = new URLSearchParams(searchParams);
    if (activeKey === '') next.delete('tab');
    else next.set('tab', activeKey);
    setSearchParams(next, { replace: true });
  }, [activeKey, requestedTab, resolved.mode, searchParams, setSearchParams]);

  /**
   * Switching tab is a navigation: the tab becomes a history entry, so the browser's back button
   * walks the tabs the user looked at instead of leaving the record. The correction above keeps
   * `replace`, because an id that does not exist is not a place the user ever was.
   */
  const selectTab = useCallback(
    (key: string) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', key);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const reportAccess = useCallback(
    (relation: string) => (access: RelationAccess) => {
      if (access !== 'denied') return;
      setDenied((current) => {
        if (current.has(relation)) return current;
        const next = new Set(current);
        next.add(relation);
        return next;
      });
    },
    [],
  );

  const items = groups.map((group) => ({
    key: group.id,
    label: (
      <span className="carocrm-relation-tab-label">
        {group.label}
        <span className="carocrm-relation-tab-count">{group.relations.length}</span>
      </span>
    ),
    children: (
      <div className="carocrm-relation-panels">
        {group.relations.map((relation) => renderPanel(relation, reportAccess(relation)))}
      </div>
    ),
  }));

  if (relationNames.length === 0) return null;

  if (resolved.mode !== 'tabs') {
    return (
      <div className="carocrm-relation-area">
        <div className="carocrm-relation-panels">
          {relationNames.map((relation) => renderPanel(relation, () => undefined))}
        </div>
      </div>
    );
  }

  return (
    <div className="carocrm-relation-area">
      <Tabs
        className="carocrm-relation-tabs"
        activeKey={activeKey}
        onChange={selectTab}
        items={items}
        destroyOnHidden
        tabBarGutter={16}
      />
    </div>
  );
}
