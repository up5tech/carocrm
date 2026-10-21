import { describe, expect, it } from 'vitest';

import { buildIndex } from './index-builder.js';
import { blocksToPlainText, buildTokens, normalizeForSearch, searchIndex, snippetFor, tokenize } from './search.js';
import type { ContentFile, DocBlock, DocsIndex } from './types.js';

function page(section: string, slug: string, title: string, body: string, extra = '', locale = 'en'): ContentFile {
  return {
    path: `content/docs/${locale}/${section}/${slug}.md`,
    content: `---\ntitle: ${title}\nsummary: The page about ${title.toLowerCase()}.\naudience: ${section === 'admin' ? 'admin' : 'user'}\norder: ${String(slug.length)}${extra}\n---\n\n${body}\n`,
  };
}

const FIXTURE: readonly ContentFile[] = [
  { path: 'content/docs/en/admin/_index.md', content: '---\ntitle: Admin\nsummary: Administration.\naudience: admin\norder: 20\n---\n' },
  page('admin', 'settings-overview', 'The administration area', 'Everything you configure for the instance lives here, including the branding and the menu.'),
  page('admin', 'main-menu', 'Main menu', 'Reorder the sidebar entries. Cấu hình menu affects every role at once.'),
  page('admin', 'users-teams-roles', 'Users, teams and roles', 'Add a user, then give the account a role. Assign teams to share records.'),
  page('admin', 'api-keys', 'API keys', 'A key is shown once. Revoking a key cannot be undone.', ' \ntags: [apikey, token]'),
];

let cached: DocsIndex | undefined;
function index(): DocsIndex {
  cached ??= buildIndex(FIXTURE, { locale: 'en' });
  return cached;
}

describe('normalizeForSearch', () => {
  it('keeps the length of the input so snippet offsets stay valid', () => {
    for (const text of ['Cấu hình menu', 'Đà Nẵng — a city', 'Press **Save** now', '日本語']) {
      expect(normalizeForSearch(text)).toHaveLength(text.length);
    }
  });

  it('strips Vietnamese diacritics and case', () => {
    expect(normalizeForSearch('Cấu hình')).toBe('cau hinh');
    expect(normalizeForSearch('ĐĂNG NHẬP')).toBe('dang nhap');
  });

  it('replaces punctuation with spaces rather than dropping it', () => {
    expect(normalizeForSearch('a, b! c')).toBe('a  b  c');
  });
});

describe('tokenize', () => {
  it('returns whole words with their offsets', () => {
    expect(tokenize(normalizeForSearch('Cấu hình menu'))).toEqual([
      { token: 'cau', start: 0 },
      { token: 'hinh', start: 4 },
      { token: 'menu', start: 9 },
    ]);
  });

  it('ignores one-character tokens', () => {
    expect(tokenize(normalizeForSearch('a b cd'))).toEqual([{ token: 'cd', start: 4 }]);
  });
});

