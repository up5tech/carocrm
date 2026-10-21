import { ExportOutlined } from '@ant-design/icons';
// Imported from the links module, not the package barrel: the barrel also exports the index builder,
// which uses `node:crypto` and cannot be bundled for a browser. The link semantics stay the
// engine's own, so the SPA cannot render a link the content lint refused.
import { classifyHref, docLinkPath, resolveDocLink } from '@carocrm/docs/links.js';
import { Link } from 'react-router-dom';

import type { DocInline as DocInlineModel } from '../../api/types.js';
import { t } from '../../state/i18n.js';

/**
 * One inline run of a documentation page.
 *
 * There is no HTML anywhere near this component: the API returns a typed block tree and every construct
 * becomes a real React element, which is how the product keeps its "no `dangerouslySetInnerHTML`" property
 * (§9.5). Link classification is the engine's own `classifyHref`/`resolveDocLink`, so the SPA cannot render
 * a link the content lint refused.
 */
export interface DocLinkContext {
  /** Every page key this reader may reach, from the server-filtered tree. */
  readonly pageKeys: ReadonlySet<string>;
  /** The section the current page lives in, needed to resolve a bare sibling link. */
  readonly section: string;
  readonly onAnchor: (id: string) => void;
}

export function DocInline({ inline, context }: { readonly inline: DocInlineModel; readonly context: DocLinkContext }) {
  switch (inline.type) {
    case 'text':
      return <>{inline.text}</>;
    case 'strong':
      return <strong>{inline.text}</strong>;
    case 'em':
      return <em>{inline.text}</em>;
    case 'code':
      return <code className="carocrm-doc-code">{inline.text}</code>;
    case 'link':
      return <DocLink href={inline.href} text={inline.text} context={context} />;
    default: {
      const exhaustive: never = inline;
      return <>{String((exhaustive as { text?: unknown }).text ?? '')}</>;
    }
  }
}

function DocLink({ href, text, context }: { readonly href: string; readonly text: string; readonly context: DocLinkContext }) {
  const kind = classifyHref(href);

  if (kind === 'anchor') {
    const id = href.slice(1);
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          context.onAnchor(id);
        }}
      >
        {text}
      </a>
    );
  }

  if (kind === 'app') return <Link to={href}>{text}</Link>;

  if (kind === 'external') {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {text}
        <ExportOutlined className="carocrm-doc-ext-icon" aria-hidden />
        <span className="carocrm-visually-hidden">{t('web.docs.externalSuffix')}</span>
      </a>
    );
  }

  if (kind !== 'doc') return <>{text}</>;

  const key = resolveDocLink(href, context.section);
  if (key === null || !context.pageKeys.has(key)) {
    // A stale bookmark or a page the reader may not open: say so in place instead of navigating to a 404
    // that looks like the handbook is broken (§9.2 rule 5).
    return <span className="carocrm-doc-deadlink">{t('web.docs.brokenLink', { key: key ?? href })}</span>;
  }
  return <Link to={docLinkPath(key)}>{text}</Link>;
}

export function DocInlines({ inlines, context }: { readonly inlines: readonly DocInlineModel[]; readonly context: DocLinkContext }) {
  return (
    <>
      {inlines.map((inline, index) => (
        <DocInline key={`${inline.type}-${String(index)}`} inline={inline} context={context} />
      ))}
    </>
  );
}
