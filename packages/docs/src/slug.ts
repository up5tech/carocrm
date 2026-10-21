/**
 * Identifiers: URL slugs and heading anchors.
 *
 * A slug is a permalink (`PLAN_Phase_21_Documentation.md` §4.1 rule 2), so the transformation that
 * produces one has to be boring and stable. The one thing that is *not* obvious is Vietnamese:
 * `Cấu hình` must become `cau-hinh`, both because a reader can type an accented anchor more easily
 * than a percent-encoded one and because the search index has to agree with the anchor about what a
 * word is. `NFD` + a combining-mark strip does the accented vowels; `đ` is a letter rather than a
 * composed one and does not decompose, so it needs its own replacement.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

export function stripDiacritics(text: string): string {
  return text
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .normalize('NFC');
}

/** Lowercase, ASCII-only, hyphen-joined. Returns `''` when nothing is left to slug. */
export function slugify(text: string): string {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The `id` for one heading, made unique inside the page. Two headings with the same text are a real
 * thing in procedure pages ("Steps" appears twice), and a duplicated `id` would silently break the
 * anchor and the table of contents, so the collision is resolved by suffix rather than by chance.
 */
export function headingId(text: string, used: Set<string>): string {
  const base = slugify(text) || 'section';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** `01-lists-and-views.md` → `lists-and-views`. The `NN-` prefix is ordering, not part of the slug. */
export function slugFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.md$/i, '');
  return withoutExtension.replace(/^\d+-/, '');
}

export function pageKey(section: string, slug: string): string {
  return `${section}/${slug}`;
}

/** The URL-safe shape every section key, slug and redirect segment must have (§4.1 rule 2). */
export function isUrlKey(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value);
}
