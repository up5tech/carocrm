import { Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';

import { goToHeading } from '../../components/docs/docAnchor.js';
import { DocBlocks } from '../../components/docs/DocBlocks.js';
import { useDocsPageKeys, useDocsTree } from '../../state/docs.js';
import { t } from '../../state/i18n.js';
import { DocsLayout } from './DocsLayout.js';

/**
 * `/docs/:section` — the section landing page (§5.3).
 *
 * Its content is the section's `_index.md` body, which the tree already carries, and its cards are the
 * pages in the order the corpus declares. Nothing here is filtered in the browser: a section the caller
 * may not read is not in the payload, and an unknown key is a real 404 panel rather than an empty list.
 */
export function DocsSectionPage() {
  const { section = '' } = useParams();
  const tree = useDocsTree();
  const pageKeys = useDocsPageKeys();
  const found = tree.data?.sections.find((entry) => entry.key === section);

  return (
    <DocsLayout activeSection={section}>
      <nav className="carocrm-doc-crumb" aria-label={t('web.docs.breadcrumb')}>
        <Link to="/docs">{t('web.docs.title')}</Link>
        <span aria-hidden> / </span>
        <span>{found?.title ?? section}</span>
      </nav>

      {found === undefined ? (
        <div className="carocrm-doc-missing">
          <Typography.Title level={2}>{t('web.docs.notFoundTitle')}</Typography.Title>
          <Typography.Paragraph>{t('web.docs.sectionNotFoundBody', { section })}</Typography.Paragraph>
        </div>
      ) : (
        <>
          <h1 tabIndex={-1}>{found.title}</h1>
          <p className="carocrm-doc-lede">{found.summary}</p>
          <DocBlocks
            blocks={found.blocks}
            context={{ pageKeys, section: found.key, onAnchor: goToHeading }}
          />
          <ul className="carocrm-doc-cards">
            {found.pages.map((page) => (
              <li key={page.key}>
                <Link to={page.path} className="carocrm-doc-card">
                  <span className="carocrm-doc-card-title">{page.title}</span>
                  <span className="carocrm-doc-card-summary">{page.summary}</span>
                  {page.updated !== null ? <span className="carocrm-doc-card-updated">{t('web.docs.lastReviewed', { date: page.updated })}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </DocsLayout>
  );
}
