import { describe, expect, it } from 'vitest';

import { buildIndex, contentHash, parseContentPath, tocOf } from './index-builder.js';
import type { ContentFile, DocFrontMatter } from './types.js';

function page(section: string, slug: string, meta: Partial<DocFrontMatter> & { title: string }, body = '## Steps\n\nOpen the screen.'): ContentFile {
  const full: DocFrontMatter = {
    summary: `Summary of ${meta.title}`,
    audience: 'user',
    order: 10,
    tags: [],
    requires: null,
    related: [],
    updated: null,
    ...meta,
  };
  const lines = [`title: ${full.title}`, `summary: ${full.summary}`, `audience: ${full.audience}`, `order: ${String(full.order)}`];
  if (full.tags.length > 0) lines.push(`tags: [${full.tags.join(', ')}]`);
  if (full.related.length > 0) lines.push(`related: [${full.related.join(', ')}]`);
  if (full.updated !== null) lines.push(`updated: ${full.updated}`);
  return { path: `content/docs/en/${section}/${slug}.md`, content: `---\n${lines.join('\n')}\n---\n\n${body}\n` };
}

function sectionIndex(section: string, title: string, order: number, audience: 'user' | 'admin' = 'user', locale = 'en'): ContentFile {
  return {
    path: `content/docs/${locale}/${section}/_index.md`,
    content: `---\ntitle: ${title}\nsummary: About ${title}.\naudience: ${audience}\norder: ${String(order)}\n---\n\n## Overview\n`,
  };
}

const CORPUS: readonly ContentFile[] = [
  { path: 'content/docs/en/_index.md', content: '---\ntitle: Documentation\nsummary: Help for this CRM.\naudience: user\norder: 0\n---\n\n## Start here\n' },
  sectionIndex('getting-started', 'Getting started', 10),
  page('getting-started', 'sign-in', { title: 'Signing in', order: 10 }),
  page('getting-started', 'find-your-way', { title: 'Finding your way', order: 20 }),
  sectionIndex('admin', 'Administrator handbook', 20, 'admin'),
  page('admin', 'main-menu', { title: 'Main menu', audience: 'admin', order: 30, related: ['admin/settings-overview', 'admin/nothing-here'] }),
  page('admin', 'settings-overview', { title: 'The administration area', audience: 'admin', order: 10 }),
  page('admin', 'users', { title: 'Users', audience: 'admin', order: 20, updated: '2026-10-21' }),
];

describe('parseContentPath', () => {
  it('reads locale, section and file from the layout', () => {
    expect(parseContentPath('content/docs/en/admin/main-menu.md')).toEqual({ locale: 'en', section: 'admin', fileName: 'main-menu.md', extra: [] });
    expect(parseContentPath('content/docs/vi/_index.md')).toEqual({ locale: 'vi', section: null, fileName: '_index.md', extra: [] });
    expect(parseContentPath('content/docs/en/x.md')).toEqual({ locale: 'en', section: null, fileName: 'x.md', extra: [] });
    expect(parseContentPath('src\\docs\\en\\admin\\a.md')?.locale).toBe('en');
  });

  it('reports nesting below the section rather than flattening it silently', () => {
    expect(parseContentPath('content/docs/en/admin/deep/page.md')).toMatchObject({ section: 'admin', extra: ['deep'] });
  });

  it('refuses a path that is not docs content', () => {
    expect(parseContentPath('docs/admin.md')).toBeNull();
    expect(parseContentPath('content/docs/en/admin/main-menu.txt')).toBeNull();
  });
});

describe('buildIndex ordering', () => {
  const index = buildIndex(CORPUS, { locale: 'en' });

  it('orders sections by their descriptor order', () => {
    expect(index.sections.map((section) => section.key)).toEqual(['getting-started', 'admin']);
  });

  it('orders pages inside a section by `order`, not by filename', () => {
    expect(index.sections[1]?.pages.map((entry) => entry.key)).toEqual([
      'admin/settings-overview',
      'admin/users',
      'admin/main-menu',
    ]);
  });

  it('carries the section descriptor into the section', () => {
    expect(index.sections[1]).toMatchObject({ title: 'Administrator handbook', audience: 'admin', path: '/docs/admin' });
  });

  it('reads the landing page', () => {
    expect(index.landing).toMatchObject({ title: 'Documentation', summary: 'Help for this CRM.' });
  });

  it('is deterministic for the same input in a different order', () => {
    const shuffled = [...CORPUS].reverse();
    const other = buildIndex(shuffled, { locale: 'en' });
    expect(other.hash).toBe(index.hash);
    expect([...other.pages.keys()]).toEqual([...index.pages.keys()]);
  });
});

