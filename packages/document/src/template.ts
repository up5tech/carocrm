/**
 * @carocrm/document — the template engine.
 *
 * The kernel needs one way to turn a record into a document, and the commercial modules (Sales
 * quotes, orders, invoices; later Purchases) need it to be predictable: the same template and the same
 * data must always produce the same output, and a placeholder the data cannot answer must never turn
 * into a blank.
 *
 * So the syntax is deliberately tiny, and every rule here is a pure function of its inputs:
 *
 *  | Token                     | Meaning                                                    |
 *  |---------------------------|------------------------------------------------------------|
 *  | `{{ path.to.value }}`     | substituted, HTML-escaped                                  |
 *  | `{{{ path.to.value }}}`   | substituted raw (for HTML produced by the template itself) |
 *  | `{{#each lines}}…{{/each}}` | repeat the block for each element of the array at `lines`  |
 *
 * Inside an `#each` block a name resolves against the current element first, then against the root
 * data — the same rule Mustache users already know, and the one that makes `{{name}}` mean the product
 * name inside a line and the document name outside it.
 *
 * **An unresolved placeholder is left in place and reported in `warnings`.** A silently blanked
 * `{{contactName}}` produces a document that does not say who it is addressed to, which is worse than
 * an ugly `{{contactName}}` somebody notices.
 */

export type TemplateData = Record<string, unknown>;

export interface TemplateRenderResult {
  /** The rendered subject line, with placeholders resolved (never left raw). */
  readonly subject: string;
  readonly body: string;
  /** Placeholders that could not be resolved, or expressions that could not be evaluated. */
  readonly warnings: readonly string[];
}

/** Bounds, so a template is not a place to hide a denial-of-service payload. */
export const TEMPLATE_MAX_LENGTH = 200_000;
export const TEMPLATE_MAX_EACH_DEPTH = 8;
export const TEMPLATE_MAX_EACH_ITEMS = 2_000;

const EACH_OPEN = '{{#each';
const EACH_CLOSE = '{{/each}}';

export interface TemplateRenderOptions {
  /** Subject line template; when absent the subject is empty. */
  readonly subject?: string | undefined;
}

/** Render `body` (and optionally `subject`) against `data`. */
export function renderTemplate(body: string, data: TemplateData, options: TemplateRenderOptions = {}): TemplateRenderResult {
  if (typeof body !== 'string' || body.length > TEMPLATE_MAX_LENGTH) {
    throw new Error(`A template body must be at most ${String(TEMPLATE_MAX_LENGTH)} characters.`);
  }
  const warnings: string[] = [];
  const root: ContextFrame = { data, eachParent: undefined };
  const rendered = renderBlock(body, root, warnings, 0);
  return {
    subject: options.subject === undefined ? '' : stripUnresolved(resolveLine(options.subject, root, warnings)),
    body: rendered,
    warnings,
  };
}

/**
 * Render a subject line, leaving placeholders in place rather than sending "Dear {{contactName}}".
 * A subject that still contains `{{` is reported, not sent as-is.
 */
function resolveLine(line: string, root: ContextFrame, warnings: string[]): string {
  const rendered = renderBlock(line, root, warnings, 0);
  if (/\{\{|\}\}/.test(rendered)) warnings.push('The subject line still contains an unresolved placeholder.');
  return rendered;
}

interface ContextFrame {
  readonly data: TemplateData;
  readonly eachParent: ContextFrame | undefined;
}

function renderBlock(source: string, frame: ContextFrame, warnings: string[], depth: number): string {
  if (depth > TEMPLATE_MAX_EACH_DEPTH) {
    throw new Error(`A template may not nest #each more than ${String(TEMPLATE_MAX_EACH_DEPTH)} levels deep.`);
  }
  let out = '';
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('{{', cursor);
    if (open === -1) {
      out += source.slice(cursor);
      break;
    }
    out += source.slice(cursor, open);
    const token = readToken(source, open);
    if (token === undefined) {
      // An unterminated token: emit the rest verbatim and report it, rather than throwing away the
      // remainder of a document.
      warnings.push(`Unterminated placeholder at offset ${String(open)}.`);
      out += source.slice(open);
      break;
    }
    cursor = token.end;

    if (token.kind === 'each') {
      const block = readEachBlock(source, cursor, token.name, warnings);
      if (block === undefined) break;
      cursor = block.end;
      out += renderEach(block.body, token.name, frame, warnings, depth);
      continue;
    }

    if (token.kind === 'placeholder') {
      const value = resolveName(token.name, frame);
      if (value === undefined) {
        warnings.push(`"${token.raw}" could not be resolved from the data.`);
        out += token.raw;
        continue;
      }
      const text = stringify(value);
      if (text === undefined) {
        warnings.push(`"${token.raw}" resolved to ${Array.isArray(value) ? 'an array' : 'an object'}, which cannot be rendered in one placeholder.`);
        out += token.raw;
        continue;
      }
      out += token.escaped ? escapeHtml(text) : text;
    }
  }
  return out;
}

