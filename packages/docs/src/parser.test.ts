import { describe, expect, it } from 'vitest';

import { parseInlines, parseMarkdown, type ParserIssueCode } from './parser.js';
import type { DocBlock } from './types.js';

/** `parseMarkdown` restricted to its blocks, which is what almost every assertion here wants. */
function blocks(body: string): readonly DocBlock[] {
  return parseMarkdown(body).blocks;
}

function codes(body: string): ParserIssueCode[] {
  return parseMarkdown(body).issues.map((issue) => issue.code);
}

describe('paragraphs and headings', () => {
  it('joins the lines of one paragraph and splits on a blank line', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: 'one two' }] },
      { type: 'paragraph', inlines: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('gives every heading an id and keeps h2 and h3 distinct from h4', () => {
    const parsed = blocks('## Enable an entry\n### Rename\n#### Deep\n');
    expect(parsed).toEqual([
      { type: 'heading', level: 2, id: 'enable-an-entry', text: 'Enable an entry' },
      { type: 'heading', level: 3, id: 'rename', text: 'Rename' },
      { type: 'heading', level: 4, id: 'deep', text: 'Deep' },
    ]);
  });

  it('refuses `#` and level five or deeper, and says why', () => {
    expect(codes('# Title')).toEqual(['h1Reserved']);
    expect(blocks('# Title')).toEqual([{ type: 'paragraph', inlines: [{ type: 'text', text: '# Title' }] }]);
    expect(codes('##### Too deep')).toEqual(['headingTooDeep']);
  });

  it('de-duplicates a repeated heading inside the page', () => {
    const parsed = blocks('## Steps\n\n## Steps');
    expect(parsed.map((block) => (block.type === 'heading' ? block.id : '?'))).toEqual(['steps', 'steps-2']);
  });

  it('slugifies a Vietnamese heading', () => {
    expect(blocks('## Cấu hình menu')[0]).toEqual({ type: 'heading', level: 2, id: 'cau-hinh-menu', text: 'Cấu hình menu' });
  });
});

describe('inlines', () => {
  it('parses strong, em, code and their text around them', () => {
    const parsed = parseInlines('Press **Save** then *Cancel* or `Ctrl+K` now');
    expect(parsed).toEqual([
      { type: 'text', text: 'Press ' },
      { type: 'strong', text: 'Save' },
      { type: 'text', text: ' then ' },
      { type: 'em', text: 'Cancel' },
      { type: 'text', text: ' or ' },
      { type: 'code', text: 'Ctrl+K' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('does not support the __ or _ forms', () => {
    expect(parseInlines('__bold__ and _italic_')).toEqual([{ type: 'text', text: '__bold__ and _italic_' }]);
  });

  it('keeps emphasis inside code literal', () => {
    expect(parseInlines('`**not bold**`')).toEqual([{ type: 'code', text: '**not bold**' }]);
  });

  it('classifies a doc link as internal and an https link as external', () => {
    expect(parseInlines('[Main menu](admin/main-menu)')).toEqual([
      { type: 'link', text: 'Main menu', href: 'admin/main-menu', internal: true },
    ]);
    expect(parseInlines('[docs](https://example.com/a)')).toEqual([
      { type: 'link', text: 'docs', href: 'https://example.com/a', internal: false },
    ]);
    expect(parseInlines('[Settings](/admin/settings/menu)')).toEqual([
      { type: 'link', text: 'Settings', href: '/admin/settings/menu', internal: true },
    ]);
  });

  it('refuses a javascript: href and renders no link', () => {
    const parsed = parseMarkdown('[click](javascript:alert(1))');
    expect(parsed.blocks).toEqual([{ type: 'paragraph', inlines: [{ type: 'text', text: 'click)' }] }]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['unsafeHref']);
  });

  it('reports an unclosed emphasis or code span instead of eating the rest of the page', () => {
    expect(codes('a **b and `c')).toContain('unclosedInline');
  });

  it('leaves a stray bracket as literal text', () => {
    expect(parseInlines('use [ for arrays')).toEqual([{ type: 'text', text: 'use [ for arrays' }]);
  });

  it('escapes raw HTML into text and reports it', () => {
    const parsed = parseMarkdown('before <script>alert(1)</script> after');
    expect(parsed.blocks).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: 'before <script>alert(1)</script> after' }] },
    ]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['rawHtml']);
  });
});

describe('lists', () => {
  it('parses an unordered list, keeping ordered and unordered distinct', () => {
    expect(blocks('- one\n- two')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'paragraph', inlines: [{ type: 'text', text: 'one' }] }],
          [{ type: 'paragraph', inlines: [{ type: 'text', text: 'two' }] }],
        ],
      },
    ]);
    const ordered = blocks('1. one\n2. two');
    expect(ordered[0]).toMatchObject({ type: 'list', ordered: true });
  });

  it('nests one level and reports a third', () => {
    const parsed = parseMarkdown('- a\n  - b\n    - c');
    expect(parsed.blocks[0]).toMatchObject({ type: 'list', items: [[{ type: 'paragraph' }, { type: 'list' }]] });
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['listTooDeep']);
  });

  it('continues an item onto an indented following line', () => {
    expect(blocks('- open **Settings**\n  then pick Menu')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'paragraph', inlines: [{ type: 'text', text: 'open ' }, { type: 'strong', text: 'Settings' }, { type: 'text', text: ' then pick Menu' }] }]],
      },
    ]);
  });

  it('stops at a following heading rather than swallowing it', () => {
    expect(blocks('- a\n\n## Next')[1]).toMatchObject({ type: 'heading', text: 'Next' });
  });
});

