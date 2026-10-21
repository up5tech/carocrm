import { describe, expect, it } from 'vitest';

import { lintContent, type LintOptions } from './lint.js';
import type { ContentFile, DocFrontMatter } from './types.js';

function page(section: string, slug: string, meta: Partial<DocFrontMatter> & { title: string }, body = '## Steps\n\nOpen the screen.', locale = 'en'): ContentFile {
  const full: DocFrontMatter = { summary: `Summary of ${meta.title}`, audience: 'user', order: 10, tags: [], requires: null, related: [], updated: null, ...meta };
  const lines = [`title: ${full.title}`, `summary: ${full.summary}`, `audience: ${full.audience}`, `order: ${String(full.order)}`];
  if (full.related.length > 0) lines.push(`related: [${full.related.join(', ')}]`);
  return { path: `content/docs/${locale}/${section}/${slug}.md`, content: `---\n${lines.join('\n')}\n---\n\n${body}\n` };
}

function sectionIndex(section: string, order: number, audience: 'user' | 'admin' = 'user', locale = 'en'): ContentFile {
  return {
    path: `content/docs/${locale}/${section}/_index.md`,
    content: `---\ntitle: ${section}\nsummary: The ${section} section.\naudience: ${audience}\norder: ${String(order)}\n---\n\n## Overview\n`,
  };
}

function codes(files: readonly ContentFile[], options: LintOptions = {}): string[] {
  return lintContent(files, options).errors.map((error) => error.code);
}

const CLEAN: readonly ContentFile[] = [
  sectionIndex('user', 10),
  page('user', 'lists', { title: 'Working with lists', order: 10 }, '## Columns\n\nPick [a record page](user/record-page) or [open Settings](/admin/settings/menu).'),
  page('user', 'record-page', { title: 'A record', order: 20, related: ['user/lists'] }, '## Edit\n\nSee [lists](lists) and the [edit step](#edit).\n\n![The list columns](/docs-assets/lists.png "Columns")'),
];

describe('the clean corpus', () => {
  it('lints without an error and reports what it found', () => {
    const report = lintContent(CLEAN, { assets: ['lists.png'], routes: { entities: ['Account'] } });
    expect(report.errors).toEqual([]);
    expect(report.stats).toMatchObject({ files: 3, sections: 1, assets: 1, pagesByLocale: { en: 2 }, coverage: { en: 1 } });
  });

  it('accepts every internal link form the authoring guide allows', () => {
    const files = [
      sectionIndex('user', 10),
      sectionIndex('admin', 20, 'admin'),
      page('user', 'a', { title: 'A', order: 1 }, 'See [key](admin/main-menu), [sibling](b.md), [relative](../admin/main-menu.md).'),
      page('user', 'b', { title: 'B', order: 2 }, 'Nothing.'),
      page('admin', 'main-menu', { title: 'Main menu', audience: 'admin', order: 1 }, 'Back to [a](user/a).'),
    ];
    expect(lintContent(files).errors).toEqual([]);
  });
});

describe('front-matter rules', () => {
  it('fails a page whose front-matter does not validate', () => {
    const files = [sectionIndex('user', 10), { path: 'content/docs/en/user/bad.md', content: '---\ntitle: Bad\naudience: nobody\norder: 2\n---\n' }];
    expect(codes(files)).toContain('frontMatterInvalid');
  });

  it('fails a page with an unknown key rather than guessing', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }), { path: 'content/docs/en/user/b.md', content: '---\ntitle: B\nsummary: b\naudiance: user\norder: 2\n---\n' }];
    expect(codes(files)).toContain('frontMatterUnknownKey');
  });

  it('fails a duplicate slug produced by two ordering prefixes', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A', order: 1 }), page('user', '01-a', { title: 'A again', order: 2 })];
    expect(codes(files)).toContain('duplicatePageKey');
  });

  it('fails two pages with the same order in one section', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A', order: 5 }), page('user', 'b', { title: 'B', order: 5 })];
    expect(codes(files)).toContain('duplicateOrder');
  });

  it('fails a section without _index.md', () => {
    expect(codes([page('user', 'a', { title: 'A' })])).toContain('missingSectionIndex');
  });

  it('fails an English corpus with no usable page at all', () => {
    expect(codes([{ path: 'content/docs/en/user/a.md', content: 'no front matter\n' }])).toContain('frontMatterInvalid');
  });
});

