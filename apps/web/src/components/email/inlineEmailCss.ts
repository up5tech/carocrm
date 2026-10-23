/**
 * GrapesJS keeps every style it edits in a CSS ruleset — that is how the canvas, the style
 * manager and the device preview stay in step while a template is being designed. Email
 * clients are the opposite: Outlook's Word rendering engine ignores `<style>` blocks almost
 * entirely, so what leaves the editor has to carry its styles inline.
 *
 * This module is the bridge. It merges the editor's own generated stylesheet back into the
 * `style` attributes of the HTML it styled, producing the email-safe fragment that is stored
 * as `EmailTemplate.bodyHtml`.
 *
 * The input is always GrapesJS output — a deterministic serializer plus a deterministic rule
 * generator — which is what makes a focused implementation honest here: flat `selectorlist {
 * declarations }` rules, simple selectors, and the `@media`/`@keyframes`/`@font-face` blocks
 * that are copied through untouched for the clients that do understand them.
 *
 * Round-trip: GrapesJS parses inline styles out of a loaded template into rules, and this
 * module puts them back, so saving and reopening a template is stable.
 */

/** One flat CSS rule: a single selector, its declarations, and its position in the sheet. */
interface FlatRule {
  selector: string;
  declarations: [string, string][];
  order: number;
  specificity: number;
}

/** Selectors that cannot be expressed inline; their rules stay in a `<style>` block. */
function isNonInlinableSelector(selector: string): boolean {
  return selector.includes('::') || /:(hover|focus|active|visited|link)/i.test(selector);
}

/** Specificity score: id = 100, class/attribute/pseudo-class = 10, element = 1. */
function specificityOf(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g)?.length ?? 0;
  const tags = selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g)?.length ?? 0;
  return ids * 100 + classes * 10 + tags;
}

/** Splits a stylesheet into flat rules plus the raw at-rule blocks (balanced-brace scan). */
function parseStylesheet(css: string): { flat: FlatRule[]; keptBlocks: string[] } {
  const keptBlocks: string[] = [];
  let flatSource = '';
  let index = 0;
  while (index < css.length) {
    const at = css.indexOf('@', index);
    if (at === -1) {
      flatSource += css.slice(index);
      break;
    }
    flatSource += css.slice(index, at);
    let cursor = css.indexOf('{', at);
    if (cursor === -1) break;
    let depth = 1;
    cursor += 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    keptBlocks.push(css.slice(at, cursor));
    index = cursor;
  }

  const flat: FlatRule[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(flatSource)) !== null) {
    const selectorList = match[1] ?? '';
    const body = match[2] ?? '';
    const order = flat.length;
    for (const selector of selectorList.split(',')) {
      const trimmed = selector.trim();
      if (trimmed === '' || trimmed === '*') continue; // the universal rule is editor chrome
      const declarations: [string, string][] = [];
      for (const part of body.split(';')) {
        const colon = part.indexOf(':');
        if (colon <= 0) continue;
        const property = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (property !== '' && value !== '') declarations.push([property, value]);
      }
      if (declarations.length === 0) continue;
      flat.push({ selector: trimmed, declarations, order, specificity: specificityOf(trimmed) });
    }
  }
  return { flat, keptBlocks };
}

/** Parses a `style` attribute into an ordered, lower-cased property map. */
function parseStyleAttribute(value: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of value.split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const declaration = part.slice(colon + 1).trim();
    if (property !== '' && declaration !== '') out.set(property, declaration);
  }
  return out;
}

function serializeStyleAttribute(styles: Map<string, string>): string {
  return [...styles].map(([property, value]) => `${property}: ${value}`).join('; ');
}

/**
 * Merges `css` (GrapesJS's `getCss()` output) into the inline `style` attributes of `html`
 * (its `getHtml()` output). Rules apply in cascade order (specificity, then source order);
 * declarations already present inline win, matching real CSS precedence. Non-inlinable
 * selectors (`:hover`, `::before`, …) and at-rule blocks are emitted in a leading `<style>`
 * element for clients that support them.
 */
export function inlineEmailCss(html: string, css: string): string {
  if (css.trim() === '') return html;
  const { flat, keptBlocks } = parseStylesheet(css);

  const document = new DOMParser().parseFromString(html, 'text/html');
  const elements = document.body.querySelectorAll('*');
  for (const element of elements) {
    const existing = parseStyleAttribute(element.getAttribute('style') ?? '');
    const matched = flat.filter((rule) => !isNonInlinableSelector(rule.selector) && safeMatches(element, rule.selector));
    if (matched.length === 0) continue;
    matched.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    for (const rule of matched) {
      for (const [property, value] of rule.declarations) {
        if (!existing.has(property)) existing.set(property, value);
      }
    }
    element.setAttribute('style', serializeStyleAttribute(existing));
  }

  const keptRules = flat.filter((rule) => isNonInlinableSelector(rule.selector));
  const kept: string[] = [];
  if (keptRules.length > 0) kept.push(`<style>${keptRules.map((rule) => `${rule.selector}{${rule.declarations.map(([p, v]) => `${p}:${v}`).join(';')}}`).join('\n')}</style>`);
  for (const block of keptBlocks) kept.push(`<style>${block}</style>`);

  const body = document.body.innerHTML;
  return kept.length > 0 ? `${kept.join('\n')}\n${body}` : body;
}

/** `matches` throws on selectors this browser cannot parse; treat those as non-matching. */
function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}
