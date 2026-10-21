/**
 * The Markdown subset → `DocBlock[]` parser (`PLAN_Phase_21_Documentation.md` §4.3).
 *
 * It is a *total* parser: every input produces blocks, and anything outside the documented subset
 * produces a block that is safe plus an `issue` that the lint turns into a build failure. That split
 * matters. A page is never allowed to render markup the product did not choose — raw HTML becomes text,
 * an unknown callout becomes a paragraph — and a corpus is never allowed to ship that silent degradation
 * — the issue is reported. One half protects the reader, the other protects the author.
 *
 * No Markdown library is used, for the same reason the block model exists: they emit HTML, and they
 * cannot be told to refuse constructs this product does not support.
 */

import { classifyHref } from './links.js';
import { headingId } from './slug.js';
import type { DocBlock, DocCalloutVariant, DocInline, ParserIssueCode } from './types.js';

export type { ParserIssueCode };

export interface ParserIssue {
  readonly code: ParserIssueCode;
  readonly message: string;
  /** 1-based line in the page body (front-matter already stripped). */
  readonly line: number;
}

export interface ParsedMarkdown {
  readonly blocks: readonly DocBlock[];
  readonly issues: readonly ParserIssue[];
}

const FENCE = /^```([a-zA-Z0-9+#-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const DIVIDER = /^(-{3,}|\*{3,})$/;
const UNORDERED = /^(\s*)[-*]\s+(.*)$/;
const ORDERED = /^(\s*)\d+\.\s+(.*)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;
const TABLE_SEPARATOR = /^\|?[\s:|-]+\|?$/;
const STANDALONE_IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?>/;
const CALLOUT_MARKER = /^\[!(\w+)\]\s*$/;

const CALLOUT_VARIANTS: Readonly<Record<string, DocCalloutVariant>> = {
  note: 'note',
  tip: 'tip',
  warning: 'warning',
  danger: 'danger',
};

/** Parses one page body. Never throws; a page it cannot make sense of becomes text plus issues. */
export function parseMarkdown(body: string): ParsedMarkdown {
  const lines = (body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).split('\n');
  const issues: ParserIssue[] = [];
  const usedHeadingIds = new Set<string>();
  const blocks: DocBlock[] = [];
  let index = 0;

  const report = (code: ParserIssueCode, line: number, message: string): void => {
    issues.push({ code, line, message });
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line.trim());
    if (fence !== null) {
      const language = fence[1] === '' ? null : (fence[1] ?? null);
      const collected: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trim() === '```') {
          closed = true;
          index += 1;
          break;
        }
        collected.push(current);
        index += 1;
      }
      if (!closed) report('unclosedFence', index, 'a ``` fence is never closed');
      blocks.push({ type: 'code', language, code: collected.join('\n') });
      continue;
    }

    if (DIVIDER.test(line.trim())) {
      blocks.push({ type: 'divider' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const text = plainInlineText(heading[2] ?? '', report, index + 1);
      if (level === 1) report('h1Reserved', index + 1, '`#` is reserved for the front-matter title; use `##`');
      else if (level >= 5) report('headingTooDeep', index + 1, `a level-${String(level)} heading is not supported; use \`####\` at most`);
      if (level >= 2 && level <= 4) {
        blocks.push({ type: 'heading', level: level as 2 | 3 | 4, id: headingId(text, usedHeadingIds), text });
      } else {
        blocks.push({ type: 'paragraph', inlines: [{ type: 'text', text: line }] });
      }
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const collected: string[] = [];
      while (index < lines.length) {
        const match = BLOCKQUOTE.exec(lines[index] ?? '');
        if (match === null) break;
        collected.push(match[1] ?? '');
        index += 1;
      }
      const marker = CALLOUT_MARKER.exec(collected[0]?.trim() ?? '');
      if (marker === null) {
        report('blockquoteNotCallout', index, 'a blockquote must open with `> [!NOTE]`, `[!TIP]`, `[!WARNING]` or `[!DANGER]`');
        blocks.push(...parseBodyLines(collected, report));
      } else {
        const variant = CALLOUT_VARIANTS[(marker[1] ?? '').toLowerCase()];
        if (variant === undefined) {
          report('unknownCallout', index, `callout type [!${String(marker[1] ?? '')}] does not exist`);
          blocks.push(...parseBodyLines(collected, report));
        } else {
          const inner = parseMarkdown(collected.slice(1).join('\n'));
          issues.push(...inner.issues);
          blocks.push({ type: 'callout', variant, blocks: inner.blocks });
        }
      }
      continue;
    }

    const image = STANDALONE_IMAGE.exec(line.trim());
    if (image !== null) {
      blocks.push(imageBlock(image[1] ?? '', image[2] ?? '', image[3] ?? null, index + 1, report));
      index += 1;
      continue;
    }

    if (isTableRow(line) && TABLE_SEPARATOR.test((lines[index + 1] ?? '').trim()) && (lines[index + 1] ?? '').includes('-')) {
      const head = splitRow(line);
      const align = separatorAlignments(splitRow(lines[index + 1] ?? ''));
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({
        type: 'table',
        align,
        head: head.map((cell) => parseInlines(cell, report, index)),
        rows: rows.map((row) => {
          if (row.length !== head.length) report('tableRowWidth', index, `row has ${String(row.length)} cells, the header has ${String(head.length)}`);
          const cells = [...row];
          while (cells.length < head.length) cells.push('');
          return cells.slice(0, head.length).map((cell) => parseInlines(cell, report, index));
        }),
      });
      continue;
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const items: { readonly indent: number; readonly ordered: boolean; readonly text: string }[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trim() === '') {
          // A blank line only ends the list when the next line is not another item or a continuation.
          const next = lines[index + 1] ?? '';
          if (!UNORDERED.test(next) && !ORDERED.test(next) && !isContinuation(next)) break;
          index += 1;
          continue;
        }
        const unordered = UNORDERED.exec(current);
        const ordered = ORDERED.exec(current);
        if (unordered !== null) {
          items.push({ indent: (unordered[1] ?? '').length, ordered: false, text: unordered[2] ?? '' });
        } else if (ordered !== null) {
          items.push({ indent: (ordered[1] ?? '').length, ordered: true, text: ordered[2] ?? '' });
        } else if (isContinuation(current) && items.length > 0) {
          const last = items[items.length - 1];
          if (last !== undefined) items[items.length - 1] = { ...last, text: `${last.text} ${current.trim()}` };
        } else {
          break;
        }
        index += 1;
      }
      blocks.push(listBlock(items, report, index));
      continue;
    }

    // Paragraph: consecutive lines that do not open another block.
    const collected: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || startsBlock(current)) break;
      collected.push(current);
      index += 1;
    }
    const text = collected.join(' ');
    if (STANDALONE_IMAGE.test(text.trim())) report('imageNotAlone', index - collected.length, 'an image must be on a line of its own');
    blocks.push({ type: 'paragraph', inlines: parseInlines(text, report, index - collected.length) });
  }

  return { blocks, issues };
}

