/**
 * Search: normalization, the inverted index, ranking and the snippet.
 *
 * The one thing that has to be right is the length-preserving normalisation. A result is shown with
 * `<mark>` over the matched words, and the API returns highlight `ranges` rather than markup, so the
 * offsets the index produces must be valid in the text the reader sees. `normalizeForSearch` therefore
 * replaces each character it does not keep with exactly one space — collapsing runs would shift every
 * offset after the first non-alphanumeric character and put the highlight on the wrong word.
 *
 * Vietnamese is the reason this exists at all: a reader types `cau hinh` into a search box and expects
 * the page that says `Cấu hình`.
 */

import { stripDiacritics } from './slug.js';
import type { DocBlock, DocInline, DocPage, DocSearchHit, DocSearchResult, DocsIndex, DocSnippet, Posting } from './types.js';

const FIELD_WEIGHTS: Record<Posting['field'], number> = { title: 8, heading: 4, tag: 3, summary: 2, body: 1 };
/** A query that appears as one phrase is worth more than the same words scattered over a page. */
const PHRASE_BONUS = 16;
const SNIPPET_RADIUS = 72;
const MIN_TOKEN_LENGTH = 2;

/** Lowercase, diacritic-free, one space per character that is not kept. Same length as the input. */
export function normalizeForSearch(text: string): string {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ');
}

export interface Term {
  readonly token: string;
  readonly start: number;
}

export function tokenize(normalized: string): readonly Term[] {
  const terms: Term[] = [];
  const pattern = /[a-z0-9]+/g;
  let match: RegExpExecArray | null = pattern.exec(normalized);
  while (match !== null) {
    if (match[0].length >= MIN_TOKEN_LENGTH) terms.push({ token: match[0], start: match.index });
    match = pattern.exec(normalized);
  }
  return terms;
}

/** The text a page is searched over: body blocks only — titles, tags and headings are indexed apart. */
export function blocksToPlainText(blocks: readonly DocBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        parts.push(block.text);
        break;
      case 'paragraph':
        parts.push(inlinesToText(block.inlines));
        break;
      case 'list':
        for (const item of block.items) parts.push(blocksToPlainText(item));
        break;
      case 'code':
        parts.push(block.code);
        break;
      case 'callout':
        parts.push(blocksToPlainText(block.blocks));
        break;
      case 'table':
        parts.push(...block.head.map(inlinesToText));
        for (const row of block.rows) parts.push(...row.map(inlinesToText));
        break;
      case 'image':
        parts.push(block.alt, block.caption ?? '');
        break;
      case 'divider':
        break;
      default: {
        const exhaustive: never = block;
        parts.push(String((exhaustive as { type?: unknown }).type ?? ''));
      }
    }
  }
  return parts.filter((part) => part !== '').join('\n');
}

function inlinesToText(inlines: readonly DocInline[]): string {
  return inlines.map((inline) => inline.text).join('');
}

/** Fields as they are indexed for one page. */
function fieldsOf(page: DocPage, body: string): Record<Posting['field'], string> {
  const headings = page.blocks.filter((block) => block.type === 'heading').map((block) => (block.type === 'heading' ? block.text : ''));
  return { title: page.title, summary: page.summary, heading: headings.join('\n'), tag: page.tags.join(' '), body };
}

/** Builds the inverted map: normalized token → the postings that contain it. */
export function buildTokens(pages: readonly DocPage[], plainText: ReadonlyMap<string, string>): Map<string, Posting[]> {
  const tokens = new Map<string, Posting[]>();
  for (const page of pages) {
    const fields = fieldsOf(page, plainText.get(page.key) ?? '');
    for (const [field, text] of Object.entries(fields)) {
      const positions = new Map<string, number[]>();
      for (const term of tokenize(normalizeForSearch(text))) {
        positions.set(term.token, [...(positions.get(term.token) ?? []), term.start]);
      }
      for (const [token, at] of positions) {
        const postings = tokens.get(token) ?? [];
        postings.push({ key: page.key, field: field as Posting['field'], positions: at });
        tokens.set(token, postings);
      }
    }
  }
  return tokens;
}

export interface SearchOptions {
  readonly limit?: number;
}

