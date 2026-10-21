import { MailOutlined } from '@ant-design/icons';
import { Alert, Card, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { DocsTreeView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { useDocsSettings, useDocsTree } from '../../state/docs.js';
import { t } from '../../state/i18n.js';

/**
 * The three-column reader shell (§5.3, §5.10).
 *
 * Rail, prose, table of contents — and all of it comes from the server's tree, never from a schema the SPA
 * keeps of its own. A section the caller may not read is simply not in the payload, so the rail cannot
 * disagree with the ACL.
 *
 * Below 1180 px the right rail disappears and the section rail folds into a disclosure above the prose;
 * below 900 px there is one column. The breakpoints are in `carocrm.css`, not here, because they are
 * layout, not behaviour.
 */
export function DocsLayout({
  activeSection,
  activePage,
  actions,
  children,
}: {
  readonly activeSection?: string;
  readonly activePage?: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const tree = useDocsTree();
  const narrow = useNarrowReader();

  if (tree.isPending) {
    return (
      <div className="carocrm-doc">
        <LoadingSkeleton rows={8} />
      </div>
    );
  }

  if (tree.isError || tree.data === undefined) {
    return (
      <div className="carocrm-doc">
        <ErrorState message={tree.error instanceof Error ? tree.error.message : t('web.docs.loadFailed')} onRetry={() => void tree.refetch()} />
      </div>
    );
  }

  if (!tree.data.enabled) {
    return (
      <div className="carocrm-doc">
        <DocsDisabled externalUrl={tree.data.externalUrl} />
      </div>
    );
  }

  if (tree.data.sections.length === 0) {
    return (
      <div className="carocrm-doc">
        <DocsEmptyCorpus />
      </div>
    );
  }

  return (
    <div className="carocrm-doc">
      <div className="carocrm-doc-grid">
        {narrow ? (
          // §5.10: below 1180 the rail is a disclosure above the prose, because a 220px column of links
          // leaves the handbook with a measure nobody can read down.
          <details className="carocrm-doc-rail-details">
            <summary>{t('web.docs.sectionsNav')}</summary>
            <nav aria-label={t('web.docs.sectionsNav')}>
              <DocsRail tree={tree.data} activeSection={activeSection} activePage={activePage} />
            </nav>
          </details>
        ) : (
          <nav className="carocrm-doc-rail" aria-label={t('web.docs.sectionsNav')}>
            <DocsRail tree={tree.data} activeSection={activeSection} activePage={activePage} />
          </nav>
        )}
        <div className="carocrm-doc-prose">{children}</div>
        <aside className="carocrm-doc-side">
          {actions !== undefined ? <div className="carocrm-doc-actions">{actions}</div> : null}
        </aside>
      </div>
    </div>
  );
}

/** The §5.10 width, read from the browser so the stylesheet and the markup cannot disagree. */
function useNarrowReader(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1179px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1179px)');
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function DocsRail({
  tree,
  activeSection,
  activePage,
}: {
  readonly tree: DocsTreeView;
  readonly activeSection: string | undefined;
  readonly activePage: string | undefined;
}) {
  return (
    <>
      <Link to="/docs" className="carocrm-doc-rail-home">
        {t('web.docs.title')}
      </Link>
      {tree.sections.map((section) => (
        <div key={section.key} className="carocrm-doc-rail-section">
          <Link to={section.path} className="carocrm-doc-rail-section-title" aria-current={activeSection === section.key ? 'true' : undefined}>
            {section.title}
          </Link>
          {activeSection === section.key ? (
            <ul className="carocrm-doc-rail-pages">
              {section.pages.map((page) => (
                <li key={page.key}>
                  <PageLink page={page} active={page.key === activePage} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </>
  );
}

function PageLink({ page, active }: { readonly page: DocsTreeView['sections'][number]['pages'][number]; readonly active: boolean }) {
  return (
    <Link to={page.path} aria-current={active ? 'page' : undefined} className="carocrm-doc-rail-page">
      {page.title}
      {page.fallback ? <span className="carocrm-doc-fallback-dot" aria-hidden /> : null}
    </Link>
  );
}

/** §5.8: an instance that turned the handbook off, optionally pointing at the wiki it uses instead. */
function DocsDisabled({ externalUrl }: { readonly externalUrl: string | null }) {
  return (
    <Card className="carocrm-card">
      {externalUrl === null ? (
        <EmptyState title={t('web.docs.disabledTitle')} description={t('web.docs.disabledBody')} />
      ) : (
        <>
          <Typography.Title level={4}>{t('web.docs.movedTitle')}</Typography.Title>
          <Typography.Paragraph>{t('web.docs.movedBody')}</Typography.Paragraph>
          <a href={externalUrl} target="_blank" rel="noopener noreferrer">
            {externalUrl}
          </a>
        </>
      )}
    </Card>
  );
}

/** A missing `content/docs` is a deployment state, not an error: say so, and give the admin's address. */
function DocsEmptyCorpus() {
  const settings = useDocsSettings();
  const support = settings.data?.value.supportEmail ?? null;
  return (
    <Card className="carocrm-card">
      <EmptyState title={t('web.docs.notInstalledTitle')} description={t('web.docs.notInstalledBody')} />
      {support !== null ? (
        <Typography.Paragraph>
          <MailOutlined aria-hidden /> <a href={`mailto:${support}`}>{support}</a>
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}

/** The translation notice above a page that is being served in English (§4.6). */
export function DocsFallbackNotice({ pagePath }: { readonly pagePath: string }) {
  return (
    <Alert className="carocrm-doc-fallback" type="info" showIcon message={t('web.docs.fallbackNotice')} action={<Link to={pagePath}>{t('web.docs.fallbackLink')}</Link>} />
  );
}