function startsBlock(line: string): boolean {
  const trimmed = line.trim();
  return (
    FENCE.test(trimmed) ||
    DIVIDER.test(trimmed) ||
    HEADING.test(line) ||
    BLOCKQUOTE.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    STANDALONE_IMAGE.test(trimmed)
  );
}

function isContinuation(line: string): boolean {
  return line !== '' && /^\s+\S/.test(line) && !startsBlock(line);
}

/** Turns the plain lines inside a refused blockquote back into blocks, minus the `>` markers. */
function parseBodyLines(lines: readonly string[], report: (code: ParserIssueCode, line: number, message: string) => void): DocBlock[] {
  const inner = parseMarkdown(lines.join('\n'));
  for (const issue of inner.issues) report(issue.code, issue.line, issue.message);
  return [...inner.blocks];
}

function isTableRow(line: string): boolean {
  return line.trim().includes('|');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/g)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function separatorAlignments(cells: readonly string[]): ('left' | 'center' | 'right' | null)[] {
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function listBlock(
  items: readonly { readonly indent: number; readonly ordered: boolean; readonly text: string }[],
  report: (code: ParserIssueCode, line: number, message: string) => void,
  line: number,
): DocBlock {
  const tooDeep = items.filter((item) => item.indent >= 4);
  if (tooDeep.length > 0) report('listTooDeep', line, `a list may nest two levels; ${String(tooDeep.length)} item(s) are deeper and were pulled up`);

  const paragraph = (text: string): DocBlock => ({ type: 'paragraph', inlines: parseInlines(text, report, line) });

  interface Draft {
    readonly ordered: boolean;
    readonly text: string;
    readonly children: { readonly ordered: boolean; readonly text: string }[];
  }
  const top: Draft[] = [];
  for (const item of items) {
    if (item.indent === 0 || top.length === 0) {
      top.push({ ordered: item.ordered, text: item.text, children: [] });
      continue;
    }
    top[top.length - 1]?.children.push({ ordered: item.ordered, text: item.text });
  }

  return {
    type: 'list',
    ordered: top[0]?.ordered ?? false,
    items: top.map((entry) => {
      const blocks: DocBlock[] = [paragraph(entry.text)];
      if (entry.children.length > 0) {
        blocks.push({
          type: 'list',
          ordered: entry.children[0]?.ordered ?? false,
          items: entry.children.map((child) => [paragraph(child.text)]),
        });
      }
      return blocks;
    }),
  };
}

function imageBlock(alt: string, src: string, caption: string | null, line: number, report: (code: ParserIssueCode, line: number, message: string) => void): DocBlock {
  if (alt.trim() === '') report('missingAlt', line, 'every image needs alt text; a decorative image is not allowed in a handbook page');
  if (!src.startsWith('/docs-assets/')) report('assetNotLocal', line, `${src} must live under /docs-assets/`);
  return { type: 'image', src, alt, caption };
}

/**
 * The inline scanner. Emphasis is one level deep and its content is plain text, which is what the
 * contract allows and what keeps this function a loop rather than a recursive-descent parser.
 */
export function parseInlines(text: string, report: (code: ParserIssueCode, line: number, message: string) => void = () => {}, line = 0): DocInline[] {
  const out: DocInline[] = [];
  let rest = text;
  let offset = 0;

  const push = (value: string): void => {
    if (value !== '') out.push({ type: 'text', text: value });
  };

  while (rest !== '') {
    const next = nextMarker(rest);
    if (next === null) {
      pushHtmlChecked(rest, push, report, line + offset);
      break;
    }
    const [marker, at] = next;
    pushHtmlChecked(rest.slice(0, at), push, report, line + offset);
    offset += at;
    rest = rest.slice(at);

    if (marker === '`') {
      const close = rest.indexOf('`', 1);
      if (close === -1) {
        report('unclosedInline', line + offset, 'an inline code span is not closed');
        push(rest);
        break;
      }
      out.push({ type: 'code', text: rest.slice(1, close) });
      rest = rest.slice(close + 1);
      continue;
    }

    if (marker === '*') {
      if (rest.startsWith('**')) {
        const close = rest.indexOf('**', 2);
        if (close === -1) {
          report('unclosedInline', line + offset, '`**` is never closed');
          push(rest);
          break;
        }
        out.push({ type: 'strong', text: stripInlineMarkers(rest.slice(2, close)) });
        rest = rest.slice(close + 2);
        continue;
      }
      const close = rest.indexOf('*', 1);
      if (close === -1) {
        report('unclosedInline', line + offset, '`*` emphasis is never closed');
        push(rest);
        break;
      }
      out.push({ type: 'em', text: stripInlineMarkers(rest.slice(1, close)) });
      rest = rest.slice(close + 1);
      continue;
    }

    // `[text](href)` or a stray `[` / `![`, which is literal text. A link title is not in the subset.
    const link = /^(!?)\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
    if (link === null) {
      push(rest.slice(0, 1));
      rest = rest.slice(1);
      continue;
    }
    const matched = link[0] ?? '';
    const bang = link[1] ?? '';
    const label = link[2] ?? '';
    const href = link[3] ?? '';
    if (bang === '!') {
      report('imageNotAlone', line + offset, 'an image must be on a line of its own');
      push(matched);
      rest = rest.slice(matched.length);
      continue;
    }
    const kind = classifyHref(href);
    if (kind === 'invalid') {
      report('unsafeHref', line + offset, `${href} is not a documentation page, an app route or an https:// URL`);
      push(label === '' ? href : label);
      rest = rest.slice(matched.length);
      continue;
    }
    out.push({ type: 'link', text: stripInlineMarkers(label), href, internal: kind !== 'external' });
    rest = rest.slice(matched.length);
  }

  return mergeText(out.length > 0 ? out : [{ type: 'text', text: '' }]);
}

/** Keeps the inline list tight: the renderer does not need three adjacent text nodes in a row. */
function mergeText(inlines: readonly DocInline[]): DocInline[] {
  const out: DocInline[] = [];
  for (const inline of inlines) {
    const last = out[out.length - 1];
    if (last !== undefined && last.type === 'text' && inline.type === 'text') {
      out[out.length - 1] = { type: 'text', text: `${last.text}${inline.text}` };
    } else {
      out.push(inline);
    }
  }
  return out;
}

function nextMarker(text: string): readonly [string, number] | null {
  const candidates = ['`', '*', '[', '!'] as const;
  let best: readonly [string, number] | null = null;
  for (const marker of candidates) {
    const at = text.indexOf(marker);
    if (at !== -1 && (best === null || at < best[1])) best = [marker, at] as const;
  }
  return best;
}

function pushHtmlChecked(
  value: string,
  push: (value: string) => void,
  report: (code: ParserIssueCode, line: number, message: string) => void,
  line: number,
): void {
  if (HTML_TAG.test(value)) report('rawHtml', line, 'raw HTML is not part of the supported subset; it is rendered as text');
  push(value);
}

/** A heading's text: emphasis and links collapse to what the reader would see spoken aloud. */
function plainInlineText(
  text: string,
  report: (code: ParserIssueCode, line: number, message: string) => void,
  line: number,
): string {
  return parseInlines(text, report, line)
    .map((inline) => (inline.type === 'link' ? inline.text : inline.text))
    .join('')
    .trim();
}

function stripInlineMarkers(value: string): string {
  return value.replace(/[*`]/g, '');
}
