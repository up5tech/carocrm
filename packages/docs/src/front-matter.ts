/**
 * The front-matter contract (`PLAN_Phase_21_Documentation.md` §4.2).
 *
 * A deliberately small YAML subset is parsed here instead of pulling in a YAML library: the corpus
 * needs scalars, one-level inline maps and inline arrays, and nothing else. That narrowness is the
 * point — a block sequence or a nested map is *refused* rather than silently misread, so a page
 * cannot half-parse into something whose `audience` the reader guessed wrong.
 *
 * Unknown keys are an error, not a warning: a typo in `audiance` would otherwise produce a page with
 * no audience that no filter can show.
 */

import { z } from 'zod';

import type { DocFrontMatter, YamlValue } from './types.js';

const FRONT_MATTER_KEYS = ['title', 'summary', 'audience', 'order', 'tags', 'aliases', 'requires', 'related', 'updated'] as const;

/**
 * `Date.parse` is not a calendar check here: V8 rolls `2026-02-30` over to 2 March instead of calling
 * it invalid, so the round trip is compared against the components the author wrote.
 */
function isRealIsoDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const DocFrontMatterSchema = z
  .object({
    title: z.string().min(1).max(80).refine((value) => !value.endsWith('.'), 'title must not end with a period'),
    summary: z.string().min(1).max(160),
    audience: z.enum(['user', 'admin']),
    order: z.number().int().nonnegative(),
    tags: z.array(z.string().regex(/^[a-z0-9-]+$/, 'tags must be lowercase tokens')).default([]),
    /**
     * Search phrases a reader would type for this page, in any language. `tags` are machine-shaped
     * tokens; an alias is prose (`báo cáo bán hàng`), which is how a Vietnamese question reaches a page
     * that has not been translated yet. Indexed with the tag weight, never shown as a label.
     */
    aliases: z.array(z.string().trim().min(2).max(60)).default([]),
    requires: z
      .object({
        entity: z.string().min(1),
        action: z.string().min(1),
      })
      .nullable()
      .default(null),
    related: z.array(z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/, 'related entries must be section/slug')).default([]),
    updated: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'updated must be an ISO date')
      .refine(isRealIsoDate, 'updated must be a real date')
      .nullable()
      .default(null),
  })
  .strict();

export type FrontMatterResult =
  | { readonly ok: true; readonly data: DocFrontMatter; readonly body: string }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
      readonly unknownKeys: readonly string[];
      readonly body: string;
    };

/**
 * Splits the leading `---` block from the body. A file with no front-matter is a failure rather than
 * an empty document: every page has to declare its audience, and a page that cannot be placed in the
 * tree should not render.
 */
export function splitFrontMatter(source: string): { readonly yaml: string; readonly body: string } | { readonly error: string } {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { error: 'page does not start with a `---` front-matter block' };
  const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  if (end === -1) return { error: 'front-matter block is not closed' };
  return { yaml: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/**
 * Parses the supported YAML subset into plain values. Every line is `key: value`; anything else is
 * reported rather than skipped, because a silently dropped line is how a page ends up undocumented.
 */
export function parseYamlSubset(yaml: string): { readonly value: Record<string, YamlValue>; readonly errors: readonly string[] } {
  const value: Record<string, YamlValue> = {};
  const errors: string[] = [];
  for (const [index, rawLine] of yaml.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      errors.push(`line ${String(index + 1)}: expected \`key: value\`, found ${JSON.stringify(rawLine)}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      errors.push(`line ${String(index + 1)}: ${JSON.stringify(key)} is not a valid front-matter key`);
      continue;
    }
    const rawValue = line.slice(separator + 1).trim();
    if (rawValue === '') {
      errors.push(`line ${String(index + 1)}: \`${key}\` has no inline value; this subset does not support block maps or sequences`);
      continue;
    }
    const parsed = parseScalar(rawValue);
    if ('error' in parsed) {
      errors.push(`line ${String(index + 1)}: ${parsed.error}`);
      continue;
    }
    value[key] = parsed.value;
  }
  return { value, errors };
}

type ScalarResult = { readonly value: YamlValue } | { readonly error: string };

/** Scalars, inline arrays (`[a, b]`) and one-level inline maps (`{ entity: Team, action: read }`). */
function parseScalar(raw: string): ScalarResult {
  if (raw === 'null' || raw === '~') return { value: null };
  if (raw.startsWith('[')) return parseInlineArray(raw);
  if (raw.startsWith('{')) return parseInlineMap(raw);
  return { value: parsePlainScalar(raw) };
}

function parsePlainScalar(raw: string): string | number | boolean {
  const quote = raw.charAt(0);
  if ((quote === '"' || quote === "'") && raw.length >= 2 && raw.charAt(raw.length - 1) === quote) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Splits on commas that are not inside quotes or a nested bracket. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseInlineArray(raw: string): ScalarResult {
  if (!raw.endsWith(']')) return { error: `unterminated inline array ${JSON.stringify(raw)}` };
  return { value: splitTopLevel(raw.slice(1, -1)).map((item) => parsePlainScalar(item)) };
}

function parseInlineMap(raw: string): ScalarResult {
  if (!raw.endsWith('}')) return { error: `unterminated inline map ${JSON.stringify(raw)}` };
  const map: Record<string, YamlValue> = {};
  for (const part of splitTopLevel(raw.slice(1, -1))) {
    const separator = part.indexOf(':');
    if (separator <= 0) return { error: `inline map entry ${JSON.stringify(part)} is not \`key: value\`` };
    map[part.slice(0, separator).trim()] = parsePlainScalar(part.slice(separator + 1).trim());
  }
  return { value: map };
}

/** Validates a whole page body and returns the typed front-matter, or the reasons it cannot be used. */
export function readFrontMatter(source: string): FrontMatterResult {
  const split = splitFrontMatter(source);
  if ('error' in split) return { ok: false, issues: [split.error], unknownKeys: [], body: '' };

  const { value, errors } = parseYamlSubset(split.yaml);
  const unknownKeys = Object.keys(value).filter((key) => !FRONT_MATTER_KEYS.includes(key as (typeof FRONT_MATTER_KEYS)[number]));
  const issues = [...errors];

  const parsed = DocFrontMatterSchema.safeParse(value);
  if (unknownKeys.length > 0) {
    issues.push(`unknown front-matter ${unknownKeys.length === 1 ? 'key' : 'keys'}: ${unknownKeys.join(', ')}`);
    return { ok: false, issues: dedupe(issues), unknownKeys, body: split.body };
  }

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      issues.push(`${path === '' ? 'front-matter' : path}: ${issue.message}`);
    }
    return { ok: false, issues: dedupe(issues), unknownKeys, body: split.body };
  }

  return { ok: true, data: parsed.data, body: split.body };
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}