describe('prev and next', () => {
  const index = buildIndex(CORPUS, { locale: 'en' });

  it('walks the section in order', () => {
    const overview = index.pages.get('admin/settings-overview');
    expect(overview?.prev).toBeNull();
    expect(overview?.next).toMatchObject({ key: 'admin/users' });
  });

  it('links the last page of a section to the next section index rather than crossing silently', () => {
    expect(index.pages.get('getting-started/find-your-way')?.next).toMatchObject({ key: 'admin', path: '/docs/admin', title: 'Administrator handbook' });
    expect(index.pages.get('admin/main-menu')?.prev).toMatchObject({ key: 'admin/users', title: 'Users' });
  });

  it('ends the corpus with nothing after its last page', () => {
    expect(index.pages.get('getting-started/sign-in')?.next).toMatchObject({ key: 'getting-started/find-your-way' });
    // `admin` is the last section, so its last page has nothing after it.
    expect(index.pages.get('admin/main-menu')?.next).toBeNull();
  });
});

describe('derived page fields', () => {
  const index = buildIndex(
    [
      sectionIndex('user', 'User guide', 10),
      page('user', 'lists', { title: 'Working with lists', related: ['user/record-page'] }),
      page('user', 'record-page', { title: 'A record', order: 20 }),
      page('user', 'broken-related', { title: 'Broken', order: 30, related: ['user/does-not-exist'] }),
    ],
    { locale: 'en' },
  );

  it('resolves a related key into a title and path', () => {
    expect(index.pages.get('user/lists')?.related).toEqual([{ key: 'user/record-page', path: '/docs/user/record-page', title: 'A record' }]);
  });

  it('drops an unresolved related entry and warns', () => {
    expect(index.pages.get('user/broken-related')?.related).toEqual([]);
    expect(index.warnings.find((warning) => warning.code === 'unresolvedRelated')?.message).toContain('user/does-not-exist');
  });

  it('builds a toc of h2 and h3 only', () => {
    const withAll = buildIndex([sectionIndex('user', 'User guide', 10), page('user', 'a', { title: 'A', order: 1 }, '## Two\n### Three\n#### Four')], { locale: 'en' });
    expect(withAll.pages.get('user/a')?.toc).toEqual([
      { id: 'two', text: 'Two', level: 2 },
      { id: 'three', text: 'Three', level: 3 },
    ]);
  });

  it('takes the first app link as the page screen link', () => {
    const withLink = buildIndex(
      [sectionIndex('admin', 'Admin', 10), page('admin', 'a', { title: 'A', audience: 'admin', order: 1 }, 'See [Users](/admin/settings/users) and [menu](/admin/settings/menu).')],
      { locale: 'en' },
    );
    expect(withLink.pages.get('admin/a')?.appLink).toBe('/admin/settings/users');
  });

  it('exposes toc for a block list', () => {
    expect(tocOf([{ type: 'heading', level: 4, id: 'deep', text: 'Deep' }])).toEqual([]);
  });
});

describe('locale fallback', () => {
  const vi: readonly ContentFile[] = [
    { path: 'content/docs/vi/getting-started/_index.md', content: '---\ntitle: Bat dau\nsummary: Vao ung.\naudience: user\norder: 10\n---\n\n## Mo ta\n' },
    { path: 'content/docs/vi/getting-started/sign-in.md', content: '---\ntitle: Dang nhap\nsummary: Vao he thong.\naudience: user\norder: 10\n---\n\n## Dang nhap\n' },
    sectionIndex('admin', 'Administrator handbook', 20, 'admin', 'vi'),
  ];
  const index = buildIndex([...CORPUS, ...vi], { locale: 'vi' });

  it('serves a translated page in the requested locale', () => {
    const signIn = index.pages.get('getting-started/sign-in');
    expect(signIn).toMatchObject({ title: 'Dang nhap', fallback: false, locale: 'vi' });
  });

  it('falls back to English per page, not per section', () => {
    const missing = index.pages.get('getting-started/find-your-way');
    expect(missing).toMatchObject({ title: 'Finding your way', fallback: true, locale: 'en' });
  });

  it('keeps the English structure so a partial locale still shows a full handbook', () => {
    expect(index.sections.map((section) => section.pages.length)).toEqual([2, 3]);
  });

  it('uses the translated section descriptor when there is one', () => {
    expect(index.sections[0]).toMatchObject({ title: 'Bat dau', summary: 'Vao ung.' });
  });

  it('flags a page that only exists in the translation', () => {
    const onlyVi = buildIndex(
      [...CORPUS, { path: 'content/docs/vi/getting-started/extra.md', content: '---\ntitle: Extra\nsummary: Not in en.\naudience: user\norder: 90\n---\n' }],
      { locale: 'vi' },
    );
    expect(onlyVi.warnings.map((warning) => warning.code)).toContain('pageMissingInEnglish');
  });
});

