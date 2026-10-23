/**
 * The index builder: content files in, `DocsIndex` out.
 *
 * Three rules from the contract shape this file and are worth stating because they are the ones that
 * are easy to get wrong:
 *
 *  - **`en` is the structure, the requested locale is the translation.** Sections and pages are ordered
 *    and keyed from the English corpus, so an incomplete `vi` tree still shows a complete handbook with
 *    a per-page fallback flag rather than a half-empty sidebar (§4.6).
 *  - **Building is all-or-nothing per page, never per locale.** A page whose front-matter does not
 *    validate is dropped and recorded as a warning; the other pages keep serving. One typo must not
 *    blank the documentation area (§7.5).
 *  - **Ordering is deterministic.** `order` then key, everywhere, because prev/next links and the
 *    content hash both depend on it.
 */

import { createHash } from 'node:crypto';

import { readFrontMatter } from './front-matter.js';
import { pagePath } from './links.js';
import { parseMarkdown } from './parser.js';
import { blocksToPlainText, buildTokens } from './search.js';
import { isUrlKey, pageKey, slugFromFileName } from './slug.js';
import type {
  ContentFile,
  DocBlock,
  DocFrontMatter,
  DocPage,
  DocPageMeta,
  DocPageRef,
  DocSection,
  DocsIndex,
  DocsLanding,
  DocsWarning,
  DocsWarningCode,
  DocTocEntry,
} from './types.js';

const DOCS_SEGMENT = '/docs/';

export interface ParsedContentPath {
  readonly locale: string;
  /** `null` for the locale's own `_index.md`. */
  readonly section: string | null;
  readonly fileName: string;
  /** Any directory below the section, which the layout does not allow. */
  readonly extra: readonly string[];
}

/** `content/docs/en/admin/main-menu.md` → `{ locale: 'en', section: 'admin', fileName: 'main-menu.md' }`. */
export function parseContentPath(path: string): ParsedContentPath | null {
  const normalized = path.replaceAll('\\', '/');
  const at = normalized.lastIndexOf(DOCS_SEGMENT);
  if (at === -1) return null;
  const segments = normalized.slice(at + DOCS_SEGMENT.length).split('/');
  const fileName = segments.pop() ?? '';
  const locale = segments[0] ?? '';
  const section = segments.length >= 2 ? (segments[1] ?? null) : null;
  if (locale === '' || !fileName.endsWith('.md')) return null;
  return { locale, section, fileName, extra: segments.slice(2) };
}

export interface BuildOptions {
  readonly locale: string;
  /** The corpus that defines the structure and answers for pages this locale lacks. Defaults to `en`. */
  readonly fallbackLocale?: string;
}

export function buildIndex(files: readonly ContentFile[], options: BuildOptions): DocsIndex {
  const locale = options.locale;
  const fallbackLocale = options.fallbackLocale ?? 'en';
  const warnings: DocsWarning[] = [];
  const owned = files.filter((file) => parseContentPath(file.path)?.locale === locale);
  const fallback = locale === fallbackLocale ? [] : files.filter((file) => parseContentPath(file.path)?.locale === fallbackLocale);

  const localeTree = parseCorpus(owned, locale, warnings);
  const base = locale === fallbackLocale ? localeTree : parseCorpus(fallback, fallbackLocale, warnings);

  const pages = new Map<string, DocPage>();
  const relatedKeys = new Map<string, readonly string[]>();
  const plainText = new Map<string, string>();
  const sections: DocSection[] = [];

  for (const baseSection of base.sections) {
    const translated = localeTree.sections.find((candidate) => candidate.key === baseSection.key);
    const descriptor = translated ?? baseSection;

    const unmatched = new Map(localeTree.pages.filter((page) => page.section === baseSection.key).map((page) => [page.key, page]));
    const drafts: { readonly draft: Draft; readonly fallback: boolean }[] = [];
    for (const draft of base.pages.filter((page) => page.section === baseSection.key)) {
      const translation = unmatched.get(draft.key);
      unmatched.delete(draft.key);
      drafts.push({ draft: translation ?? draft, fallback: translation === undefined && locale !== fallbackLocale });
    }
    for (const [key, draft] of unmatched) {
      warnings.push(warning('pageMissingInEnglish', locale, key, draft.path, `${key} exists in ${locale} but not in ${fallbackLocale}`));
      drafts.push({ draft, fallback: false });
    }

    const metas: DocPageMeta[] = [];
    drafts.sort((left, right) => left.draft.meta.order - right.draft.meta.order || left.draft.key.localeCompare(right.draft.key));
    for (const entry of drafts) {
      const page = toPage(entry.draft, locale, fallbackLocale, entry.fallback);
      pages.set(page.key, page);
      relatedKeys.set(page.key, entry.draft.meta.related);
      plainText.set(page.key, blocksToPlainText(page.blocks));
      metas.push(metaOf(page));
    }

    sections.push({
      key: baseSection.key,
      path: `/docs/${baseSection.key}`,
      title: descriptor.title,
      summary: descriptor.summary,
      audience: descriptor.audience,
      order: descriptor.order,
      blocks: descriptor.blocks,
      pages: metas,
    });
  }

  sections.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  linkNeighbours(sections, pages);
  resolveRelated(pages, relatedKeys, warnings, locale);

  return {
    locale,
    hash: contentHash([...fallback, ...owned]),
    landing: localeTree.landing ?? base.landing,
    sections,
    pages,
    tokens: buildTokens([...pages.values()], plainText),
    warnings,
    plainText,
  };
}

