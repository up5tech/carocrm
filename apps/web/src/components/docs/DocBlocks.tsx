import type { DocBlock } from '../../api/types.js';
import { DocCallout } from './DocCallout.js';
import { DocInlines, type DocLinkContext } from './DocInline.js';
import { DocTable } from './DocTable.js';

/**
 * The block renderer: a switch over `DocBlock['type']` and nothing else (§9.5).
 *
 * Every construct the parser can produce has a case here, and the exhaustive check at the bottom is what
 * makes that true — adding a block type to the engine without adding it here is a compile error rather than
 * a page that silently drops content. There is no HTML injection path in this file.
 */
export function DocBlocks({ blocks, context }: { readonly blocks: readonly DocBlock[]; readonly context: DocLinkContext }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={`${block.type}-${String(index)}`} block={block} context={context} />
      ))}
    </>
  );
}

function Block({ block, context }: { readonly block: DocBlock; readonly context: DocLinkContext }) {
  switch (block.type) {
    case 'heading': {
      const content = <>{block.text}</>;
      // The `id` is the engine's, derived from the same text as the table of contents, and the tab index
      // is what lets an anchor link move focus here (§5.9).
      if (block.level === 2) return <h2 id={block.id} tabIndex={-1}>{content}</h2>;
      if (block.level === 3) return <h3 id={block.id} tabIndex={-1}>{content}</h3>;
      return <h4 id={block.id} tabIndex={-1}>{content}</h4>;
    }
    case 'paragraph':
      return <p><DocInlines inlines={block.inlines} context={context} /></p>;
    case 'list':
      return <DocList ordered={block.ordered} items={block.items} context={context} />;
    case 'code':
      return (
        <pre className="carocrm-doc-pre">
          <code>{block.code}</code>
        </pre>
      );
    case 'callout':
      return (
        <DocCallout variant={block.variant}>
          <DocBlocks blocks={block.blocks} context={context} />
        </DocCallout>
      );
    case 'table':
      return <DocTable align={block.align} head={block.head} rows={block.rows} context={context} />;
    case 'image':
      return (
        <figure className="carocrm-doc-figure">
          <img src={block.src} alt={block.alt} loading="lazy" />
          {block.caption !== null ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    case 'divider':
      return <hr className="carocrm-doc-rule" />;
    default: {
      const exhaustive: never = block;
      return <div data-unknown-block={String((exhaustive as { type?: unknown }).type ?? '')} />;
    }
  }
}

function DocList({
  ordered,
  items,
  context,
}: {
  readonly ordered: boolean;
  readonly items: readonly (readonly DocBlock[])[];
  readonly context: DocLinkContext;
}) {
  const rows = items.map((item, index) => (
    <li key={`item-${String(index)}`}>
      {/* A list item is a block list: its first paragraph is the item text, and a nested list follows. */}
      {item.map((block, blockIndex) =>
        block.type === 'paragraph' && blockIndex === 0 ? (
          <DocInlines key={`p-${String(blockIndex)}`} inlines={block.inlines} context={context} />
        ) : (
          <Block key={`${block.type}-${String(blockIndex)}`} block={block} context={context} />
        ),
      )}
    </li>
  ));
  return ordered ? <ol>{rows}</ol> : <ul>{rows}</ul>;
}
