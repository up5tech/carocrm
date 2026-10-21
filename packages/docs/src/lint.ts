/**
 * The content contract as a pure function: corpus in, `{ errors, warnings, stats }` out.
 *
 * This is the test that makes "we shipped a feature without its page" visible (§13.3), so it is
 * deliberately stricter than the index builder. The builder has to keep serving documentation when one
 * page is broken — a typo must not take the handbook down for a reader. The lint has no readers to
 * protect, only authors to warn, so everything it dislikes is an error and the build fails.
 *
 * Every rule in `PLAN_Phase_21_Documentation.md` §11 is here, and each one is exercised by a fixture
 * that violates exactly it, so a rule cannot rot into a no-op without a test noticing.
 */

import { buildIndex } from './index-builder.js';
import { type AppRouteOptions,redirectProblems, resolveDocLink, validateAppRoute } from './links.js';
import type { ContentFile, DocBlock, DocInline, DocPage, DocRedirects, LintIssue, LintReport, LintStats } from './types.js';

const DEFAULT_MAX_PAGE_BYTES = 256 * 1024;
const ASSET_PREFIX = '/docs-assets/';

/** A credential in a handbook page ships to every instance; these are the shapes one takes. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/,
  /\b[0-9a-f]{32,}\b/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** An email address is only refused inside a code block, where a support address would hide a real one. */
const EMAIL_IN_CODE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

export interface LintOptions {
  /** App-route allowlist and the live entity names, supplied by the caller that knows the app. */
  readonly routes?: AppRouteOptions;
  /** File names that exist under `apps/web/public/docs-assets/`. */
  readonly assets?: readonly string[];
  /** `content/docs/redirects.json`. */
  readonly redirects?: DocRedirects;
  /** Every `docKey` the admin-tab catalog publishes; each must resolve to a page. */
  readonly tabDocKeys?: readonly string[];
  readonly maxPageBytes?: number;
}

export function lintContent(files: readonly ContentFile[], options: LintOptions = {}): LintReport {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const locales = ['en', 'vi'].filter((locale) => files.some((file) => file.path.includes(`/docs/${locale}/`)));
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const indexes = new Map(locales.map((locale) => [locale, buildIndex(files, { locale })]));
  const english = indexes.get('en');
  const referencedAssets = new Set<string>();

  for (const locale of locales) {
    const index = indexes.get(locale);
    if (index === undefined) continue;

    for (const issue of index.warnings) {
      const message = `[${locale}] ${issue.message}`;
      const lintIssue: LintIssue = { code: issue.code, message, path: issue.path, key: issue.key };
      // A translation is allowed to be partial: its sections and page list come from `en`, so a missing
      // `vi` section descriptor is a gap in coverage, not a broken build.
      const informational = issue.code === 'pageMissingInEnglish' || (locale !== 'en' && issue.code === 'missingSectionIndex');
      if (informational) warnings.push(lintIssue);
      else errors.push(lintIssue);
    }

    for (const section of index.sections) {
      for (const order of duplicatedOrders(section.pages.map((page) => page.order))) {
        errors.push({ code: 'duplicateOrder', message: `[${locale}] order ${String(order)} is used twice in section ${section.key}`, path: null, key: section.key });
      }
    }

    for (const page of index.pages.values()) {
      if (page.fallback) {
        warnings.push({ code: 'pageNotTranslated', message: `[${locale}] ${page.key} is not translated; the English page is served with a notice`, path: page.path, key: page.key });
      }
      if (bytesOf(page.blocks) > maxPageBytes) {
        errors.push({ code: 'pageTooLarge', message: `[${locale}] ${page.key} is larger than ${String(maxPageBytes)} bytes`, path: page.path, key: page.key });
      }
      checkHeadings(page, locale, errors);
      checkSecrets(page, locale, errors);
      for (const block of flatten(page.blocks)) {
        if (block.type === 'image' && block.src.startsWith(ASSET_PREFIX)) referencedAssets.add(block.src.slice(ASSET_PREFIX.length));
        if (block.type !== 'paragraph') continue;
        for (const inline of block.inlines) {
          if (inline.type === 'link') checkLink(inline, page, index, options, locale, errors);
        }
      }
    }
  }

  if (english !== undefined && english.pages.size === 0) {
    errors.push({ code: 'frontMatterInvalid', message: 'the English corpus has no usable page', path: 'content/docs/en', key: null });
  }

  for (const problem of redirectProblems(options.redirects ?? {}, new Set(english?.pages.keys() ?? []))) {
    errors.push({ code: 'redirectProblem', message: `${problem.source} → ${problem.target}: ${problem.message}`, path: 'content/docs/redirects.json', key: problem.source });
  }

  for (const docKey of options.tabDocKeys ?? []) {
    if (![...indexes.values()].some((index) => index.pages.has(docKey))) {
      errors.push({ code: 'unknownDocKey', message: `an admin tab publishes docKey ${docKey}, which is not a page`, path: null, key: docKey });
    }
  }

  const knownAssets = options.assets;
  if (knownAssets !== undefined) {
    for (const asset of knownAssets) {
      if (!referencedAssets.has(asset)) errors.push({ code: 'orphanAsset', message: `${asset} is shipped but no page references it`, path: `${ASSET_PREFIX}${asset}`, key: null });
    }
    for (const asset of referencedAssets) {
      if (!knownAssets.includes(asset)) errors.push({ code: 'missingAsset', message: `a page references ${ASSET_PREFIX}${asset}, which does not exist`, path: `${ASSET_PREFIX}${asset}`, key: null });
    }
  }

  return { errors, warnings, stats: statsOf(files, locales, indexes, knownAssets?.length ?? referencedAssets.size) };
}