describe('warnings, not blank pages', () => {
  it('drops a page with invalid front-matter and keeps its neighbours', () => {
    const index = buildIndex(
      [
        sectionIndex('user', 'User guide', 10),
        page('user', 'good', { title: 'Good', order: 1 }),
        { path: 'content/docs/en/user/bad.md', content: '---\ntitle: Bad\naudience: nobody\norder: 2\n---\n' },
      ],
      { locale: 'en' },
    );
    expect([...index.pages.keys()]).toEqual(['user/good']);
    expect(index.warnings.find((warning) => warning.code === 'frontMatterInvalid')?.message).toContain('audience');
  });

  it('synthesises a section that has no _index.md and says so', () => {
    const index = buildIndex([page('user', 'orphan', { title: 'Orphan' })], { locale: 'en' });
    expect(index.sections.map((section) => section.key)).toEqual(['user']);
    expect(index.warnings.map((warning) => warning.code)).toContain('missingSectionIndex');
  });

  it('refuses a duplicate key produced by an ordering prefix', () => {
    const index = buildIndex([sectionIndex('user', 'U', 10), page('user', 'a', { title: 'One', order: 1 }), page('user', '01-a', { title: 'Two', order: 2 })], { locale: 'en' });
    expect(index.warnings.map((warning) => warning.code)).toContain('duplicatePageKey');
    expect(index.pages.get('user/a')?.title).toBe('One');
  });

  it('reports an invalid slug, an invalid section key and unexpected nesting', () => {
    const index = buildIndex(
      [
        { path: 'content/docs/en/Bad_Section/_index.md', content: '---\ntitle: S\nsummary: s\naudience: user\norder: 1\n---\n' },
        { path: 'content/docs/en/user/Bad File.md', content: '---\ntitle: S\nsummary: s\naudience: user\norder: 1\n---\n' },
        { path: 'content/docs/en/user/deep/nested.md', content: '---\ntitle: N\nsummary: n\naudience: user\norder: 2\n---\n' },
      ],
      { locale: 'en' },
    );
    expect(index.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['sectionKeyInvalid', 'slugInvalid', 'unexpectedNesting']),
    );
  });

  it('records an unsupported Markdown construct without losing the page', () => {
    const index = buildIndex([sectionIndex('user', 'U', 10), page('user', 'a', { title: 'A' }, '## Safe\n\n<script>alert(1)</script>')], { locale: 'en' });
    expect(index.pages.get('user/a')?.blocks[1]).toMatchObject({ type: 'paragraph' });
    expect(index.warnings.map((warning) => warning.code)).toContain('rawHtml');
  });
});

describe('contentHash', () => {
  it('moves when content moves', () => {
    const before = contentHash([{ path: 'a.md', content: 'one' }]);
    const after = contentHash([{ path: 'a.md', content: 'two' }]);
    expect(before).not.toBe(after);
    expect(before).toHaveLength(64);
  });

  it('does not collide across a path and content boundary', () => {
    expect(contentHash([{ path: 'a.md', content: 'b' }])).not.toBe(contentHash([{ path: 'a.mdb', content: '' }]));
  });
});

describe('an empty corpus', () => {
  const index = buildIndex([], { locale: 'en' });

  it('builds rather than throwing, so a missing content directory degrades to an empty state', () => {
    expect(index.sections).toEqual([]);
    expect(index.pages.size).toBe(0);
    expect(index.landing).toBeNull();
    expect(index.hash).toHaveLength(64);
  });
});