describe('tables', () => {
  it('parses head, separator alignment and rows', () => {
    expect(blocks('| Key | Value |\n| :- | -: |\n| a | 1 |\n| b | 2 |')).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        head: [
          [{ type: 'text', text: 'Key' }],
          [{ type: 'text', text: 'Value' }],
        ],
        rows: [
          [
            [{ type: 'text', text: 'a' }],
            [{ type: 'text', text: '1' }],
          ],
          [
            [{ type: 'text', text: 'b' }],
            [{ type: 'text', text: '2' }],
          ],
        ],
      },
    ]);
  });

  it('gives null alignment when the separator has no colons', () => {
    const parsed = blocks('| a |\n| --- |');
    expect(parsed[0]).toMatchObject({ type: 'table', align: [null] });
  });

  it('reports a short row and pads it rather than rendering a broken grid', () => {
    const parsed = parseMarkdown('| a | b |\n| --- | --- |\n| only |');
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['tableRowWidth']);
    expect(parsed.blocks[0]).toMatchObject({
      type: 'table',
      rows: [[[{ type: 'text', text: 'only' }], [{ type: 'text', text: '' }]]],
    });
  });

  it('treats a pipe in ordinary prose as a paragraph, not a table', () => {
    expect(blocks('a | b')).toEqual([{ type: 'paragraph', inlines: [{ type: 'text', text: 'a | b' }] }]);
  });

  it('keeps an escaped pipe inside a cell', () => {
    const parsed = blocks('| a | b |\n| --- | --- |\n| x \\| y | z |');
    expect(parsed[0]).toMatchObject({
      type: 'table',
      rows: [[[{ type: 'text', text: 'x | y' }], [{ type: 'text', text: 'z' }]]],
    });
  });
});

describe('code fences, callouts, images and dividers', () => {
  it('captures a fenced block with and without a language', () => {
    expect(blocks('```bash\npnpm build\n```')).toEqual([{ type: 'code', language: 'bash', code: 'pnpm build' }]);
    expect(blocks('```\nplain\n```')).toEqual([{ type: 'code', language: null, code: 'plain' }]);
  });

  it('reports an unclosed fence and still returns its content', () => {
    const parsed = parseMarkdown('```\nnever closed');
    expect(parsed.blocks).toEqual([{ type: 'code', language: null, code: 'never closed' }]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['unclosedFence']);
  });

  it('never executes a fence: markdown inside it stays code', () => {
    expect(blocks('```md\n## not a heading\n```')).toEqual([{ type: 'code', language: 'md', code: '## not a heading' }]);
  });

  it('parses the four callout variants with their inner blocks', () => {
    for (const [marker, variant] of [
      ['NOTE', 'note'],
      ['TIP', 'tip'],
      ['WARNING', 'warning'],
      ['DANGER', 'danger'],
    ] as const) {
      expect(blocks(`> [!${marker}]\n> Reordering applies to every role.`)).toEqual([
        {
          type: 'callout',
          variant,
          blocks: [{ type: 'paragraph', inlines: [{ type: 'text', text: 'Reordering applies to every role.' }] }],
        },
      ]);
    }
  });

  it('refuses an unknown callout type and a plain blockquote', () => {
    expect(codes('> [!HINT]\n> something')).toEqual(['unknownCallout']);
    expect(codes('> someone said this')).toEqual(['blockquoteNotCallout']);
  });

  it('parses a standalone image with its caption', () => {
    expect(blocks('![The main menu tab](/docs-assets/menu.png "The menu tab")')).toEqual([
      { type: 'image', src: '/docs-assets/menu.png', alt: 'The main menu tab', caption: 'The menu tab' },
    ]);
  });

  it('requires alt text and a local asset path', () => {
    expect(codes('![](/docs-assets/x.png)')).toEqual(['missingAlt']);
    expect(codes('![alt](https://cdn.example.com/x.png)')).toEqual(['assetNotLocal']);
    expect(codes('text ![inline](/docs-assets/x.png) more')).toContain('imageNotAlone');
  });

  it('reads a divider on its own line', () => {
    expect(blocks('---')).toEqual([{ type: 'divider' }]);
  });
});

describe('input hygiene', () => {
  it('survives CRLF and a BOM', () => {
    expect(parseMarkdown('﻿# Title\r\n\r\nBody text\r\n').blocks).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: '# Title' }] },
      { type: 'paragraph', inlines: [{ type: 'text', text: 'Body text' }] },
    ]);
  });

  it('keeps Vietnamese text intact', () => {
    expect(parseInlines('Mọi thứ bạn cấu hình nằm ở đây')).toEqual([{ type: 'text', text: 'Mọi thứ bạn cấu hình nằm ở đây' }]);
  });

  it('returns no blocks for an empty body rather than an empty paragraph', () => {
    expect(blocks('')).toEqual([]);
    expect(blocks('\n\n')).toEqual([]);
  });

  it('does not hang on pathological input', () => {
    expect(() => parseMarkdown('*****[[]](```')).not.toThrow();
    expect(() => parseMarkdown('![![![]]')).not.toThrow();
  });
});
