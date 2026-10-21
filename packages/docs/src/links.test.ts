import { describe, expect, it } from 'vitest';

import { classifyHref, DEFAULT_APP_ROUTES, docLinkPath, redirectProblems, resolveDocLink, validateAppRoute } from './links.js';

describe('classifyHref', () => {
  it('recognises each supported form', () => {
    expect(classifyHref('admin/main-menu')).toBe('doc');
    expect(classifyHref('../admin/main-menu.md')).toBe('doc');
    expect(classifyHref('main-menu')).toBe('doc');
    expect(classifyHref('/admin/settings/menu')).toBe('app');
    expect(classifyHref('https://example.com/a')).toBe('external');
    expect(classifyHref('#enable-an-entry')).toBe('anchor');
  });

  it('refuses every other scheme rather than passing it to the DOM', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'mailto:a@b.c', 'ftp://x/y', 'http://example.com']) {
      expect(classifyHref(href)).toBe('invalid');
    }
  });

  it('refuses a backslash or space-shaped href', () => {
    expect(classifyHref('Admin/Main')).toBe('invalid');
    expect(classifyHref('main menu')).toBe('invalid');
  });
});

describe('resolveDocLink', () => {
  it('normalises the key form', () => {
    expect(resolveDocLink('admin/main-menu', 'admin')).toBe('admin/main-menu');
  });

  it('normalises a sibling slug against the current section', () => {
    expect(resolveDocLink('users-teams-roles', 'admin')).toBe('admin/users-teams-roles');
    expect(resolveDocLink('./users-teams-roles.md', 'admin')).toBe('admin/users-teams-roles');
  });

  it('normalises a path that steps out of the section', () => {
    expect(resolveDocLink('../admin/main-menu', 'user')).toBe('admin/main-menu');
    expect(resolveDocLink('../admin/main-menu.md', 'getting-started')).toBe('admin/main-menu');
  });

  it('refuses a non-doc href and a shape with too many segments', () => {
    expect(resolveDocLink('/admin/settings/menu', 'admin')).toBeNull();
    expect(resolveDocLink('a/b/c', 'admin')).toBeNull();
    expect(resolveDocLink('javascript:x', 'admin')).toBeNull();
  });
});

describe('validateAppRoute', () => {
  it('accepts the static pages that exist', () => {
    for (const route of ['/home', '/tasks', '/admin/settings/menu', '/admin/entity-manager']) {
      expect(validateAppRoute(route)).toBe(true);
    }
  });

  it('accepts a deeper path under a wildcard entry', () => {
    expect(validateAppRoute('/admin/settings/roles')).toBe(true);
    expect(validateAppRoute('/admin/entity-manager/Account')).toBe(true);
  });

  it('accepts an entity list route only when the entity is known', () => {
    expect(validateAppRoute('/Account', { entities: ['Account'] })).toBe(true);
    expect(validateAppRoute('/Account/create', { entities: ['Account'] })).toBe(true);
    expect(validateAppRoute('/Account/123', { entities: ['Account'] })).toBe(false);
    expect(validateAppRoute('/NoSuchEntity')).toBe(false);
  });

  it('refuses a protocol-relative or unknown path', () => {
    expect(validateAppRoute('//evil.com/x')).toBe(false);
    expect(validateAppRoute('/admin/nonexistent')).toBe(false);
    expect(validateAppRoute('admin/settings')).toBe(false);
  });

  it('keeps /docs itself routable so a page can link into another page', () => {
    expect(DEFAULT_APP_ROUTES).toContain('/docs');
    expect(validateAppRoute('/docs/admin/main-menu')).toBe(true);
  });

  it('honours a caller-supplied allowlist instead of the default', () => {
    expect(validateAppRoute('/home', { allowlist: ['/only-this'] })).toBe(false);
    expect(validateAppRoute('/only-this', { allowlist: ['/only-this'] })).toBe(true);
  });
});

describe('docLinkPath', () => {
  it('renders the SPA path for a key', () => {
    expect(docLinkPath('admin/main-menu')).toBe('/docs/admin/main-menu');
  });
});

describe('redirectProblems', () => {
  const keys = new Set(['admin/main-menu', 'admin/users']);

  it('accepts a redirect to a real page', () => {
    expect(redirectProblems({ 'admin/navigation': 'admin/main-menu' }, keys)).toEqual([]);
  });

  it('refuses a chain, because the first hop would break on its own', () => {
    const problems = redirectProblems({ 'a/x': 'admin/main-menu', 'admin/main-menu': 'admin/users' }, keys);
    expect(problems.map((problem) => problem.message)).toContain(
      'target admin/main-menu is itself redirected; chains are not allowed',
    );
  });

  it('refuses a self redirect', () => {
    expect(redirectProblems({ 'admin/main-menu': 'admin/main-menu' }, keys)[0]?.message).toBe('redirects to itself');
  });

  it('refuses a target that is not in the corpus', () => {
    expect(redirectProblems({ 'admin/old': 'admin/gone' }, keys)[0]?.message).toBe('target admin/gone is not a page in the corpus');
  });

  it('refuses a malformed source or target key', () => {
    expect(redirectProblems({ Admin: 'admin/main-menu' }, keys).length).toBeGreaterThan(0);
  });
});