/** `sha256` over path + content of every participating file; the order is fixed so the hash is stable. */
export function contentHash(files: readonly ContentFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex');
}

interface Draft {
  readonly key: string;
  readonly section: string;
  readonly slug: string;
  readonly path: string;
  readonly meta: DocFrontMatter;
  readonly blocks: readonly DocBlock[];
}

interface DraftSection {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  readonly audience: DocFrontMatter['audience'];
  readonly order: number;
  readonly blocks: readonly DocBlock[];
}

interface Corpus {
  readonly sections: readonly DraftSection[];
  readonly pages: readonly Draft[];
  readonly landing: DocsLanding | null;
}

function parseCorpus(files: readonly ContentFile[], locale: string, warnings: DocsWarning[]): Corpus {
  const sections = new Map<string, DraftSection>();
  const pages = new Map<string, Draft>();
  let landing: DocsLanding | null = null;

  for (const file of files) {
    const location = parseContentPath(file.path);
    if (location === null || location.locale !== locale) continue;
    if (location.extra.length > 0) {
      warnings.push(
        warning('unexpectedNesting', locale, null, file.path, `${file.path} is nested below its section; the layout is docs/<locale>/<section>/<slug>.md`),
      );
    }

    const parsed = readFrontMatter(file.content);
    if (!parsed.ok) {
      const code = parsed.unknownKeys.length > 0 ? 'frontMatterUnknownKey' : 'frontMatterInvalid';
      warnings.push(warning(code, locale, null, file.path, parsed.issues.join('; ')));
      continue;
    }
    const body = parseMarkdown(parsed.body);
    for (const issue of body.issues) {
      warnings.push(warning(issue.code, locale, null, file.path, `line ${String(issue.line)}: ${issue.message}`));
    }

    const isIndex = location.fileName === '_index.md';
    if (location.section === null) {
      if (!isIndex) {
        warnings.push(warning('pageOutsideSection', locale, null, file.path, 'a page must live in a section directory'));
        continue;
      }
      landing = { title: parsed.data.title, summary: parsed.data.summary, blocks: body.blocks };
      continue;
    }

    if (!isUrlKey(location.section)) {
      warnings.push(warning('sectionKeyInvalid', locale, null, file.path, `section directory ${location.section} is not a URL-safe key`));
      continue;
    }

    if (isIndex) {
      if (sections.has(location.section)) {
        warnings.push(warning('duplicateSectionKey', locale, location.section, file.path, `section ${location.section} is defined twice`));
        continue;
      }
      sections.set(location.section, {
        key: location.section,
        title: parsed.data.title,
        summary: parsed.data.summary,
        audience: parsed.data.audience,
        order: parsed.data.order,
        blocks: body.blocks,
      });
      continue;
    }

    const slug = slugFromFileName(location.fileName);
    if (!isUrlKey(slug)) {
      warnings.push(warning('slugInvalid', locale, null, file.path, `${location.fileName} does not name a valid slug`));
      continue;
    }
    const key = pageKey(location.section, slug);
    if (pages.has(key)) {
      warnings.push(warning('duplicatePageKey', locale, key, file.path, `${key} is defined twice`));
      continue;
    }
    pages.set(key, { key, section: location.section, slug, path: pagePath(location.section, slug), meta: parsed.data, blocks: body.blocks });
  }

  // A section needs `_index.md` to be describable. Without it the pages are still reachable, so the
  // section is synthesised from them and the absence is reported rather than silently swallowed.
  for (const page of pages.values()) {
    if (sections.has(page.section)) continue;
    sections.set(page.section, { key: page.section, title: page.section, summary: '', audience: page.meta.audience, order: 1000, blocks: [] });
    warnings.push(warning('missingSectionIndex', locale, page.key, page.path, `section ${page.section} has no _index.md`));
  }

  return {
    sections: [...sections.values()].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key)),
    pages: [...pages.values()],
    landing,
  };
}

