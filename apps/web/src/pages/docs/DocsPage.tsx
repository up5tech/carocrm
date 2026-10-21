import { LinkOutlined, PrinterOutlined, RocketOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Space, Typography } from 'antd';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../../api/client.js';
import { goToHeading } from '../../components/docs/docAnchor.js';
import { DocBlocks } from '../../components/docs/DocBlocks.js';
import { DocTocRail } from '../../components/docs/DocTocRail.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { PermissionDenied } from '../../components/PermissionDenied.js';
import { useDocPage, useDocsPageKeys } from '../../state/docs.js';
import { t } from '../../state/i18n.js';
import { DocsFallbackNotice, DocsLayout } from './DocsLayout.js';

/**
 * `/docs/:section/:slug` — the page reader (§5.3).
 *
 * The prose is the engine's block tree rendered by real components, and the table of contents, the
 * breadcrumbs and prev/next all come from the same payload, so none of them can disagree with the body
 * (§5.5). Two states are deliberately different: a page that exists but the caller may not read is
 * `PermissionDenied`, and a page nobody wrote is the not-found panel — a handbook that answers "not found"
 * for a screen you simply cannot open teaches the reader to distrust it.
 */
export function DocsPage() {
  const { section = '', slug = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const page = useDocPage(section, slug);
  const pageKeys = useDocsPageKeys();

  useEffect(() => {
    if (page.data === undefined) return;
    // An anchor link focuses its heading; an ordinary navigation keeps the reader at the top of the prose
    // instead of leaving them at the scroll position of the page they came from (§9.2 rule 2).
    const hash = window.location.hash.replace('#', '');
    if (hash !== '' && goToHeading(hash)) return;
    window.scrollTo({ top: 0 });
  }, [page.data?.page.key, location.pathname]);

  if (page.isPending) {
    return (
      <DocsLayout activeSection={section}>
        <LoadingSkeleton rows={10} />
      </DocsLayout>
    );
  }

  if (page.isError) {
    const code = page.error instanceof ApiError ? page.error.code : 'INTERNAL_ERROR';
    return (
      <DocsLayout activeSection={section}>
        {code === 'AUTHORIZATION_DENIED' ? (
          <PermissionDenied hint={t('web.docs.forbiddenBody')} />
        ) : code === 'NOT_FOUND' || code === 'RECORD_NOT_FOUND' ? (
          <div className="carocrm-doc-missing">
            <Typography.Title level={2}>{t('web.docs.notFoundTitle')}</Typography.Title>
            <Typography.Paragraph>{t('web.docs.notFoundBody', { key: `${section}/${slug}` })}</Typography.Paragraph>
            <Space>
              <Link to="/docs">{t('web.docs.backHome')}</Link>
              <Link to={`/docs/${section}`}>{t('web.docs.backToSection')}</Link>
            </Space>
          </div>
        ) : (
          <ErrorState message={page.error instanceof Error ? page.error.message : t('web.docs.loadFailed')} onRetry={() => void page.refetch()} />
        )}
      </DocsLayout>
    );
  }

  const doc = page.data?.page;
  if (doc === undefined) return null;

  const context = { pageKeys, section: doc.section, onAnchor: goToHeading };

  return (
    <DocsLayout
      activeSection={doc.section}
      activePage={doc.key}
      actions={
        <>
          <DocTocRail entries={doc.toc} label={t('web.docs.onThisPage')} disclosureLabel={t('web.docs.contents')} onSelect={goToHeading} />
          <div className="carocrm-doc-tools">
            {doc.appLink !== null ? (
              <Button type="primary" size="small" icon={<RocketOutlined />} block onClick={() => navigate(doc.appLink ?? '/home')}>
                {t('web.docs.openScreen')}
              </Button>
            ) : null}
            <Button
              size="small"
              icon={<LinkOutlined />}
              block
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => message.success(t('web.docs.linkCopied')))
                  .catch(() => message.error(t('web.docs.copyFailed')));
              }}
            >
              {t('web.docs.copyLink')}
            </Button>
            <Button size="small" icon={<PrinterOutlined />} block onClick={() => window.print()}>
              {t('web.docs.print')}
            </Button>
          </div>
        </>
      }
    >
      <nav className="carocrm-doc-crumb" aria-label={t('web.docs.breadcrumb')}>
        <Link to="/docs">{t('web.docs.title')}</Link>
        <span aria-hidden> / </span>
        <Link to={`/docs/${doc.section}`}>{doc.section}</Link>
        <span aria-hidden> / </span>
        <span>{doc.title}</span>
      </nav>

      {doc.fallback ? <DocsFallbackNotice pagePath={doc.path} /> : null}

      <h1 tabIndex={-1}>{doc.title}</h1>
      <p className="carocrm-doc-lede">{doc.summary}</p>

      <DocBlocks blocks={doc.blocks} context={context} />

      {doc.related.length > 0 ? (
        <section className="carocrm-doc-related" aria-label={t('web.docs.seeAlso')}>
          <h2>{t('web.docs.seeAlso')}</h2>
          <ul>
            {doc.related.map((entry) => (
              <li key={entry.key}>
                <Link to={entry.path}>{entry.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc.audience === 'admin' ? <p className="carocrm-doc-disclaimer">{t('web.docs.adminDisclaimer')}</p> : null}

      <nav className="carocrm-doc-pager" aria-label={t('web.docs.pageNav')}>
        {doc.prev === null ? <span /> : <Link to={doc.prev.path} className="carocrm-doc-pager-prev">← {doc.prev.title}</Link>}
        {doc.next === null ? <span /> : <Link to={doc.next.path} className="carocrm-doc-pager-next">{doc.next.title} →</Link>}
      </nav>
    </DocsLayout>
  );
}
