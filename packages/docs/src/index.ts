/**
 * @carocrm/docs — the documentation engine behind the in-app `/docs` surface.
 *
 * This package is deliberately pure: it takes `{ path, content }[]` and returns an index. No Nest, no
 * filesystem access, no database, no network. That is what makes the risky half of Phase 21 — the
 * Markdown subset, the search ranking, and the lint that decides whether a release may ship — unit
 * testable in milliseconds, and it is why the API module stays a thin HTTP shell.
 *
 * A Markdown library was considered and rejected: it emits HTML, which this product must never render,
 * and it cannot enforce the documented subset (§4.3). The parser here is small and total.
 */

export type { FrontMatterResult } from './front-matter.js';
export { DocFrontMatterSchema,parseYamlSubset, readFrontMatter, splitFrontMatter } from './front-matter.js';
export type { BuildOptions, ParsedContentPath } from './index-builder.js';
export { buildIndex, contentHash, parseContentPath, tocOf } from './index-builder.js';
export type { AppRouteOptions, RedirectProblem } from './links.js';
export {
  classifyHref,
  DEFAULT_APP_ROUTES,
  docLinkPath,
  pagePath,
  redirectProblems,
  resolveDocLink,
  validateAppRoute,
} from './links.js';
export type { LintOptions } from './lint.js';
export { lintContent } from './lint.js';
export type { ParsedMarkdown,ParserIssue, ParserIssueCode } from './parser.js';
export { parseInlines, parseMarkdown } from './parser.js';
export type { SearchOptions, Term } from './search.js';
export {
  blocksToPlainText,
  buildTokens,
  normalizeForSearch,
  searchIndex,
  snippetFor,
  tokenize,
} from './search.js';
export { headingId, isUrlKey, pageKey, slugFromFileName, slugify, stripDiacritics } from './slug.js';
export type {
  ContentFile,
  DocAudience,
  DocBlock,
  DocCalloutVariant,
  DocFrontMatter,
  DocInline,
  DocKey,
  DocLinkKind,
  DocPage,
  DocPageMeta,
  DocPageRef,
  DocRedirects,
  DocRequires,
  DocSearchHit,
  DocSection,
  DocsIndex,
  DocSnippet,
  DocsWarning,
  DocsWarningCode,
  DocTocEntry,
  LintIssue,
  LintReport,
  LintStats,
  Posting,
  YamlValue,
} from './types.js';
