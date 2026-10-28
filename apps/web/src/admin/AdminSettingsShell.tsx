import { App as AntApp, Button, Input, Skeleton, Typography } from 'antd';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { AdminPanelTab } from '../api/types.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { EmptyState } from '../components/EmptyState.js';
import { navIcon } from '../components/entityIcons.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { useAdminPanel } from '../state/admin.js';
import { formatDateTime,t } from '../state/i18n.js';
import { SettingsShellProvider, useSettingsShellMeta, useSettingsShellState, useShellValue } from './shell.js';
import { TAB_COMPONENTS } from './tabs.js';

/**
 * The tabbed administration shell (PLAN_Phase_20_Settings_UX.md §4.1, §9.1, §9.2).
 *
 * `/admin/settings/:tabKey` renders one lazy tab inside a rail of the groups the server resolved for
 * this caller. The shell — not the tab — owns the sticky save bar, the unsaved-changes guard and the
 * "last modified by/at" footer, so every settings screen behaves the same way and a tab cannot forget
 * to implement it.
 */
export function AdminSettingsShell() {
  const { tabKey } = useParams<{ tabKey?: string }>();
  const panel = useAdminPanel();
  const navigate = useNavigate();
  const { modal } = AntApp.useApp();
  const shell = useSettingsShellState();
  const [railQuery, setRailQuery] = useState('');

  const tabs = useMemo(() => panel.data?.groups.flatMap((group) => [...group.tabs]) ?? [], [panel.data]);
  const filteredRailTabs = useMemo(() => {
    const all = panel.data?.groups.flatMap((group) => [...group.tabs]) ?? [];
    const q = railQuery.trim().toLowerCase();
    if (q === '') return null;
    return all.filter((tab) => {
      const label = t(tab.labelKey).toLowerCase();
      const description = tab.descriptionKey !== undefined ? t(tab.descriptionKey).toLowerCase() : '';
      const keywords = (tab.keywords ?? []).join(' ').toLowerCase();
      return label.includes(q) || description.includes(q) || keywords.includes(q);
    });
  }, [panel.data, railQuery]);
  const active = tabs.find((tab) => tab.key === tabKey);

  // §20.25 (3): ?highlight=<field> lands on the matching control and briefly marks it.
  useEffect(() => {
    if (active === undefined) return;
    const params = new URLSearchParams(window.location.search);
    const field = params.get('highlight');
    if (field === null || field === '') return;
    const timer = window.setTimeout(() => {
      const target =
        document.getElementById(field) ??
        document.querySelector<HTMLElement>(`[name="${field}"]`) ??
        document.querySelector<HTMLElement>(`[aria-label="${field}"]`);
      if (target === null) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus?.({ preventScroll: true });
      target.classList.add('carocrm-highlight');
      window.setTimeout(() => target.classList.remove('carocrm-highlight'), 2000);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [active, tabKey]);
  // The tab descriptor's handbook key is what the shell header links to while that tab is open.
  usePageDocs(active?.docKey);
  // The bar belongs to a form over one draft: a settings document, a hosted module document, or a tab
  // that opted in (the layout manager writes entity metadata). Record tabs save per action instead.
  const hasDocument = active?.document !== undefined || active?.moduleEndpoint !== undefined || active?.usesSaveBar === true;

  // No tab key: open the first tab this caller may use, so a bookmark on `/admin/settings` still lands.
  useEffect(() => {
    if (tabKey !== undefined || panel.data === undefined || panel.data.defaultTab === null) return;
    void navigate(`/admin/settings/${panel.data.defaultTab}`, { replace: true });
  }, [tabKey, panel.data, navigate]);

  const reset = shell.reset;
  // A different tab starts from a clean bar; the tab that mounts republishes its own state. Only the
  // tab key may trigger this — the shell object changes whenever a tab reports its state, and
  // resetting on that would erase the very dirty flag the tab just set.
  useEffect(() => {
    reset();
  }, [tabKey, reset]);

  // The router here is a plain `BrowserRouter`, which offers no navigation blocker, so the guard covers
  // the paths the shell controls: its own rail and an attempt to close the browser with a dirty form.
  useEffect(() => {
    if (!shell.meta.dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, [shell.meta.dirty]);

  const open = (tab: AdminPanelTab): void => {
    if (!shell.meta.dirty) {
      void navigate(tab.route);
      return;
    }
    modal.confirm({
      title: t('web.adminShell.unsavedTitle'),
      content: t('web.adminShell.unsavedBody'),
      okText: t('web.adminShell.leave'),
      cancelText: t('core.common.cancel'),
      onOk: () => {
        shell.reset();
        void navigate(tab.route);
      },
    });
  };

  const body = () => {
    if (panel.isLoading) return <LoadingSkeleton rows={8} />;
    if (panel.isError) {
      return <ErrorState message={t('web.adminShell.loadFailed')} onRetry={() => void panel.refetch()} />;
    }
    // An unknown or forbidden tab key answers with the refusal state, never a partial render (§11).
    if (tabKey === undefined || active === undefined) {
      return <EmptyState title={t('web.adminShell.noAccess')} description={t('web.adminShell.noAccessHint')} />;
    }
    const Tab = TAB_COMPONENTS[active.key];
    if (Tab === undefined) return <EmptyState title={t('web.adminShell.unknownTab')} />;
    return (
        <div className="carocrm-admin-panel">
          <header className="carocrm-admin-tab-head">
            <h1 className="carocrm-page-title">{t(active.labelKey)}</h1>
            {active.descriptionKey !== undefined ? <p className="carocrm-page-sub">{t(active.descriptionKey)}</p> : null}
          </header>
          <Suspense fallback={<Skeleton active paragraph={{ rows: 6 }} />}>
            <Tab />
          </Suspense>
        </div>
    );
  };

  return (
    <SettingsShellProvider value={shell}>
      <div className="carocrm-admin">
        <nav className="carocrm-admin-rail" aria-label={t('web.adminShell.railLabel')}>
        <div style={{ padding: '0 8px 8px' }}>
          <Input
            size="small"
            allowClear
            placeholder={t('web.adminShell.searchPlaceholder')}
            aria-label={t('web.adminShell.searchPlaceholder')}
            value={railQuery}
            onChange={(event) => setRailQuery(event.target.value)}
          />
        </div>
        {panel.data === undefined ? (
          <Skeleton active title={false} paragraph={{ rows: 8 }} />
        ) : filteredRailTabs !== null ? (
          filteredRailTabs.length === 0 ? (
            <EmptyState title={t('web.adminShell.noSettingMatches')} />
          ) : (
            <ul className="carocrm-admin-tabs" role="list">
              {filteredRailTabs.map((tab) => {
                const selected = tab.key === active?.key;
                return (
                  <li key={tab.key}>
                    <button
                      type="button"
                      className={`carocrm-admin-tab${selected ? ' is-selected' : ''}`}
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => open(tab)}
                    >
                      <span className="carocrm-admin-tab-icon" aria-hidden="true">
                        {navIcon(tab.icon)}
                      </span>
                      <span className="carocrm-admin-tab-label">{t(tab.labelKey)}</span>
                      {selected && shell.meta.dirty ? <span className="carocrm-admin-tab-dot" title={t('web.adminShell.dirty')} aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          panel.data.groups.map((group) => (
            <div className="carocrm-admin-group" key={group.key}>
              <p className="carocrm-admin-group-title">{t(group.labelKey)}</p>
              <ul className="carocrm-admin-tabs" role="list">
                {group.tabs.map((tab) => {
                  const selected = tab.key === active?.key;
                  return (
                    <li key={tab.key}>
                      <button
                        type="button"
                        className={`carocrm-admin-tab${selected ? ' is-selected' : ''}`}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => open(tab)}
                      >
                        <span className="carocrm-admin-tab-icon" aria-hidden="true">
                          {navIcon(tab.icon)}
                        </span>
                        <span className="carocrm-admin-tab-label">{t(tab.labelKey)}</span>
                        {selected && shell.meta.dirty ? <span className="carocrm-admin-tab-dot" title={t('web.adminShell.dirty')} aria-hidden="true" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>

        <div className="carocrm-admin-main">
          {body()}
          {hasDocument ? <SaveBar /> : null}
        </div>
      </div>
    </SettingsShellProvider>
  );
}

/**
 * Sticky save bar: Save is enabled only while the tab is dirty, Discard reverts to the loaded value,
 * Reload refetches, and the footer states who changed the document last (§4.1, §9.2).
 */
function SaveBar() {
  const shell = useShellValue();
  const meta = useSettingsShellMeta();
  if (shell === null) return null;
  return (
    <div className="carocrm-admin-savebar" role="group" aria-label={t('web.adminShell.saveBar')}>
      <Typography.Text type="secondary" className="carocrm-admin-modified">
        {meta.modifiedAt === null
          ? t('web.adminShell.neverModified')
          : t('web.adminShell.lastModified', { by: meta.modifiedBy ?? '-', at: formatDateTime(meta.modifiedAt) })}
      </Typography.Text>
      <div className="carocrm-admin-savebar-actions">
        <Button onClick={() => shell.actions.current.onReload()} disabled={!meta.canSave}>
          {t('core.common.reload')}
        </Button>
        <Button onClick={() => shell.actions.current.onDiscard()} disabled={!meta.dirty}>
          {t('web.adminShell.discard')}
        </Button>
        <Button type="primary" onClick={() => shell.actions.current.onSave()} loading={meta.saving} disabled={!meta.dirty || !meta.canSave}>
          {t('web.common.save')}
        </Button>
      </div>
    </div>
  );
}
