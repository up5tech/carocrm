import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AdminPanelTab, AdminPanelView } from '../api/types.js';
import { isAdministrationRouteAllowed, RequireAdministration } from './RequireAdministration.js';

/**
 * Phase 22 G63 — a route the caller cannot serve must not render its chrome.
 *
 * Rendered to static markup with the panel query pre-seeded, so this runs in the node test project:
 * the guard's whole job is to read one server answer and pick one of three states, and each of those is
 * observable in the markup. The server's answer itself is `admin-panel.service.ts`'s business, and it is
 * asserted there.
 */

function tab(key: string, route: string): AdminPanelTab {
  return { key, labelKey: `web.admin.${key}`, icon: 'SettingOutlined', order: 1, level: 'admin', kind: 'page', route };
}

function viewWith(tabs: readonly AdminPanelTab[]): AdminPanelView {
  return { groups: tabs.length === 0 ? [] : [{ key: 'system', labelKey: 'web.admin.group', order: 1, tabs }], defaultTab: null };
}

function render(panel: AdminPanelView | null, route = '/admin/jobs'): string {
  const client = new QueryClient();
  if (panel !== null) client.setQueryData(['adminPanel'], panel);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RequireAdministration route={route}>
        <div data-testid="the-admin-page">page chrome</div>
      </RequireAdministration>
    </QueryClientProvider>,
  );
}

describe('the administration route guard (G63)', () => {
  it('lets the page render when the server offered its route', () => {
    const html = render(viewWith([tab('jobs', '/admin/jobs')]));
    expect(html).toContain('page chrome');
    expect(html).not.toContain('access');
  });

  it('refuses the page itself, not just its data, when the caller has no such route', () => {
    // The bug this closes: a non-admin typing /admin/jobs reached the page and the refusal appeared
    // *inside* it, as a 403 list. The chrome — filters, buttons, the table shell — must never render.
    const html = render(viewWith([tab('roles', '/admin/settings/roles')]));
    expect(html).not.toContain('page chrome');
    expect(html).toContain('carocrm-card');
  });

  it('refuses an empty panel rather than defaulting to allow', () => {
    expect(render(viewWith([]))).not.toContain('page chrome');
    expect(render(null)).not.toContain('page chrome');
  });

  it('matches the base route a param page was opened under', () => {
    const tabs = [tab('entityManager', '/admin/entity-manager'), tab('processes', '/admin/processes')];
    expect(isAdministrationRouteAllowed(tabs, '/admin/entity-manager')).toBe(true);
    expect(isAdministrationRouteAllowed(tabs, '/admin/audit-log')).toBe(false);
    // A param page is guarded under the base route the panel publishes.
    expect(render(viewWith(tabs), '/admin/entity-manager/jobs')).not.toContain('page chrome');
  });

  it('asks for a retry instead of guessing when the panel could not be read', () => {
    const client = new QueryClient();
    client.setQueryData(['adminPanel'], undefined);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RequireAdministration route="/admin/jobs">
          <div>page chrome</div>
        </RequireAdministration>
      </QueryClientProvider>,
    );
    // Pending is a loading state, never the page.
    expect(html).not.toContain('page chrome');
    expect(html).toContain('carocrm-visually-hidden');
  });
});
