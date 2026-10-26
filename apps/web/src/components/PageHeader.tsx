import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { announcePage, setPageTitle } from '../state/page-title.js';
import { usePageDocs } from './docs/PageDocs.js';

/**
 * The one page frame (Phase 20.24): everyscreen's `h1` comes from this component, so the page
 * head markup — head row, title, subtitle, actions — is typed once instead of per screen
 * (F5), the browser tab reads `"<page> · <brand>"` (F6), and the shell focuses the content and
 * announces the landing page on a route change (F7).
 */

/**
 * F6: calls `setPageTitle` for as long as the screen is mounted; leaving the screen clears it so
 * the tab falls back to the brand. Exported separately because the workspace screens that keep
 * their own head (`/home`, `/crm-chat`, `/voice-inbox`) adopt it without adopting the markup.
 */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    setPageTitle(title);
    return () => setPageTitle(undefined);
  }, [title]);
}

/**
 * F7: on a pathname change, keyboard focus moves into the content (`#carocrm-content`, which
 * already carries `tabIndex={-1}`) and the landing page is announced in the live region. A
 * query-string-only change (filtering a list) deliberately moves nothing — a filter is not a page.
 * The mount is skipped too: nothing has been lost that focus should restore to.
 */
export function useRouteFocus(): void {
  const { pathname } = useLocation();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const content = document.getElementById('carocrm-content');
    content?.focus({ preventScroll: true });
    announcePage();
  }, [pathname]);
}

export interface PageHeaderProps {
  /** The page's name. Rendered as the screen's only `<h1>`; also becomes the browser-tab title. */
  readonly title: string;
  /** A subordinate line under the title (`carocrm-page-sub`). */
  readonly subtitle?: ReactNode;
  /** The right-hand action row; rendered exactly where the page used to put its own actions. */
  readonly actions?: ReactNode;
  /** A back affordance rendered before the title in the head's title block. */
  readonly back?: ReactNode;
  /** Renders `usePageDocs(docKey)` when given, so the header owns the handbook link. */
  readonly docKey?: string;
  /**
   * A screen whose head carries an established local idiom (the list's `carocrm-list-head`) keeps
   * that class instead of the default frame; the semantics — one `h1`, the title store — stay.
   */
  readonly headClassName?: string;
  /** Extra inline rows (breadcrumbs, tab strips) rendered below the head. */
  readonly children?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, back, docKey, headClassName, children }: PageHeaderProps) {
  usePageDocs(docKey);
  usePageTitle(title);
  return (
    <>
      <div className={headClassName ?? 'carocrm-page-head'}>
        <div>
          {back}
          <h1 className="carocrm-page-title">{title}</h1>
          {subtitle !== undefined ? <p className="carocrm-page-sub">{subtitle}</p> : null}
        </div>
        {actions !== undefined ? actions : null}
      </div>
      {children}
    </>
  );
}
