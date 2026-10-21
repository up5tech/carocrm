/**
 * @carocrm/docs — the types every other module in this package shares, and the contract the API
 * serialises to the SPA.
 *
 * Two decisions shape these types and are worth stating where they are defined rather than in a
 * design document nobody reads:
 *
 *  1. **A page is a block tree, never HTML.** The SPA renders `DocBlock`s with real React components,
 *     so the product keeps its "no `dangerouslySetInnerHTML` anywhere" property and a callout, table
 *     or internal link gets the design system's behaviour instead of whatever a Markdown library
 *     emitted. It also means the search API can return highlight `ranges` rather than markup.
 *  2. **Everything is `readonly`.** The index is built once per content hash and then shared between
 *     requests; a mutation that leaked across requests would be a stale-content bug that only shows
 *     up in production. The types make that impossible to write by accident.
 */

/** Who a page is written for. `admin` pages are filtered out for callers who are not administrators. */
export type DocAudience = 'user' | 'admin';

/** An ACL gate on top of `audience`: the page documents a screen the caller must be able to reach. */
export interface DocRequires {
  readonly entity: string;
  readonly action: string;
}

/** The validated front-matter of one page. Field rules: `PLAN_Phase_21_Documentation.md` §4.2. */
export interface DocFrontMatter {
  readonly title: string;
  readonly summary: string;
  readonly audience: DocAudience;
  readonly order: number;
  readonly tags: readonly string[];
  readonly requires: DocRequires | null;
  readonly related: readonly string[];
  readonly updated: string | null;
}

/** The YAML-subset value the front-matter reader produces before the schema has validated it. */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

export type DocInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'strong'; readonly text: string }
  | { readonly type: 'em'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly href: string; readonly internal: boolean };

export type DocBlock =
  | { readonly type: 'paragraph'; readonly inlines: readonly DocInline[] }
  | { readonly type: 'heading'; readonly level: 2 | 3 | 4; readonly id: string; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly (readonly DocBlock[])[] }
  | { readonly type: 'code'; readonly language: string | null; readonly code: string }
  | { readonly type: 'callout'; readonly variant: DocCalloutVariant; readonly blocks: readonly DocBlock[] }
  | {
      readonly type: 'table';
      readonly align: readonly ('left' | 'center' | 'right' | null)[];
      readonly head: readonly (readonly DocInline[])[];
      readonly rows: readonly (readonly (readonly DocInline[])[])[];
    }
  | { readonly type: 'image'; readonly src: string; readonly alt: string; readonly caption: string | null }
  | { readonly type: 'divider' };

export type DocCalloutVariant = 'note' | 'tip' | 'warning' | 'danger';

/** One entry of the table of contents. Derived from the parsed headings so the two cannot disagree. */
export interface DocTocEntry {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3;
}

/**
 * How an `<href>` is classified: a page in this corpus, a route in the SPA, or an external URL.
 * `anchor` is a heading on the same page, and `invalid` means the link must not be rendered at all —
 * a scheme the product has not decided to trust.
 */
export type DocLinkKind = 'doc' | 'app' | 'external' | 'anchor' | 'invalid';

/** The location of one page, independent of locale: `admin/main-menu`. */
export interface DocKey {
  readonly section: string;
  readonly slug: string;
}

/** A page as it appears in a tree — metadata only, no blocks. */
export interface DocPageMeta {
  readonly key: string;
  readonly section: string;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly audience: DocAudience;
  readonly order: number;
  readonly tags: readonly string[];
  readonly requires: DocRequires | null;
  readonly updated: string | null;
  /** True when this locale does not have the page and `en` content is being served instead. */
  readonly fallback: boolean;
  readonly locale: string;
}

/** A full page: metadata plus the parsed body and the navigation the reader needs around it. */
export interface DocPage extends DocPageMeta {
  readonly blocks: readonly DocBlock[];
  readonly toc: readonly DocTocEntry[];
  readonly prev: DocPageRef | null;
  readonly next: DocPageRef | null;
  readonly related: readonly DocPageRef[];
  /** The first root-absolute app link in the body, which the reader offers as "Open this screen". */
  readonly appLink: string | null;
}

/** The minimal shape a prev/next/related entry needs. */
export interface DocPageRef {
  readonly key: string;
  readonly path: string;
  readonly title: string;
}

/** A section, which is a directory in the corpus plus its `_index.md` descriptor. */
export interface DocSection {
  readonly key: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly audience: DocAudience;
  readonly order: number;
  readonly blocks: readonly DocBlock[];
  readonly pages: readonly DocPageMeta[];
}

