import { Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import type { DocSearchHit } from '../../api/types.js';
import { DocSearchInput } from '../../components/docs/DocSearchInput.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { useDocSearch,useDocsSettings, useDocsTree } from '../../state/docs.js';
import { t } from '../../state/i18n.js';
import { DocsLayout } from './DocsLayout.js';

/**
 * `/docs/search?q=…` — the results page (§5.4).
 *
 * The query lives in the URL and nowhere else, which is what makes a search shareable and the back button
 * honest. The highlighting is the server's: the API returns `ranges` (offsets into the snippet text) and the
 * page wraps those slices in `<mark>` — the response never carries markup, so there is no HTML to trust.
 *
 * A hit that arrived from English while the reader is reading Vietnamese says so with a badge: a fallback
 * result that looks translated is worse than one that admits it is not.
 */
export function DocsSearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get('q') ?? '';
  const tree = useDocsTree();
  const settings = useDocsSettings();
  const search = useDocSearch(query);
  const resultsRef = useRef<HTMLHeadingElement>(null);

  const writeQuery = useCallback(
    (next: string, replace: boolean) => {
      const trimmed = next.trim();
      navigate({ pathname: '/docs/search', search: trimmed === '' ? '' : `?q=${encodeURIComponent(trimmed)}` }, { replace });
    },
    [navigate],
  );

  useEffect(() => {
    const live = document.getElementById('carocrm-live-region');
    if (live !== null && search.data !== undefined) live.textContent = t('web.docs.resultsAnnounce', { count: search.data.total, query });
  }, [search.data, query]);

  useEffect(() => {
    // Focus the results heading on a submit, so a keyboard reader lands on the answer, not on the field.
    if (query !== '' && search.data !== undefined) resultsRef.current?.focus();
  }, [query, search.data?.total]);

  const hits = search.data?.hits ?? [];
  const readerLocale = tree.data?.locale ?? 'en';
  const startHere = (tree.data?.sections.find((section) => section.key === 'getting-started')?.pages ?? []).slice(0, 3);
  const supportEmail = settings.data?.value.supportEmail ?? null;

  return (
    <DocsLayout>
      <div className="carocrm-doc-search-head">
        <Typography.Title level={1} className="carocrm-doc-search-title">
          {t('web.docs.searchTitle')}
        </Typography.Title>
        <DocSearchInput
          value={query}
          placeholder={t('web.docs.searchPlaceholder')}
          ariaLabel={t('web.docs.searchAria')}
          submitLabel={t('web.docs.searchSubmitHint')}
          onChange={(next) => writeQuery(next, true)}
          onSubmit={(next) => writeQuery(next, false)}
        />
      </div>

      {search.isPending && query !== '' ? <LoadingSkeleton rows={5} /> : null}
      {search.isError ? (
        <ErrorState message={search.error instanceof Error ? search.error.message : t('web.docs.loadFailed')} onRetry={() => void search.refetch()} />
      ) : null}

      {search.data !== undefined ? (
        <>
          <h2 ref={resultsRef} tabIndex={-1} className="carocrm-doc-results-head">
            {query === '' ? t('web.docs.searchPrompt') : t('web.docs.resultsCount', { count: search.data.total, query })}
          </h2>

          {query !== '' && hits.length === 0 ? (
            <div className="carocrm-doc-noresults">
              <Typography.Paragraph>{t('web.docs.noResults', { query })}</Typography.Paragraph>
              {startHere.length > 0 ? (
                <>
                  <Typography.Paragraph className="carocrm-doc-noresults-label">{t('web.docs.startHere')}</Typography.Paragraph>
                  <ul className="carocrm-doc-linklist">
                    {startHere.map((page) => (
                      <li key={page.key}>
                        <Link to={page.path}>{page.title}</Link>
                        <span className="carocrm-doc-start-summary">{page.summary}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {supportEmail !== null ? (
                <Typography.Paragraph>
                  <a href={`mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(t('web.docs.supportSubject'))}`}>
                    {t('web.docs.askAdministrator')}
                  </a>
                </Typography.Paragraph>
              ) : null}
            </div>
          ) : (
            <ul className="carocrm-doc-results">
              {hits.map((hit) => (
                <li key={`${hit.key}-${String(hit.locale)}`}>
                  <Link to={hit.path} className="carocrm-doc-result">
                    <span className="carocrm-doc-result-title">
                      {hit.title}
                      {hit.locale !== readerLocale ? <Tag className="carocrm-doc-result-locale">{hit.locale}</Tag> : null}
                    </span>
                    <span className="carocrm-doc-result-section">{hit.section}</span>
                    <Snippet hit={hit} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </DocsLayout>
  );
}

function Snippet({ hit }: { readonly hit: DocSearchHit }) {
  const { text, ranges } = hit.snippet;
  if (text === '') return null;
  return (
    <span className="carocrm-doc-result-snippet">
      {highlight(text, ranges)}
    </span>
  );
}

/** The server gave offsets, not HTML: the marks are built here, from slices of the snippet text. */
function highlight(text: string, ranges: readonly (readonly [number, number])[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([from, to], index) => {
    if (from < cursor || to <= from) return;
    if (from > cursor) out.push(text.slice(cursor, from));
    out.push(<mark key={`mark-${String(index)}`}>{text.slice(from, to)}</mark>);
    cursor = to;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