function renderEach(body: string, name: string, frame: ContextFrame, warnings: string[], depth: number): string {
  const value = resolveName(name, frame);
  if (value === undefined) {
    warnings.push(`"{{#each ${name}}}" names no array in the data, so the block was skipped.`);
    return '';
  }
  if (!Array.isArray(value)) {
    warnings.push(`"{{#each ${name}}}" does not name an array, so the block was skipped.`);
    return '';
  }
  if (value.length > TEMPLATE_MAX_EACH_ITEMS) {
    throw new Error(`An #each block may render at most ${String(TEMPLATE_MAX_EACH_ITEMS)} items.`);
  }
  return value
    .map((element) => {
      const elementFrame: ContextFrame = {
        data: isRecord(element) ? (element as TemplateData) : { value: element },
        eachParent: frame,
      };
      return renderBlock(body, elementFrame, warnings, depth + 1);
    })
    .join('');
}

/** The matching `{{/each}}` for an open block, counting nesting. */
function readEachBlock(
  source: string,
  from: number,
  name: string,
  warnings: string[],
): { body: string; end: number } | undefined {
  let depth = 1;
  let cursor = from;
  while (cursor < source.length) {
    const nextOpen = source.indexOf(EACH_OPEN, cursor);
    const nextClose = source.indexOf(EACH_CLOSE, cursor);
    if (nextClose === -1) {
      warnings.push(`"{{#each ${name}}}" has no {{/each}}.`);
      return undefined;
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + EACH_OPEN.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return { body: source.slice(from, nextClose), end: nextClose + EACH_CLOSE.length };
    cursor = nextClose + EACH_CLOSE.length;
  }
  warnings.push(`"{{#each ${name}}}" has no {{/each}}.`);
  return undefined;
}

type Token =
  | { kind: 'placeholder'; name: string; raw: string; escaped: boolean; end: number }
  | { kind: 'each'; name: string; end: number };

function readToken(source: string, open: number): Token | undefined {
  const raw = source.startsWith('{{{', open);
  const closeAt = raw ? source.indexOf('}}}', open) : source.indexOf('}}', open);
  if (closeAt === -1) return undefined;
  const inner = source.slice(open + (raw ? 3 : 2), closeAt).trim();
  const end = closeAt + (raw ? 3 : 2);

  if (!raw && inner.startsWith('#each')) {
    const name = inner.slice('#each'.length).trim();
    if (name === '' || /[{}]/.test(name)) return undefined;
    return { kind: 'each', name, end };
  }
  if (inner === '' || /[{}]/.test(inner) || inner.includes('\n')) return undefined;
  return { kind: 'placeholder', name: inner, raw: source.slice(open, end), escaped: !raw, end };
}

/** Resolve a dotted name against the current frame, then each enclosing `#each` scope. */
function resolveName(name: string, frame: ContextFrame): unknown {
  const segments = name.split('.');
  let cursor: ContextFrame | undefined = frame;
  while (cursor !== undefined) {
    const value = walk(cursor.data, segments);
    if (value !== undefined) return value;
    cursor = cursor.eachParent;
  }
  return undefined;
}

function walk(data: TemplateData, segments: readonly string[]): unknown {
  let current: unknown = data;
  for (const segment of segments) {
    if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Scalar values only: an array or an object is a template error, not something to stringify. */
function stringify(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return undefined;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop an empty subject rather than sending a header-less document as the subject. */
function stripUnresolved(subject: string): string {
  return subject.replace(/\{\{[^}]*\}\}/g, '').trim();
}