function toPage(draft: Draft, indexLocale: string, fallbackLocale: string, fallback: boolean): DocPage {
  return {
    key: draft.key,
    section: draft.section,
    slug: draft.slug,
    path: draft.path,
    title: draft.meta.title,
    summary: draft.meta.summary,
    audience: draft.meta.audience,
    order: draft.meta.order,
    tags: draft.meta.tags,
    aliases: draft.meta.aliases,
    requires: draft.meta.requires,
    updated: draft.meta.updated,
    fallback,
    // A fallback page reports the language its content actually came from; otherwise it is the locale
    // the reader asked for. §4.6 makes that the difference between a silent substitution and a notice.
    locale: fallback ? fallbackLocale : indexLocale,
    blocks: draft.blocks,
    toc: tocOf(draft.blocks),
    prev: null,
    next: null,
    related: [],
    appLink: firstAppLink(draft.blocks),
  };
}

/** `toc` is derived from the parsed headings, so it can never disagree with the body (§5.5). */
export function tocOf(blocks: readonly DocBlock[]): readonly DocTocEntry[] {
  return blocks
    .filter((block): block is Extract<DocBlock, { type: 'heading' }> => block.type === 'heading' && block.level <= 3)
    .map((block) => ({ id: block.id, text: block.text, level: block.level as 2 | 3 }));
}

function firstAppLink(blocks: readonly DocBlock[]): string | null {
  for (const block of blocks) {
    if (block.type === 'callout') {
      const nested = firstAppLink(block.blocks);
      if (nested !== null) return nested;
      continue;
    }
    if (block.type !== 'paragraph') continue;
    for (const inline of block.inlines) {
      if (inline.type === 'link' && inline.href.startsWith('/')) return inline.href;
    }
  }
  return null;
}

/**
 * Prev and next walk the section and stop at its edge: the last page's "next" is the following
 * section's index, which is what tells the reader the section ended rather than the page ran out (§5.3).
 */
function linkNeighbours(sections: readonly DocSection[], pages: Map<string, DocPage>): void {
  sections.forEach((section, sectionIndex) => {
    const nextSection = sections[sectionIndex + 1];
    section.pages.forEach((meta, pageIndex) => {
      const page = pages.get(meta.key);
      const previous = section.pages[pageIndex - 1];
      const following = section.pages[pageIndex + 1];
      if (page === undefined) return;
      pages.set(page.key, {
        ...page,
        prev: previous === undefined ? null : refOf(previous),
        next:
          following !== undefined
            ? refOf(following)
            : nextSection === undefined
              ? null
              : { key: nextSection.key, path: nextSection.path, title: nextSection.title },
      });
    });
  });
}

function refOf(meta: DocPageMeta): DocPageRef {
  return { key: meta.key, path: meta.path, title: meta.title };
}

function metaOf(page: DocPage): DocPageMeta {
  return {
    key: page.key,
    section: page.section,
    slug: page.slug,
    path: page.path,
    title: page.title,
    summary: page.summary,
    audience: page.audience,
    order: page.order,
    tags: page.tags,
    aliases: page.aliases,
    requires: page.requires,
    updated: page.updated,
    fallback: page.fallback,
    locale: page.locale,
  };
}

/** `related` is validated rather than trusted: a typo names a page that does not exist. */
function resolveRelated(pages: Map<string, DocPage>, relatedKeys: ReadonlyMap<string, readonly string[]>, warnings: DocsWarning[], locale: string): void {
  for (const [key, entries] of relatedKeys) {
    const page = pages.get(key);
    if (page === undefined) continue;
    const related: DocPageRef[] = [];
    for (const entry of entries) {
      const target = pages.get(entry);
      if (target === undefined) {
        warnings.push(warning('unresolvedRelated', locale, key, page.path, `related entry ${entry} is not a page in the corpus`));
        continue;
      }
      related.push(refOf(metaOf(target)));
    }
    pages.set(key, { ...page, related });
  }
}

function warning(code: DocsWarningCode, locale: string, key: string | null, path: string | null, message: string): DocsWarning {
  return { code, locale, key, path, message };
}
