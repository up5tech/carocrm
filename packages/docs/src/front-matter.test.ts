import { describe, expect, it } from 'vitest';

import { parseYamlSubset, readFrontMatter, splitFrontMatter } from './front-matter.js';

const VALID = `---
title: Main menu
summary: Enable, rename, reorder and group the entries in the sidebar.
audience: admin
order: 30
tags: [menu, navigation, sidebar]
requires: { entity: Team, action: read }
related: [admin/settings-overview, reference/glossary]
updated: 2026-10-21
---

## Body
`;

describe('readFrontMatter', () => {
  it('reads every supported field with its defaults', () => {
    const result = readFrontMatter(VALID);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.data).toEqual({
      title: 'Main menu',
      summary: 'Enable, rename, reorder and group the entries in the sidebar.',
      audience: 'admin',
      order: 30,
      tags: ['menu', 'navigation', 'sidebar'],
      aliases: [],
      requires: { entity: 'Team', action: 'read' },
      related: ['admin/settings-overview', 'reference/glossary'],
      updated: '2026-10-21',
    });
    expect(result.body).toBe('\n## Body\n');
  });

  it('defaults the optional fields instead of inventing values', () => {
    const result = readFrontMatter('---\ntitle: Sign in\nsummary: How to get in.\naudience: user\norder: 10\n---\n');
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.data.tags).toEqual([]);
    expect(result.data.aliases).toEqual([]);
    expect(result.data.requires).toBeNull();
    expect(result.data.related).toEqual([]);
    expect(result.data.updated).toBeNull();
  });

  it('keeps a quoted value verbatim, including one that looks like a number', () => {
    const result = readFrontMatter('---\ntitle: "Sign in"\nsummary: "10 things"\naudience: user\norder: 1\n---\n');
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.data.summary).toBe('10 things');
  });

  it('rejects a missing required field and names it', () => {
    const result = readFrontMatter('---\ntitle: Sign in\naudience: user\norder: 1\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain('summary: Required');
  });

  it('treats an unknown key as an error, not a warning', () => {
    const result = readFrontMatter('---\ntitle: Sign in\nsummary: Getting in.\naudiance: user\norder: 1\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownKeys).toEqual(['audiance']);
    expect(result.issues.join(' ')).toContain('unknown front-matter key: audiance');
  });

  it('rejects a wrong type', () => {
    const result = readFrontMatter('---\ntitle: Sign in\nsummary: Getting in.\naudience: staff\norder: 1\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toContain('audience');
  });

  it('rejects a negative, fractional or string order', () => {
    for (const order of ['-1', '1.5', '"30"']) {
      expect(readFrontMatter(`---\ntitle: T\nsummary: S\naudience: user\norder: ${order}\n---\n`).ok).toBe(false);
    }
  });

  it('rejects an impossible date and a non-ISO date', () => {
    for (const updated of ['2026-02-30', '21/10/2026', '2026-10']) {
      const result = readFrontMatter(`---\ntitle: T\nsummary: S\naudience: user\norder: 1\nupdated: ${updated}\n---\n`);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects an uppercase tag', () => {
    const result = readFrontMatter('---\ntitle: T\nsummary: S\naudience: user\norder: 1\ntags: [Menu]\n---\n');
    expect(result.ok).toBe(false);
  });

  it('rejects a title that ends with a period', () => {
    const result = readFrontMatter('---\ntitle: Sign in.\nsummary: S\naudience: user\norder: 1\n---\n');
    expect(result.ok).toBe(false);
  });

  it('reports a page with no front-matter instead of parsing it as prose', () => {
    const result = readFrontMatter('# Just a heading\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toContain('does not start with a `---`');
  });

  it('reports an unclosed front-matter block', () => {
    expect(readFrontMatter('---\ntitle: T\n').ok).toBe(false);
  });

  it('survives CRLF line endings and a leading BOM', () => {
    const result = readFrontMatter(`\uFEFF---\r\ntitle: Sign in\r\nsummary: Getting in.\r\naudience: user\r\norder: 1\r\n---\r\n\r\nBody\r\n`);
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.data.title).toBe('Sign in');
    expect(result.body).toBe('\nBody\n');
  });
});

describe('splitFrontMatter', () => {
  it('accepts the `...` terminator as well as `---`', () => {
    const split = splitFrontMatter('---\ntitle: T\n...\nbody');
    if ('error' in split) throw new Error(split.error);
    expect(split.yaml).toBe('title: T');
    expect(split.body).toBe('body');
  });
});

describe('parseYamlSubset', () => {
  it('reads scalars, arrays and inline maps', () => {
    const { value, errors } = parseYamlSubset('title: Main menu\norder: 30\ndraft: true\nnothing: null\ntags: [a, b]\nrequires: { entity: Team, action: read }');
    expect(errors).toEqual([]);
    expect(value).toEqual({
      title: 'Main menu',
      order: 30,
      draft: true,
      nothing: null,
      tags: ['a', 'b'],
      requires: { entity: 'Team', action: 'read' },
    });
  });

  it('reads an empty inline array and map', () => {
    const { value } = parseYamlSubset('tags: []\nrequires: {}');
    expect(value.tags).toEqual([]);
    expect(value.requires).toEqual({});
  });

  it('ignores blank lines and comments', () => {
    const { value, errors } = parseYamlSubset('\n# a comment\ntitle: T\n');
    expect(errors).toEqual([]);
    expect(Object.keys(value)).toEqual(['title']);
  });

  it('refuses a line that is not `key: value` rather than skipping it', () => {
    const { errors } = parseYamlSubset('- first\n- second');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('line 1');
  });

  it('refuses a nested block, which the subset does not support', () => {
    const { errors } = parseYamlSubset('requires:\n  entity: Team');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('line 1');
  });

  it('reports an unterminated array or map', () => {
    expect(parseYamlSubset('tags: [a, b').errors[0]).toContain('unterminated inline array');
    expect(parseYamlSubset('requires: { entity: Team').errors[0]).toContain('unterminated inline map');
  });

  it('keeps a comma inside quotes as one value', () => {
    const { value } = parseYamlSubset('tags: ["a,b", c]');
    expect(value.tags).toEqual(['a,b', 'c']);
  });

  it('reads Vietnamese aliases', () => {
    const result = readFrontMatter(
      '---\ntitle: Quotes\nsummary: How to price a deal.\naudience: user\norder: 10\naliases: ["báo giá", "tạo báo giá"]\n---\n',
    );
    if (!result.ok) throw new Error(result.issues.join('; '));
    expect(result.data.aliases).toEqual(['báo giá', 'tạo báo giá']);
  });

  it('rejects an alias that is not a search phrase', () => {
    const result = readFrontMatter(`---\ntitle: Quotes\nsummary: How to price a deal.\naudience: user\norder: 10\naliases: ["${'a'.repeat(61)}"]\n---\n`);
    expect(result.ok).toBe(false);
  });
});
