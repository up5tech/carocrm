/**
 * Links: classification, resolution and the route allowlist.
 *
 * A documentation page can point at three things, and each one has to be checked differently
 * (`PLAN_Phase_21_Documentation.md` §4.5): another page in the corpus, a screen of the running app,
 * or the internet outside it. The interesting failure mode is not a broken link — it is a page that
 * *silently* stops working because a route was renamed, which is why the app-route half is a validated
 * allowlist rather than a string test.
 *
 * Scheme refusal lives here too. `javascript:` and `data:` never reach the DOM, and plain `http:` is
 * refused because the product promises an external link is one the reader can trust not to be a
 * downgrade.
 */

import type { DocLinkKind, DocRedirects } from './types.js';

const EXTERNAL_URL = 'https://';
const DOC_KEY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
/** A bare slug is a link to a page in the same section, which the resolver expands. */
const BARE_SLUG = /^[a-z][a-z0-9-]*$/;
const RELATIVE_PREFIX = /^\.{1,2}\//;

/** The routes a documentation page may link to. Extended by the caller with the live entity list. */
export const DEFAULT_APP_ROUTES: readonly string[] = [
  '/home',
  '/stream',
  '/calendar',
  '/search',
  '/dashboards',
  '/reports',
  '/tasks',
  '/profile',
  '/ai-agents',
  '/crm-chat',
  '/voice-inbox',
  '/voice-communications',
  '/advanced-integrations',
  '/esignature',
  '/lead-score',
  '/csat',
  '/marketing/preferences',
  '/admin/settings',
  '/admin/settings/*',
  '/admin/entity-manager',
  '/admin/entity-manager/*',
  '/admin/audit-log',
  '/admin/jobs',
  '/admin/extensions',
  '/admin/workflows',
  '/admin/workflows/*',
  '/admin/processes',
  '/admin/processes/*',
  '/admin/portals',
  '/docs',
  '/docs/*',
];

export interface AppRouteOptions {
  readonly allowlist?: readonly string[];
  /** Entity names, so `/Account` and `/Account/create` are routes without hard-coding the CRM schema. */
  readonly entities?: readonly string[];
}

/** What an `<href>` points at. `invalid` means it must not be rendered as a link at all. */
export function classifyHref(href: string): DocLinkKind {
  if (href.startsWith('#')) return 'anchor';
  if (href.startsWith('/')) return 'app';
  if (href.startsWith(EXTERNAL_URL)) return 'external';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return 'invalid';
  if (DOC_KEY.test(href) || BARE_SLUG.test(href) || href.endsWith('.md') || RELATIVE_PREFIX.test(href)) return 'doc';
  return 'invalid';
}

/**
 * Normalises any doc-link form to a `section/slug` key: `admin/main-menu`, `../admin/main-menu.md` and
 * a bare sibling slug all resolve to the same place, so the lint can compare it against the index.
 */
export function resolveDocLink(href: string, currentSection: string): string | null {
  if (classifyHref(href) !== 'doc') return null;
  const withoutExtension = href.replace(/\.md$/i, '');
  const segments = withoutExtension.split('/');
  const stack: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (segment === '.') continue;
    if (segment === '..') {
      // A leading `../` steps out of the current section; more than that is not a shape we accept.
      if (stack.length === 0) continue;
      stack.pop();
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(segment)) return null;
    if (isLast) {
      // The final segment is a slug, so it needs the section it lives in.
      if (stack.length === 0) return `${currentSection}/${segment}`;
      if (stack.length === 1) return `${stack[0]}/${segment}`;
      return null;
    }
    stack.push(segment);
  }
  return stack.length === 1 ? `${stack[0]}/_index` : null;
}

/** A root-absolute path the SPA can actually navigate to. */
export function validateAppRoute(path: string, options: AppRouteOptions = {}): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  const allowlist = options.allowlist ?? DEFAULT_APP_ROUTES;
  if (allowlist.includes(path)) return true;
  if (allowlist.some((entry) => entry.endsWith('/*') && path.startsWith(entry.slice(0, -1)) && path.length > entry.length - 1)) {
    return true;
  }
  const firstSegment = path.slice(1).split('/')[0] ?? '';
  const entities = options.entities ?? [];
  if (!entities.includes(firstSegment)) return false;
  const rest = path.slice(1 + firstSegment.length).replace(/^\//, '');
  return rest === '' || rest === 'create' || rest === 'board';
}

/** The URL a doc link is rendered as. Kept here so the parser and the lint agree on the target. */
export function docLinkPath(key: string): string {
  return `/docs/${key}`;
}

/** The SPA path a page's own link uses. */
export function pagePath(section: string, slug: string): string {
  return `/docs/${section}/${slug}`;
}

export interface RedirectProblem {
  readonly source: string;
  readonly target: string;
  readonly message: string;
}

/**
 * A redirect table is a permalink contract, so it is checked for the three things that make one
 * unusable: a target that does not exist, a target that is itself redirected (a chain, which means the
 * first hop is dead the moment someone edits the second), and a cycle.
 */
export function redirectProblems(redirects: DocRedirects, knownKeys: ReadonlySet<string>): readonly RedirectProblem[] {
  const problems: RedirectProblem[] = [];
  for (const [source, target] of Object.entries(redirects)) {
    if (!DOC_KEY.test(source)) problems.push({ source, target, message: `${source} is not a valid section/slug key` });
    if (!DOC_KEY.test(target)) problems.push({ source, target, message: `${target} is not a valid section/slug key` });
    if (source === target) problems.push({ source, target, message: 'redirects to itself' });
    else if (Object.hasOwn(redirects, target)) problems.push({ source, target, message: `target ${target} is itself redirected; chains are not allowed` });
    else if (!knownKeys.has(target)) problems.push({ source, target, message: `target ${target} is not a page in the corpus` });
  }
  return problems;
}