function statsOf(files: readonly ContentFile[], locales: readonly string[], indexes: Map<string, ReturnType<typeof buildIndex>>, assets: number): LintStats {
  /** Coverage counts *translated* pages: a fallback page is English text, not `vi` progress. */
  const translated = (locale: string): number => {
    const index = indexes.get(locale);
    if (index === undefined) return 0;
    return [...index.pages.values()].filter((page) => !page.fallback).length;
  };
  const englishSize = translated('en');
  const pagesByLocale: Record<string, number> = {};
  const coverage: Record<string, number> = {};
  for (const locale of locales) {
    const size = translated(locale);
    pagesByLocale[locale] = size;
    coverage[locale] = englishSize === 0 ? 0 : size / englishSize;
  }
  return { files: files.length, pagesByLocale, sections: indexes.get('en')?.sections.length ?? 0, assets, coverage };
}

function duplicatedOrders(orders: readonly number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const order of orders) {
    if (seen.has(order)) duplicates.add(order);
    seen.add(order);
  }
  return [...duplicates];
}

/**
 * `#` is the front-matter title, so the body starts at `##` and may not jump a level on the way down.
 * A skipped level is a broken outline for a screen-reader user and is invisible on paper, which is
 * exactly the defect a human review misses (§5.9).
 */
function checkHeadings(page: DocPage, locale: string, errors: LintIssue[]): void {
  let previous = 2;
  for (const block of page.blocks) {
    if (block.type !== 'heading') continue;
    if (block.level > previous + 1) {
      errors.push({
        code: 'headingLevelSkipped',
        message: `[${locale}] ${page.key} jumps from h${String(previous)} to h${String(block.level)} at "${block.text}"`,
        path: page.path,
        key: page.key,
      });
    }
    previous = block.level;
  }
}

/** Only code blocks are scanned for an email address: a page may legitimately name its support inbox. */
function checkSecrets(page: DocPage, locale: string, errors: LintIssue[]): void {
  const code = page.blocks.filter((block) => block.type === 'code').map((block) => (block.type === 'code' ? block.code : ''));
  const haystacks: readonly (readonly [string, string])[] = [
    ['prose', [page.title, page.summary, page.blocks.map(plainTextOf).join('\n')].join('\n')],
    ['code block', code.join('\n')],
  ];
  for (const [where, text] of haystacks) {
    for (const pattern of where === 'code block' ? [...SECRET_PATTERNS, EMAIL_IN_CODE] : SECRET_PATTERNS) {
      const found = pattern.exec(text)?.[0];
      if (found !== undefined) {
        errors.push({
          code: 'secretLikeContent',
          message: `[${locale}] ${page.key} looks like it contains a credential in a ${where}: ${found.slice(0, 12)}…`,
          path: page.path,
          key: page.key,
        });
      }
    }
  }
}

function checkLink(
  link: Extract<DocInline, { type: 'link' }>,
  page: DocPage,
  index: ReturnType<typeof buildIndex>,
  options: LintOptions,
  locale: string,
  errors: LintIssue[],
): void {
  const dead = (message: string): void => {
    errors.push({ code: 'deadDocLink', message: `[${locale}] ${page.key} ${message}`, path: page.path, key: page.key });
  };
  const { href } = link;

  if (href.startsWith('/')) {
    if (!validateAppRoute(href, options.routes)) {
      errors.push({ code: 'unknownAppRoute', message: `[${locale}] ${page.key} links to ${href}, which is not a route this build has`, path: page.path, key: page.key });
    }
    return;
  }
  if (href.startsWith('#')) {
    if (!page.toc.some((entry) => entry.id === href.slice(1))) dead(`anchors to ${href}, which is not a heading on the page`);
    return;
  }
  if (href.startsWith('https://')) return;

  const target = resolveDocLink(href, page.section);
  if (target === null) {
    dead(`links to ${href}, which is not a documentation key`);
    return;
  }
  const isSectionIndex = index.sections.some((section) => section.key === target.split('/')[0] && section.key === target);
  if (!index.pages.has(target) && !isSectionIndex) dead(`links to ${target}, which is not a page`);
}

/** Every block in reading order, including the nested ones, so a rule cannot miss a link in a table. */
function flatten(blocks: readonly DocBlock[]): readonly DocBlock[] {
  const out: DocBlock[] = [];
  for (const block of blocks) {
    out.push(block);
    if (block.type === 'callout') out.push(...flatten(block.blocks));
    if (block.type === 'list') for (const item of block.items) out.push(...flatten(item));
  }
  return out;
}

function plainTextOf(block: DocBlock): string {
  switch (block.type) {
    case 'heading':
      return block.text;
    case 'paragraph':
      return block.inlines.map((inline) => inline.text).join('');
    case 'list':
      return block.items.map((item) => item.map(plainTextOf).join(' ')).join(' ');
    case 'callout':
      return block.blocks.map(plainTextOf).join(' ');
    case 'table':
      return [...block.head, ...block.rows.flat()].map((cell) => cell.map((inline) => inline.text).join(' ')).join(' ');
    case 'image':
      return `${block.alt} ${block.caption ?? ''}`;
    case 'code':
    case 'divider':
      return '';
    default: {
      const exhaustive: never = block;
      return String((exhaustive as { type?: unknown }).type ?? '');
    }
  }
}

function bytesOf(blocks: readonly DocBlock[]): number {
  return new TextEncoder().encode(JSON.stringify({ blocks })).length;
}
