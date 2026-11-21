import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Phase 25.12 — the AI capability review's own evidence check
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §18 task 2).
 *
 * The canonical matrix (`docs/architecture/ai-capability-matrix.md`) is the single source of every AI
 * parity claim, and a claim is only as good as the path it points at. This suite is the mechanical half
 * of the 25.12 review: it reads every path/line citation in the matrix and proves that the file still
 * exists and that the cited line still lands inside it.
 *
 * It is **DB-free and network-free** by construction, so it runs in the scheduled nightly lane — the same
 * lane as the 25.11 golden gate. A citation that drifts (a renamed file, an anchor that moved past the end
 * of a file) fails the gate instead of quietly becoming a claim nobody can trace.
 *
 * What it does **not** do: run the suites the matrix cites, or judge whether the claim is true. It proves
 * the claim is *reachable*; `docs/quality/phase-25-release-review.md` §5 records which rows are Verified,
 * which are Source-verified, and which are Partial.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MATRIX = join(ROOT, 'docs/architecture/ai-capability-matrix.md');
const REVIEW = join(ROOT, 'docs/quality/phase-25-release-review.md');
const RELEASE_NOTE = join(ROOT, 'docs/releases/2026-11-21-phase-25.md');

/** The directories a citation may point into. */
const SCAN_ROOTS = [
  'apps/api/src',
  'apps/api/test',
  'apps/web/src',
  'apps/worker/src',
  'packages',
  'docs',
  'api-spec',
  'plans',
  'modules',
  'scripts',
];

/** Module-relative roots, so a citation like `runs/triggers.ts` still resolves. */
const MODULE_ROOTS = [
  'apps/api/src/ai-agents',
  'apps/api/src/crm-chat',
  'apps/api/src',
  'apps/worker/src',
  'packages/workflow/src',
];

/** A citation is a token that ends in a source or document extension. */
const CITATION = /^[\w][\w./-]*\.(?:ts|tsx|md|yaml|yml|json|mjs|sql)$/;

interface Citation {
  /** The token as it appears in the document. */
  readonly token: string;
  /** The file part, without the line suffix. */
  readonly file: string;
  /** The line suffix: `12`, `12-40`, `12,34` or empty. */
  readonly lines: string;
}

function scanFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
      const full = join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(full);
    }
  };
  for (const root of SCAN_ROOTS) {
    const full = join(ROOT, root);
    if (existsSync(full)) walk(full);
  }
  return found;
}

const ALL_FILES = scanFiles();
const BY_BASENAME = new Map<string, string[]>();
for (const file of ALL_FILES) {
  const name = basename(file);
  const list = BY_BASENAME.get(name) ?? [];
  list.push(relative(ROOT, file));
  BY_BASENAME.set(name, list);
}

/** Every path/line citation in a document, in the order it appears. */
function citationsOf(document: string): Citation[] {
  const found: Citation[] = [];
  const token = /`([^`]+)`/g;
  let match = token.exec(document);
  while (match !== null) {
    const raw = match[1] ?? '';
    match = token.exec(document);
    if (raw.startsWith('http://') || raw.startsWith('https://')) continue;
    const colon = raw.lastIndexOf(':');
    let file = raw;
    let lines = '';
    if (colon > 0 && /^[\d,\-]+$/.test(raw.slice(colon + 1))) {
      file = raw.slice(0, colon);
      lines = raw.slice(colon + 1);
    }
    if (!CITATION.test(file)) continue;
    found.push({ token: raw, file, lines });
  }
  return found;
}

/** Where a cited file lives, or `null` when the citation cannot be resolved. */
function resolveCitation(file: string): string | null {
  if (file.includes('/')) {
    if (existsSync(join(ROOT, file))) return file;
    for (const root of MODULE_ROOTS) {
      const candidate = `${root}/${file}`;
      if (existsSync(join(ROOT, candidate))) return candidate;
    }
    return null;
  }
  const hits = BY_BASENAME.get(file) ?? [];
  if (hits.length === 1) return hits[0] ?? null;
  return null;
}

/** The line numbers a citation names. */
function citedLines(spec: string): number[] {
  const numbers: number[] = [];
  for (const part of spec.split(',')) {
    const range = part.split('-').map((value) => Number(value));
    if (range.length === 2 && range[0] !== undefined && range[1] !== undefined) {
      for (let line = range[0]; line <= range[1]; line += 1) numbers.push(line);
    } else if (range[0] !== undefined) {
      numbers.push(range[0]);
    }
  }
  return numbers;
}

const matrix = readFileSync(MATRIX, 'utf8');
const matrixCitations = citationsOf(matrix);

describe('the AI capability matrix is traceable (25.12)', () => {
  it('has every axis the review verifies', () => {
    const rows = matrix
      .split('\n')
      .map((line) => /^\| (\d+) \|/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number(value));
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('cites at least one path per axis', () => {
    expect(matrixCitations.length).toBeGreaterThan(50);
  });

  it('resolves every cited path', () => {
    const unresolved = matrixCitations
      .map((citation) => ({ citation, resolved: resolveCitation(citation.file) }))
      .filter((entry) => entry.resolved === null)
      .map((entry) => entry.citation.token);
    expect(unresolved, `unresolved citations: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('cites a line that still exists in the file it points at', () => {
    const stale: string[] = [];
    for (const citation of matrixCitations) {
      if (citation.lines === '') continue;
      const resolved = resolveCitation(citation.file);
      if (resolved === null) continue;
      const lines = readFileSync(join(ROOT, resolved), 'utf8').split('\n');
      for (const line of citedLines(citation.lines)) {
        if (line < 1 || line > lines.length) {
          stale.push(`${citation.token} → ${resolved} has ${String(lines.length)} lines`);
        }
      }
    }
    expect(stale, `stale line citations: ${stale.join(' | ')}`).toEqual([]);
  });

  it('lands a single-line citation on a line that says something', () => {
    const blank: string[] = [];
    for (const citation of matrixCitations) {
      if (citation.lines === '' || citation.lines.includes('-') || citation.lines.includes(',')) continue;
      const resolved = resolveCitation(citation.file);
      if (resolved === null) continue;
      const lines = readFileSync(join(ROOT, resolved), 'utf8').split('\n');
      const line = lines[Number(citation.lines) - 1];
      if (line === undefined || line.trim() === '') blank.push(`${citation.token} → ${resolved}`);
    }
    expect(blank, `citations that point at a blank line: ${blank.join(' | ')}`).toEqual([]);
  });
});

describe('the AI release review exists and decides honestly (25.12)', () => {
  it('records the decision, its scope and its limits', () => {
    expect(existsSync(REVIEW)).toBe(true);
    const review = readFileSync(REVIEW, 'utf8');
    expect(review).toContain('GO for alpha/pilot');
    expect(review).toContain('NO-GO for production');
    expect(review).toContain('docs/architecture/ai-capability-matrix.md');
    // The review must not claim a production readiness it did not earn. `NO-GO for production`
    // is the only production decision the review may contain.
    expect(review).not.toMatch(/(?<!NO-)GO for production/);
  });

  it('names the open production gate rather than ignoring it', () => {
    const review = readFileSync(REVIEW, 'utf8');
    expect(review).toContain('phase-24-12-release-review.md');
    expect(review).toContain('phase-23-security-release-review.md');
  });

  it('publishes the release note', () => {
    expect(existsSync(RELEASE_NOTE)).toBe(true);
    const note = readFileSync(RELEASE_NOTE, 'utf8');
    expect(note).toContain('NO-GO for production');
    expect(note).toContain('alpha/pilot');
  });
});