/** A hit in a search result. `ranges` are offsets into `snippet.text`, never markup. */
export interface DocSearchHit {
  readonly key: string;
  readonly path: string;
  readonly title: string;
  readonly section: string;
  readonly audience: DocAudience;
  readonly locale: string;
  readonly score: number;
  readonly snippet: DocSnippet;
}

export interface DocSnippet {
  readonly text: string;
  readonly ranges: readonly (readonly [number, number])[];
}

/** What `GET /Docs/search` returns: the ranked hits and the terms that produced them. */
export interface DocSearchResult {
  readonly query: string;
  readonly locale: string;
  readonly total: number;
  readonly hits: readonly DocSearchHit[];
}

/** Why the index builder is unhappy. Never fatal on its own: the index still serves the good pages. */
export interface DocsWarning {
  readonly code: DocsWarningCode;
  readonly message: string;
  readonly locale: string;
  readonly key: string | null;
  readonly path: string | null;
}

/**
 * A construct the supported subset refuses. The parser reports these without losing the page; the lint
 * turns each one into a build failure, which is why they double as warning codes.
 */
export type ParserIssueCode =
  | 'h1Reserved'
  | 'headingTooDeep'
  | 'rawHtml'
  | 'listTooDeep'
  | 'blockquoteNotCallout'
  | 'unknownCallout'
  | 'unclosedFence'
  | 'tableRowWidth'
  | 'imageNotAlone'
  | 'missingAlt'
  | 'assetNotLocal'
  | 'unsafeHref'
  | 'unclosedInline';

export type DocsWarningCode =
  | 'frontMatterInvalid'
  | 'frontMatterUnknownKey'
  | 'unexpectedNesting'
  | 'pageOutsideSection'
  | 'pageMissingInEnglish'
  | 'pageNotTranslated'
  | 'sectionKeyInvalid'
  | 'slugInvalid'
  | 'duplicatePageKey'
  | 'duplicateSectionKey'
  | 'duplicateOrder'
  | 'missingSectionIndex'
  | 'deadDocLink'
  | 'unknownAppRoute'
  | 'missingAsset'
  | 'orphanAsset'
  | 'unknownDocKey'
  | 'unresolvedRelated'
  | 'headingLevelSkipped'
  | 'pageTooLarge'
  | 'secretLikeContent'
  | 'redirectProblem'
  | ParserIssueCode;

/** A file as the caller read it. The engine never touches the filesystem itself. */
export interface ContentFile {
  /** Repository-relative path with forward slashes, e.g. `content/docs/en/admin/main-menu.md`. */
  readonly path: string;
  readonly content: string;
}

/** One posting list entry: where a normalized token occurred in one field of one page. */
export interface Posting {
  readonly key: string;
  readonly field: 'title' | 'heading' | 'tag' | 'summary' | 'body';
  /**
   * Character offsets into the normalized text of that field. Only `body` offsets are used, for snippet
   * highlighting; the others exist so scoring can weight a title hit above a body hit.
   */
  readonly positions: readonly number[];
}

/** The `content/docs/<locale>/_index.md` prose shown above the audience cards on `/docs`. */
export interface DocsLanding {
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly DocBlock[];
}

/** The built index for one locale. Built lazily per process and reused until the content hash moves. */
export interface DocsIndex {
  readonly locale: string;
  /** sha256 over every file path and content in this locale's corpus; drives `ETag` and the SPA cache. */
  readonly hash: string;
  readonly landing: DocsLanding | null;
  readonly sections: readonly DocSection[];
  readonly pages: ReadonlyMap<string, DocPage>;
  readonly tokens: ReadonlyMap<string, readonly Posting[]>;
  readonly warnings: readonly DocsWarning[];
  /** Plain text of every page, kept so a snippet can be cut without re-walking the block tree. */
  readonly plainText: ReadonlyMap<string, string>;
}

export interface LintStats {
  readonly files: number;
  readonly pagesByLocale: Readonly<Record<string, number>>;
  readonly sections: number;
  readonly assets: number;
  /** Fraction (0–1) of `en` page keys that also exist in `vi`. */
  readonly coverage: Readonly<Record<string, number>>;
}

export interface LintIssue {
  readonly code: DocsWarningCode;
  readonly message: string;
  readonly path: string | null;
  readonly key: string | null;
}

export interface LintReport {
  readonly errors: readonly LintIssue[];
  readonly warnings: readonly LintIssue[];
  readonly stats: LintStats;
}

/** The redirects map in `content/docs/redirects.json`: old key → new key. */
export type DocRedirects = Readonly<Record<string, string>>;