describe('content rules', () => {
  it('fails Markdown outside the supported subset', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Safe\n\n<div>raw html</div>')];
    expect(codes(files)).toContain('rawHtml');
  });

  it('fails a heading level that skips', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Two\n\n#### Four')];
    expect(codes(files)).toContain('headingLevelSkipped');
  });

  it('fails a page above the payload ceiling', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Long\n\n' + 'word '.repeat(2000))];
    expect(codes(files, { maxPageBytes: 256 })).toContain('pageTooLarge');
  });

  it('fails content that looks like a credential, in prose and in a code block', () => {
    const cases = ['Use sk-abcdefgh12345678 to sign', 'Send `Bearer abcdef123456789`', 'Set 0123456789abcdef0123456789abcdef'];
    for (const body of cases) {
      expect(codes([sectionIndex('user', 10), page('user', 'a', { title: 'A' }, `## Key\n\n${body}`)])).toContain('secretLikeContent');
    }
    expect(codes([sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Key\n\n```\nsupport@example.com\n```')])).toContain('secretLikeContent');
  });

  it('accepts an email address in prose and a short hex-looking id', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Contact\n\nAsk support@example.com for the id `abc123`.')];
    expect(lintContent(files).errors).toEqual([]);
  });
});

describe('links', () => {
  it('fails a doc link to a page that is not there', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, 'See [gone](user/nowhere).')];
    expect(codes(files)).toContain('deadDocLink');
  });

  it('fails a link to an anchor that is not a heading', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, 'See [steps](#no-such-heading).')];
    expect(codes(files)).toContain('deadDocLink');
  });

  it('fails an app link to a route the caller does not recognise', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, 'Open [the old place](/admin/settings/legacy).')];
    expect(codes(files, { routes: { allowlist: ['/admin/settings', '/admin/settings/menu'] } })).toContain('unknownAppRoute');
  });

  it('accepts an entity route only when the caller lists the entity', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, 'Go to [accounts](/Account).')];
    expect(codes(files)).toContain('unknownAppRoute');
    expect(lintContent(files, { routes: { entities: ['Account'] } }).errors).toEqual([]);
  });

  it('refuses an unsafe scheme', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, 'Click [here](javascript:alert(1)).')];
    expect(codes(files)).toContain('unsafeHref');
  });

  it('fails a docKey published by an admin tab when no page matches', () => {
    const report = lintContent(CLEAN, { tabDocKeys: ['user/lists', 'admin/ghost'] });
    expect(report.errors.map((error) => error.key)).toEqual(['admin/ghost']);
  });
});

describe('assets', () => {
  it('fails a reference to a missing file', () => {
    const report = lintContent(CLEAN, { assets: [] });
    expect(report.errors.map((error) => error.code)).toContain('missingAsset');
  });

  it('fails a shipped file no page references', () => {
    expect(codes(CLEAN, { assets: ['lists.png', 'unused.png'] })).toContain('orphanAsset');
  });

  it('fails an image with no alt text', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Shot\n\n![](/docs-assets/lists.png)')];
    expect(codes(files, { assets: ['lists.png'] })).toContain('missingAlt');
  });

  it('fails an image hosted somewhere else', () => {
    const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }, '## Shot\n\n![alt](https://cdn.example.com/x.png)')];
    expect(codes(files)).toContain('assetNotLocal');
  });
});

describe('redirects', () => {
  const files = [sectionIndex('user', 10), page('user', 'a', { title: 'A' }), page('user', 'b', { title: 'B', order: 20 })];

  it('accepts a single hop to a real page', () => {
    expect(lintContent(files, { redirects: { 'user/old': 'user/a' } }).errors).toEqual([]);
  });

  it('fails a chain, a cycle and a missing target', () => {
    expect(codes(files, { redirects: { 'user/x': 'user/a', 'user/a': 'user/b' } })).toContain('redirectProblem');
    expect(codes(files, { redirects: { 'user/a': 'user/a' } })).toContain('redirectProblem');
    expect(codes(files, { redirects: { 'user/x': 'user/gone' } })).toContain('redirectProblem');
  });
});

describe('locales', () => {
  it('treats a page missing in vi as a warning, not a build failure', () => {
    const report = lintContent([...CLEAN, sectionIndex('user', 10, 'user', 'vi')], { assets: ['lists.png'] });
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter((warning) => warning.code === 'pageNotTranslated').map((warning) => warning.key)).toEqual([
      'user/lists',
      'user/record-page',
    ]);
    expect(report.stats.pagesByLocale).toEqual({ en: 2, vi: 0 });
    expect(report.stats.coverage.vi).toBe(0);
  });

  it('treats a page that exists only in vi as a warning too', () => {
    const report = lintContent([...CLEAN, page('user', 'extra', { title: 'Extra', order: 30 }, '## Only vi', 'vi')], { assets: ['lists.png'] });
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((warning) => warning.message).join(' ')).toContain('extra');
  });

  it('fails a vi page whose own front-matter is broken', () => {
    const files = [...CLEAN, { path: 'content/docs/vi/user/a.md', content: '---\ntitle: A\n---\n' }];
    expect(codes(files, { assets: ['lists.png'] })).toContain('frontMatterInvalid');
  });
});