describe('searchIndex', () => {
  it('finds a page through text the reader cannot type on a keyboard layout, `cau hinh` for `Cấu hình`', () => {
    const result = searchIndex(index(), 'cau hinh');
    expect(result.hits.map((hit) => hit.key)).toEqual(['admin/main-menu']);
    expect(result.hits[0]?.locale).toBe('en');
  });

  it('matches without diacritics and keeps the result locale honest for a fallback page', () => {
    const vi = buildIndex([...FIXTURE, page('admin', 'api-keys', 'Khoa API', 'Khoa chi hien mot lan.', '', 'vi')], { locale: 'vi' });
    // Only `api-keys` is translated, so a hit on the English page has to say it came from `en`.
    expect(searchIndex(vi, 'menu').hits.map((hit) => `${hit.key}:${hit.locale}`)).toContain('admin/main-menu:en');
    expect(searchIndex(vi, 'khoa').hits.map((hit) => `${hit.key}:${hit.locale}`)).toContain('admin/api-keys:vi');
  });

  it('ranks a title match above a body match', () => {
    const result = searchIndex(index(), 'menu');
    expect(result.hits[0]?.key).toBe('admin/main-menu');
    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('ranks a heading above a tag and a tag above loose body text', () => {
    const shaped = buildIndex(
      [
        { path: 'content/docs/en/admin/_index.md', content: '---\ntitle: Admin\nsummary: a\naudience: admin\norder: 1\n---\n' },
        page('admin', 'heading-page', 'Heading page', '## Widget\n\nNothing else here.', ''),
        page('admin', 'tag-page', 'Tag page', 'Nothing here either.', '\ntags: [widget]'),
        page('admin', 'body-page', 'Body page', 'The word widget appears once in this sentence.', ''),
      ],
      { locale: 'en' },
    );
    expect(searchIndex(shaped, 'widget').hits.map((hit) => hit.key)).toEqual(['admin/heading-page', 'admin/tag-page', 'admin/body-page']);
  });

  it('gives a phrase more weight than the same words scattered apart', () => {
    const shaped = buildIndex(
      [
        { path: 'content/docs/en/admin/_index.md', content: '---\ntitle: Admin\nsummary: a\naudience: admin\norder: 1\n---\n' },
        page('admin', 'phrase', 'Other', 'Restore defaults is the phrase to look for here.'),
        page('admin', 'scattered', 'Restore', 'Restore something elsewhere, defaults somewhere else entirely.'),
      ],
      { locale: 'en' },
    );
    expect(searchIndex(shaped, 'restore defaults').hits.map((hit) => hit.key)).toEqual(['admin/phrase', 'admin/scattered']);
  });

  it('returns nothing for an empty or one-character query', () => {
    expect(searchIndex(index(), '').total).toBe(0);
    expect(searchIndex(index(), 'a').total).toBe(0);
  });

  it('caps at the limit and clamps an absurd one', () => {
    expect(searchIndex(index(), 'a', { limit: 1 }).hits).toHaveLength(0);
    const result = searchIndex(index(), 'the', { limit: 2 });
    expect(result.hits.length).toBeLessThanOrEqual(2);
    expect(searchIndex(index(), 'the', { limit: 5000 }).hits.length).toBeLessThanOrEqual(50);
  });

  it('breaks ties deterministically', () => {
    expect(searchIndex(index(), 'the').hits.map((hit) => hit.key)).toEqual(searchIndex(index(), 'the').hits.map((hit) => hit.key));
  });

  it('indexes only what buildTokens was given, so a page with no body still matches its title', () => {
    const shaped = buildIndex(
      [
        { path: 'content/docs/en/admin/_index.md', content: '---\ntitle: Admin\nsummary: a\naudience: admin\norder: 1\n---\n' },
        page('admin', 'only-title', 'Zebra bridge', ''),
      ],
      { locale: 'en' },
    );
    expect(searchIndex(shaped, 'zebra').hits.map((hit) => hit.key)).toEqual(['admin/only-title']);
  });
});

describe('snippets', () => {
  it('puts every range exactly on a matched word', () => {
    for (const hit of searchIndex(index(), 'menu').hits) {
      for (const [from, to] of hit.snippet.ranges) {
        expect(hit.snippet.text.slice(from, to)).toMatch(/menu/i);
      }
      expect(hit.snippet.ranges.length).toBeGreaterThan(0);
    }
  });

  it('marks up the Vietnamese word while showing the original spelling', () => {
    const [hit] = searchIndex(index(), 'cau hinh').hits;
    if (hit === undefined) throw new Error('expected a hit');
    expect(hit.snippet.text).toContain('Cấu hình');
    expect(hit.snippet.ranges.length).toBe(2);
    expect(hit.snippet.text.slice(hit.snippet.ranges[0]?.[0] ?? 0, hit.snippet.ranges[0]?.[1] ?? 0)).toBe('Cấu');
    expect(hit.snippet.text.slice(hit.snippet.ranges[1]?.[0] ?? 0, hit.snippet.ranges[1]?.[1] ?? 0)).toBe('hình');
  });

  it('never overlaps or leaves the string', () => {
    const body = 'alpha alpha alphabetic beta alpha';
    const snippet = snippetFor(body, tokenize(normalizeForSearch(body)).filter((term) => term.token === 'alpha'));
    for (const [from, to] of snippet.ranges) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThanOrEqual(snippet.text.length);
    }
    const sorted = [...snippet.ranges].sort((left, right) => left[0] - right[0]);
    sorted.forEach((range, position) => {
      const previous = sorted[position - 1];
      if (previous !== undefined) expect(range[0]).toBeGreaterThan(previous[1]);
    });
  });

  it('falls back to the start of the page with no ranges when the term is not in the body', () => {
    const snippet = snippetFor('nothing relevant here', [{ token: 'zebra', start: 0 }]);
    expect(snippet.ranges).toEqual([]);
    expect(snippet.text).toContain('nothing');
  });

  it('ellipsises both ends of a long page', () => {
    const body = `${'filler '.repeat(40)}needle ${'tail '.repeat(40)}`;
    const snippet = snippetFor(body, [{ token: 'needle', start: 0 }]);
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    const [range] = snippet.ranges;
    expect(range).toBeDefined();
    expect(snippet.text.slice(range?.[0] ?? 0, range?.[1] ?? 0)).toBe('needle');
  });
});

describe('blocksToPlainText', () => {
  it('covers every block type so nothing is unsearchable', () => {
    const blocks: DocBlock[] = [
      { type: 'heading', level: 2, id: 'a', text: 'Heading' },
      { type: 'paragraph', inlines: [{ type: 'text', text: 'Paragraph ' }, { type: 'link', text: 'label', href: '/x', internal: true }] },
      { type: 'list', ordered: true, items: [[{ type: 'paragraph', inlines: [{ type: 'text', text: 'Step one' }] }]] },
      { type: 'code', language: null, code: 'pnpm build' },
      { type: 'callout', variant: 'note', blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: 'Callout text' }] }] },
      { type: 'table', align: [null], head: [[{ type: 'text', text: 'Column' }]], rows: [[[{ type: 'text', text: 'Cell' }]]] },
      { type: 'image', src: '/docs-assets/a.png', alt: 'Alt text', caption: 'Caption text' },
      { type: 'divider' },
    ];
    const plain = blocksToPlainText(blocks);
    for (const needle of ['Heading', 'Paragraph label', 'Step one', 'pnpm build', 'Callout text', 'Column', 'Cell', 'Alt text', 'Caption text']) {
      expect(plain).toContain(needle);
    }
  });
});

describe('buildTokens', () => {
  it('records one posting per page and field with every position', () => {
    const shaped = buildIndex(
      [
        { path: 'content/docs/en/admin/_index.md', content: '---\ntitle: Admin\nsummary: a\naudience: admin\norder: 1\n---\n' },
        page('admin', 'repeats', 'Repeat repeat', 'repeat again repeat'),
      ],
      { locale: 'en' },
    );
    const postings = shaped.tokens.get('repeat');
    const title = postings?.find((posting) => posting.field === 'title');
    const body = postings?.find((posting) => posting.field === 'body');
    expect(title?.positions).toHaveLength(2);
    expect(body?.positions).toHaveLength(2);
    expect(buildTokens([...shaped.pages.values()], shaped.plainText).size).toBe(shaped.tokens.size);
  });

  it('does not index a one-letter word', () => {
    expect(index().tokens.has('a')).toBe(false);
  });
});
