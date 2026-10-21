import { describe, expect, it } from 'vitest';

import { headingId, isUrlKey, pageKey, slugFromFileName, slugify, stripDiacritics } from './slug.js';

/**
 * Slugs are permalinks, so this file is the one place that decides what a reader types into a URL.
 * The Vietnamese cases are not decoration: the corpus is bilingual and an anchor built from
 * `Cấu hình` has to come out as `cau-hinh` for the anchor, the TOC and the search index to agree.
 */
describe('stripDiacritics', () => {
  it('removes composed marks', () => {
    expect(stripDiacritics('Cấu hình')).toBe('Cau hinh');
    expect(stripDiacritics('Đăng nhập')).toBe('Dang nhap');
  });

  it('replaces đ, which is a letter and does not decompose', () => {
    expect(stripDiacritics('điều')).toBe('dieu');
    expect(stripDiacritics('Đà Nẵng')).toBe('Da Nang');
  });

  it('leaves plain ASCII and non-Latin text alone', () => {
    expect(stripDiacritics('Main menu 2')).toBe('Main menu 2');
    expect(stripDiacritics('日本語')).toBe('日本語');
  });
});

describe('slugify', () => {
  it('lowercases and hyphen-joins', () => {
    expect(slugify('Working with lists')).toBe('working-with-lists');
    expect(slugify('Cấu hình main menu!')).toBe('cau-hinh-main-menu');
  });

  it('collapses runs of punctuation and trims edges', () => {
    expect(slugify('  What -- can  go ## wrong?  ')).toBe('what-can-go-wrong');
    expect(slugify("What's next")).toBe('whats-next');
  });

  it('drops anything that is not ASCII alphanumeric', () => {
    expect(slugify('日本語のタイトル')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('headingId', () => {
  it('de-duplicates within a page by numeric suffix', () => {
    const used = new Set<string>();
    expect(headingId('Steps', used)).toBe('steps');
    expect(headingId('Steps', used)).toBe('steps-2');
    expect(headingId('Steps', used)).toBe('steps-3');
  });

  it('falls back to a stable id when the text has nothing slugable', () => {
    const used = new Set<string>();
    expect(headingId('***', used)).toBe('section');
    expect(headingId('***', used)).toBe('section-2');
  });
});

describe('slugFromFileName', () => {
  it('strips the extension and the ordering prefix', () => {
    expect(slugFromFileName('01-lists-and-views.md')).toBe('lists-and-views');
    expect(slugFromFileName('sign-in.md')).toBe('sign-in');
    expect(slugFromFileName('_index.md')).toBe('_index');
    expect(slugFromFileName('100-something.MD')).toBe('something');
  });
});

describe('pageKey / isUrlKey', () => {
  it('joins a section and a slug', () => {
    expect(pageKey('admin', 'main-menu')).toBe('admin/main-menu');
  });

  it('accepts only lowercase, hyphenated, letter-initial keys', () => {
    expect(isUrlKey('main-menu')).toBe(true);
    expect(isUrlKey('a1')).toBe(true);
    expect(isUrlKey('Main-menu')).toBe(false);
    expect(isUrlKey('1-menu')).toBe(false);
    expect(isUrlKey('-menu')).toBe(false);
    expect(isUrlKey('main_menu')).toBe(false);
    expect(isUrlKey('')).toBe(false);
  });
});
