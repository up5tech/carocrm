import { Typography } from 'antd';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { DocPageMeta } from '../../api/types.js';
import { DocSearchInput } from '../../components/docs/DocSearchInput.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { useDocsTree } from '../../state/docs.js';
import { t } from '../../state/i18n.js';
import { DocsLayout } from './DocsLayout.js';

/**
 * `/docs` — the door the sidebar entry lands on (§5.2).
 *
 * Two zones are here now: the sections, each with the pages that give them away, and "Start here". The
 * search field belongs with the results page (Phase 21.6), because a search box that cannot submit is
 * worse than no box at all.
 *
 * The administrator card is listed first for an administrator and last otherwise — and it is simply absent
 * for everyone else, because the server already filtered it out of the tree rather than the SPA deciding.
 */
export function DocsLandingPage() {
  const tree = useDocsTree();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');

  if (tree.isPending) {
    return (
      <DocsLayout>
        <LoadingSkeleton rows={8} />
      </DocsLayout>
    );
  }
  if (tree.isError || tree.data === undefined) {
    return (
      <DocsLayout>
        <ErrorState message={tree.error instanceof Error ? tree.error.message : t('web.docs.loadFailed')} onRetry={() => void tree.refetch()} />
      </DocsLayout>
    );
  }

  const sections = [...tree.data.sections].sort((left, right) => (left.audience === 'admin' ? 1 : 0) - (right.audience === 'admin' ? 1 : 0) || left.order - right.order);
  const gettingStarted = tree.data.sections.find((section) => section.key === 'getting-started');
  const recent = tree.data.sections
    .flatMap((section) => section.pages)
    .filter((page): page is DocPageMeta & { updated: string } => page.updated !== null)
    .sort((left, right) => right.updated.localeCompare(left.updated))
    .slice(0, 5);

  return (
    <DocsLayout>
      <h1 tabIndex={-1}>{t('web.docs.title')}</h1>
      <p className="carocrm-doc-lede">{t('web.docs.landingLede')}</p>

      <div className="carocrm-doc-search-head">
        <DocSearchInput
          value={draft}
          placeholder={t('web.docs.searchPlaceholder')}
          ariaLabel={t('web.docs.searchAria')}
          submitLabel={t('web.docs.searchSubmitHint')}
          onChange={setDraft}
          onSubmit={(next) => {
            const q = next.trim();
            if (q !== '') navigate(`/docs/search?q=${encodeURIComponent(q)}`);
          }}
        />
      </div>

      <div className="carocrm-doc-doors">
        {sections.map((section) => (
          <Link key={section.key} to={section.path} className="carocrm-doc-door">
            <span className="carocrm-doc-door-title">{section.title}</span>
            <span className="carocrm-doc-door-summary">{section.summary}</span>
            <ul className="carocrm-doc-door-pages">
              {section.pages.slice(0, 3).map((page) => (
                <li key={page.key}>{page.title}</li>
              ))}
            </ul>
          </Link>
        ))}
      </div>

      {gettingStarted !== undefined ? (
        <section className="carocrm-doc-start">
          <Typography.Title level={2}>{t('web.docs.startHere')}</Typography.Title>
          <ul className="carocrm-doc-linklist">
            {gettingStarted.pages.map((page) => (
              <li key={page.key}>
                <Link to={page.path}>{page.title}</Link>
                <span className="carocrm-doc-start-summary">{page.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="carocrm-doc-recent">
          <Typography.Title level={2}>{t('web.docs.recentlyReviewed')}</Typography.Title>
          <ul className="carocrm-doc-linklist">
            {recent.map((page) => (
              <li key={page.key}>
                <Link to={page.path}>{page.title}</Link>
                <span className="carocrm-doc-start-summary">{t('web.docs.lastReviewed', { date: page.updated })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </DocsLayout>
  );
}