/**
 * Ranks pages for a query. Every term is looked up in the index, a page's score is the weighted count
 * of its hits, and a page that contains the whole phrase is pushed up. Ties break on the key so two
 * runs of the same corpus answer identically.
 */
export function searchIndex(index: DocsIndex, query: string, options: SearchOptions = {}): DocSearchResult {
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const normalizedQuery = normalizeForSearch(query);
  const terms = tokenize(normalizedQuery);
  const scores = new Map<string, number>();

  for (const term of terms) {
    for (const posting of index.tokens.get(term.token) ?? []) {
      const weight = FIELD_WEIGHTS[posting.field] * Math.min(posting.positions.length, 3);
      scores.set(posting.key, (scores.get(posting.key) ?? 0) + weight);
    }
  }

  const phrase = terms.length > 1 ? normalizedQuery.replace(/\s+/g, ' ').trim() : '';
  const hits: DocSearchHit[] = [];
  for (const [key, base] of scores) {
    const page = index.pages.get(key);
    if (page === undefined) continue;
    const body = index.plainText.get(key) ?? '';
    const normalizedBody = normalizeForSearch(body);
    const titleMatch = normalizeForSearch(page.title);
    const score = base + (phrase !== '' && (normalizedBody.includes(phrase) || titleMatch.includes(phrase)) ? PHRASE_BONUS : 0);
    hits.push({
      key,
      path: page.path,
      title: page.title,
      section: page.section,
      audience: page.audience,
      locale: page.locale,
      score,
      snippet: snippetFor(body, terms),
    });
  }

  hits.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  const limited = hits.slice(0, limit);
  return { query, locale: index.locale, total: limited.length, hits: limited };
}

/**
 * A window of the page's own text around its earliest match, plus the offsets of every match inside
 * that window. Offsets come from the tokenized body rather than a substring scan, so a term highlights
 * whole words and never lands in the middle of a longer one.
 */
export function snippetFor(body: string, terms: readonly Term[]): DocSnippet {
  const wanted = new Set(terms.map((term) => term.token));
  const matches = tokenize(normalizeForSearch(body)).filter((term) => wanted.has(term.token));
  if (matches.length === 0) return { text: cut(body, 0, Math.min(body.length, SNIPPET_RADIUS * 2), true), ranges: [] };

  const first = matches[0]?.start ?? 0;
  const from = expandLeft(body, Math.max(0, first - SNIPPET_RADIUS));
  const to = expandRight(body, Math.min(body.length, first + SNIPPET_RADIUS));
  const text = cut(body, from, to, false);
  const leading = body.slice(from, from + (body.slice(from).match(/^\s*/) ?? [''])[0].length).length;
  const shift = (at: number): number => at - from + leading + (from > 0 ? 1 : 0);

  const ranges = matches
    .filter((match) => match.start >= from && match.start < to)
    .map((match) => [shift(match.start), shift(match.start) + match.token.length] as [number, number]);

  return { text, ranges: clampRanges(ranges, text.length) };
}

/** The snippet text for a span: trimmed inside, ellipsised where it was cut. */
function cut(body: string, from: number, to: number, forceSuffix: boolean): string {
  const trimmed = body.slice(from, to).trim();
  const prefix = from > 0 ? '…' : '';
  const suffix = to < body.length || forceSuffix ? '…' : '';
  return `${prefix}${trimmed}${suffix}`;
}

function expandLeft(body: string, at: number): number {
  const space = body.lastIndexOf(' ', at);
  return space > 0 ? space + 1 : at;
}

function expandRight(body: string, at: number): number {
  const space = body.indexOf(' ', at);
  return space === -1 ? at : space;
}

function clampRanges(ranges: readonly (readonly [number, number])[], length: number): [number, number][] {
  return ranges
    .filter(([from, to]) => from >= 0 && to > from)
    .map(([from, to]) => [from, Math.min(to, length)] as [number, number])
    .sort((left, right) => left[0] - right[0])
    .reduce<[number, number][]>((acc, range) => {
      const last = acc[acc.length - 1];
      if (last !== undefined && range[0] <= last[1]) acc[acc.length - 1] = [last[0], Math.max(last[1], range[1])];
      else acc.push(range);
      return acc;
    }, []);
}
