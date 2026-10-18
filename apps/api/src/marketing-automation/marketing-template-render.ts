import { fingerprint } from "./marketing-automation-domain.js";

/**
 * Phase 19-MA.6 — the marketing content renderer: personalisation, sanitisation and link rules
 * (PLAN_Phase_19_Marketing_Automation.md §5.4, §5.10 privacy of content, §9.4, §15 `19-MA.6`).
 *
 * Everything here is a pure function over strings — no Nest, no database, no clock, no I/O — so the
 * adversarial cases can be unit-tested directly and the Service (which reads records) stays thin.
 * It composes with the platform's tiny `renderTemplate` substitution contract
 * (`packages/mail/src/template/index.ts`), which stays **unchanged**: its per-`Email`-record context
 * is the generic email path; marketing sending (MA.7+) substitutes from the restricted recipient
 * context built here, because §5.4 forbids unrestricted entity hydration.
 *
 * The four acceptance rules the plan pins to this phase are enforced by these functions:
 *
 *  1. **placeholders are allowlisted** (`MARKETING_PLACEHOLDERS`). A template may name a recipient's
 *     own simple fields, the campaign's own configuration and documented system links — nothing else.
 *     A field value is only ever read from a record the *actor can read* (the service layer reads
 *     through `EntityCrudService`, which applies record and field ACL), so an unreadable field simply
 *     never enters the context — it cannot be extracted through a template (§5.4, §9.2).
 *  2. **values are escaped per output context** (`escapeHtmlValue`), then the whole HTML body is run
 *     through `sanitizeMarketingHtml`, a conservative allowlist filter: unknown or dubious markup is
 *     dropped, not repaired, and it reports exactly what it removed (§9.4 "sanitize…; block
 *     scripts, event handlers, unsafe protocols").
 *  3. **links are validated** (`validateMarketingLinks`): only `http`, `https` and (for anchors)
 *     `mailto` survive, `src` needs `http`/`https`, relative URLs are dropped because an email client
 *     resolves them invisibly against the reader's context, and the entity-encoded bypasses
 *     (`jav&#x09;ascript:`) are caught by decoding before the scheme check.
 *  4. **a revision is a content hash** (`templateContentHash`): the immutable facts a send is later
 *     traced to (§6.2; the delivery record of MA.8/MA.9 stores `revisionId` + `contentHash`).
 */

// ---------------------------------------------------------------------------
// Placeholder allowlist (§5.4 "approved placeholders for canonical CRM fields,
// campaign fields and safe helper values")
// ---------------------------------------------------------------------------

export type PlaceholderGroup = "recipient" | "campaign" | "system";

export interface PlaceholderDefinition {
  /** The key as it appears between braces, e.g. `recipientFirstName` → `{{ recipientFirstName }}`. */
  readonly name: string;
  readonly group: PlaceholderGroup;
  /**
   * The documented fallback used when the value is missing (§5.4 "Support default/fallback values").
   * An empty fallback means "render as if absent", which is deliberately distinct from an *unknown*
   * placeholder: a known-but-missing value is a normal state of person data; an unknown name is a
   * template mistake and is reported in `unresolvedplaceholders`.
   */
  readonly fallback: string;
}

/**
 * Recipient placeholders name simple person fields only (Contact/Lead share this shape
 * (`firstName`, `lastName`, `emailAddress`, `name`): no relation, no formula field, no address book
 * and no other person's data. Campaign placeholders name the campaign's own configuration. System
 * placeholders name helper values and the **per-recipient public links**, which a real send inserts
 * with the recipient's own scoped token before submission (MA.7/MA.9) — never the preview sentinel.
 */
export const MARKETING_PLACEHOLDERS: readonly PlaceholderDefinition[] = [
  { name: "recipientName", group: "recipient", fallback: "" },
  { name: "recipientFirstName", group: "recipient", fallback: "" },
  { name: "recipientLastName", group: "recipient", fallback: "" },
  { name: "recipientEmailAddress", group: "recipient", fallback: "" },
  { name: "campaignName", group: "campaign", fallback: "" },
  { name: "campaignCode", group: "campaign", fallback: "" },
  { name: "campaignObjective", group: "campaign", fallback: "" },
  { name: "campaignStartsAt", group: "campaign", fallback: "" },
  { name: "campaignEndsAt", group: "campaign", fallback: "" },
  { name: "currentYear", group: "system", fallback: "" },
  { name: "unsubscribeUrl", group: "system", fallback: "" },
  { name: "preferenceUrl", group: "system", fallback: "" },
] as const;

export function marketingPlaceholder(name: string): PlaceholderDefinition | undefined {
  return MARKETING_PLACEHOLDERS.find((definition) => definition.name === name);
}

export const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * The placeholders a real send resolves *after* the audience snapshot, one token each. At preview time
 * there is no recipient token to issue (issuing one here would mint a live credential on every
 * preview), so they are rendered with a reserved, syntactically valid but unroutable host. The
 * reserved `.invalid` TLD (RFC 2606) makes accidental delivery of the sentinel a safe failure, and the
 * send path of MA.7/MA.9 replaces them with the recipient's own links before anything goes on the wire.
 */
export const PREVIEW_SYSTEM_LINK_SENTINELS: Readonly<Record<string, string>> = {
  unsubscribeUrl: "https://unsubscribe.preview.invalid/marketing/unsubscribe",
  preferenceUrl: "https://unsubscribe.preview.invalid/marketing/preferences",
};

// ---------------------------------------------------------------------------
// Escaping and entities
// ---------------------------------------------------------------------------

/** HTML-5 text/attribute escaping; `&` first, then every delimiter that could end a context. */
export function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Decode the entities a browser would decode when resolving a URL. A template can smuggle a scheme
 * past a naive check as `jav&#x61;script:…`, so the *effective* string is what gets validated
 * (`sanitizeMarketingHtml` validates the decoded form, then re-serialises the encoded one).
 */
export function decodeHtmlEntities(value: string): string {
  let out = value.replace(/&#x([0-9a-fA-F]{1,6});?/g, (_match, hex: string) =>
    String.fromCodePoint(parseIntSafe(hex, 16)),
  );
  out = out.replace(/&#([0-9]{1,7});?/g, (_match, dec: string) =>
    String.fromCodePoint(parseIntSafe(dec, 10)),
  );
  return out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function parseIntSafe(value: string, radix: number): number {
  const parsed = Number.parseInt(value, radix);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff) return 0xfffd;
  return parsed;
}

// ---------------------------------------------------------------------------
// Sanitiser (§9.4: §5.4 "Apply HTML sanitization and URL validation")
// ---------------------------------------------------------------------------

/** Tags that are rebuilt keeping only the attributes listed here. */
const ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  b: [],
  blockquote: [],
  br: [],
  code: [],
  div: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  i: [],
  img: ["src", "alt", "width", "height"],
  li: [],
  ol: [],
  p: [],
  pre: [],
  s: [],
  span: [],
  strong: [],
  table: ["width", "align", "border", "cellpadding", "cellspacing"],
  tbody: [],
  td: ["colspan", "rowspan", "align", "valign"],
  tfoot: [],
  th: ["colspan", "rowspan", "align", "valign"],
  thead: [],
  tr: [],
  u: [],
  ul: [],
};

/** Removed entirely, tag *and* content: their content is code or metadata, never visible text. */
const DROP_WITH_CONTENT_TAGS: readonly string[] = [
  "applet",
  "iframe",
  "math",
  "noembed",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xmp",
];

/** Removed, content kept (their text may be legitimate for the reader). */
const URL_ATTRIBUTE_SCHEMES: Readonly<Record<string, readonly string[]>> = {
  href: ["http", "https", "mailto"],
  src: ["http", "https"],
};

export interface SanitizeResult {
  readonly html: string;
  /** The tag names the filter dropped, de-duplicated, for the preview report (not the raw markup). */
  readonly removed: readonly string[];
}

/**
 * The single marketing-HTML entry point. Any markup this filter does not positively recognise is
 * dropped, so an unknown construct degrades to plain text rather than smuggling through.
 *
 * Deliberately conservative by design (audit §4.5): attributes are re-serialised from parsed values,
 * `style` and every event handler are dropped wholesale (CSS `url()` exfiltration and inline script
 * handlers cannot be made safe by checking), and the one URL context per tag is validated on the
 * entity-decoded value before the attribute is emitted again.
 */
export function sanitizeMarketingHtml(html: string): SanitizeResult {
  const removed = new Set<string>();
  const out: string[] = [];
  let position = 0;

  while (position < html.length) {
    const open = html.indexOf("<", position);
    if (open === -1) {
      out.push(obsoleteControls(html.slice(position)));
      break;
    }
    if (open > position) out.push(obsoleteControls(html.slice(position, open)));

    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/.exec(html.slice(open));
    if (match === null) {
      // A `<` that does not open a parseable tag is text, escaped — never emitted raw.
      out.push("&lt;");
      position = open + 1;
      continue;
    }
    const [raw, closing, nameRaw, attributes] = [match[0], match[1], String(match[2]).toLowerCase(), match[3] ?? ""];
    position = open + raw.length;

    if (DROP_WITH_CONTENT_TAGS.includes(nameRaw) && closing !== "/") {
      const close = new RegExp(`</\\s*${nameRaw}\\s*>`, "i").exec(html.slice(position));
      position = close === null ? html.length : position + close.index + close[0].length;
      removed.add(nameRaw);
      continue;
    }

    if (ALLOWED_TAGS[nameRaw] !== undefined) {
      if (closing === "/") {
        out.push(`</${nameRaw}>`);
        continue;
      }
      const attrs = sanitizeAttributes(nameRaw, attributes, removed);
      out.push(`<${nameRaw}${attrs}>`);
      continue;
    }

    removed.add(nameRaw);
    // A dropped tag never becomes markup; its text (for DROP_TAGS) stays in the output unharmed.
    continue;
  }

  // Comments (and the conditional-comment forms Outlook carries) never survive as markup: match after
  // tokenisation is impossible because the tokenizer only recognises well-formed tags — these become
  // escaped text above. What can still hide is an encoded script *inside* an allowed tag's text, which
  // the escaping of inserted values and the attribute filter prevent being *sent* as code.
  return { html: out.join(""), removed: [...removed].sort() };
}

/**
 * Markup-irrelevant control characters are dropped character by character rather than by a control-char
 * regex literal — the loop is explicit about the intent and needs no linter exception.
 */
function obsoleteControls(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0 && code <= 0x1f) continue;
    out += character;
  }
  return out;
}

function sanitizeAttributes(tag: string, inner: string, removed: Set<string>): string {
  const allowed = ALLOWED_TAGS[tag] ?? [];
  const attrs: string[] = [];
  const pattern = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]*))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    const attr = String(match[1]).toLowerCase();
    if (!allowed.includes(attr)) {
      if (attr === "style") removed.add("style-attribute");
      continue;
    }
    const quoted = match[2] ?? '""';
    const value = quoted.length >= 2 && (quoted.startsWith('"') || quoted.startsWith("'")) ? quoted.slice(1, -1) : quoted;
    if (attr === "href" || attr === "src") {
      const url = safeUrlValue(value, URL_ATTRIBUTE_SCHEMES[attr] ?? []);
      if (url === null) {
        removed.add(`${tag}.${attr}`);
        continue;
      }
      attrs.push(`${attr}="${url}"`);
      continue;
    }
    if (/^(width|height|colspan|rowspan)$/.test(attr)) {
      if (!/^([0-9]{1,4}%?)$/.test(value)) continue;
      attrs.push(`${attr}="${value}"`);
      continue;
    }
    if (/^(align|valign)$/.test(attr)) {
      if (!/^[a-z]{1,12}$/.test(value.toLowerCase())) continue;
      attrs.push(`${attr}="${value.toLowerCase()}"`);
      continue;
    }
    if (/^(border|cellpadding|cellspacing)$/.test(attr)) {
      if (!/^[0-9]{1,4}$/.test(value)) continue;
      attrs.push(`${attr}="${value}"`);
      continue;
    }
    // `alt` and `title`: free text, entity-encoded on the way out.
    attrs.push(`${attr}="${escapeHtmlValue(decodeHtmlEntities(value))}"`);
  }
  return attrs.length === 0 ? "" : ` ${attrs.join(" ")}`;
}

/**
 * Effective-scheme validation (§9.4 "validate link schemes"). Control characters and whitespace are
 * stripped the way parsers do inside the scheme, entities are decoded, and the result must begin with
 * an allowlisted scheme — `javascript:`, `data:`, `vbscript:` and any vendor-specific pseudo-scheme
 * are refused, as are relative URLs, because a mail client resolves those against unreadable context.
 */
function safeUrlValue(raw: string, schemes: readonly string[]): string | null {
  // Control characters *and* whitespace are stripped inside the whole URL: URL parsers ignore them in the
  // scheme, so "java script:" and "java\tscript:" must not be distinguishable from "javascript:".
  const stripped = obsoleteControls(raw).replace(/\s+/g, "");
  const effective = decodeHtmlEntities(stripped);
  const colon = effective.indexOf(":");
  if (colon <= 0) return null;
  const scheme = effective.slice(0, colon).toLowerCase();
  if (!schemes.includes(scheme)) return null;
  if (/[a-z0-9+.-]/i.test(effective.slice(0, colon).replace(/[a-z0-9+.-]/gi, ""))) return null;
  // Serialised as written (existing entities stay entities — a bare re-escape would double-encode
  // `&amp;`), with only the characters that could break out of the attribute escaped.
  return stripped.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// Link validation and the required opt-out links (§5.4, §5.3)
// ---------------------------------------------------------------------------

export interface RenderFinding {
  readonly code:
    | "PLACEHOLDER_UNKNOWN"
    | "MARKUP_REMOVED"
    | "LINK_NOT_ALLOWED"
    | "FOOTER_MISSING"
    | "SYSTEM_LINK_INSERTED_AT_SEND";
  readonly level: "warning" | "blocker";
  readonly message: string;
  readonly detail?: string;
}

/**
 * Every `href`/`src` in the **sanitised** HTML, checked the way a recipient's client would see it.
 * The sanitiser refuses unsafe schemes already, so a `LINK_NOT_ALLOWED` here means the template asked
 * for something the filter dropped — which the author must know about in the preview.
 */
export function validateMarketingLinks(html: string): readonly RenderFinding[] {
  const findings: RenderFinding[] = [];
  const seen = new Set<string>();
  const pattern = /\s(href|src)=("([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attr = String(match[1]).toLowerCase();
    const value = decodeHtmlEntities(obsoleteControls(match[3] ?? match[4] ?? "").replace(/\s+/g, ""));
    if (value === "" || seen.has(`${attr}:${value}`)) continue;
    seen.add(`${attr}:${value}`);
    const colon = value.indexOf(":");
    const scheme = colon > 0 ? value.slice(0, colon).toLowerCase() : "";
    const allowed = URL_ATTRIBUTE_SCHEMES[attr] ?? [];
    if (!allowed.includes(scheme)) {
      findings.push({
        code: "LINK_NOT_ALLOWED",
        level: "warning",
        message:
          colon > 0
            ? `A link was refused because its protocol "${scheme}" is not allowed (${allowed.join(", ")} only).`
            : "A link was refused because it is a relative URL; an email reader resolves it against its own context, so marketing links must be absolute.",
        detail: `${attr}=${value}`,
      });
    }
  }
  return findings;
}

/**
 * §5.4 "missing mandatory footer/preference links" — for a purpose that requires consent, the content
 * must carry at least one of the opt-out placeholders in *some* rendered part. Checked on the raw
 * template parts because at real-send time each placeholder becomes the recipient's own scoped link.
 */
export function requiredLinkFindings(
  parts: readonly string[],
  consentRequired: boolean,
): RenderFinding | null {
  if (!consentRequired) return null;
  const joined = parts.filter((part) => typeof part === "string").join(" ");
  if (/\{\{\s*(unsubscribeUrl|preferenceUrl)\s*\}\}/i.test(joined)) return null;
  return {
    code: "FOOTER_MISSING",
    level: "warning",
    message:
      "The content carries no unsubscribe or preference link. Recipients of this purpose must have a working opt-out in every message (§5.4); add {{unsubscribeUrl}} or {{preferenceUrl}}.",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RecipientValues {
  readonly name?: string | null | undefined;
  readonly firstName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
  readonly emailAddress?: string | null | undefined;
}

export interface CampaignValues {
  readonly name?: string | null | undefined;
  readonly code?: string | null | undefined;
  readonly objective?: string | null | undefined;
  readonly startsAt?: string | null | undefined;
  readonly endsAt?: string | null | undefined;
}

export interface TemplateParts {
  readonly subject?: string | null | undefined;
  readonly body?: string | null | undefined;
  readonly bodyHtml?: string | null | undefined;
}

export interface RenderInput {
  readonly template: TemplateParts;
  readonly campaign: CampaignValues;
  /** Null or absent when previewing without a chosen recipient (§5.4 "preview with a selected sample contact"). */
  readonly recipient: RecipientValues | null | undefined;
  /** Consent-required purposes render the sentinel-links note; never shown for ServiceNotice. */
  readonly consentRequired: boolean;
}

export interface RenderOutput {
  readonly subject: string | null;
  /** The template's own plain text, rendered (may be null when the template has no text body). */
  readonly bodyText: string | null;
  /** The rendered **and sanitised** HTML body (null when the template has no HTML body). */
  readonly bodyHtml: string | null;
  /** Plain-text fallback derived from the HTML when the template carries no text body (null otherwise). */
  readonly generatedText: string | null;
  /** Fully rendered plain text: the template's body when present, else the generated one. */
  readonly plainText: string | null;
  readonly plainTextSource: "template" | "generated" | "none";
  /** Placeholder names resolved from a real value in the context. */
  readonly resolved: readonly string[];
  /** Unknown placeholder names — a template mistake, rendered as its documented fallback. */
  readonly unresolved: readonly string[];
  /** Known placeholders whose value was missing, with the group that explains it. */
  readonly fallbacks: readonly { name: string; group: PlaceholderGroup }[];
  /** Placeholder *names used by the template that a later, per-recipient pass fills* (never a token). */
  readonly systemLinks: readonly string[];
  readonly findings: readonly RenderFinding[];
  /** The hash of the **raw** template content this render came from (§6.2 — the send's anchor). */
  readonly templateContentHash: string;
}

/**
 * Render one template against one recipient context.
 *
 * Context rules (§5.4):
 *  - an HTML-bound value is escaped before substitution, so `{{recipientName}}` containing markup
 *    cannot break out of the author's structure;
 *  - an unknown placeholder renders as its documented fallback (empty) **and** is reported, rather
 *    than leaking an internal error to a recipient;
 *  - the system link placeholders render a preview sentinel here and are noted — the send path inserts
 *    the recipient's own token links, so the sentinel is never sent as-is.
 */
export function renderMarketingTemplate(input: RenderInput): RenderOutput {
  const context = buildContext(input);
  const findings: RenderFinding[] = [];
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const fallbacks: { name: string; group: PlaceholderGroup }[] = [];
  const systemLinks: string[] = [];

  const substitute = (source: string, escape: boolean): string =>
    source.replace(PLACEHOLDER_PATTERN, (_whole, key: string) => {
      const definition = marketingPlaceholder(key);
      const used = definition === undefined ? undefined : context.get(definition.name);
      if (definition === undefined || used === undefined) {
        unresolved.push(key);
        return "";
      }
      if (definition.group === "system" && (key === "unsubscribeUrl" || key === "preferenceUrl")) {
        systemLinks.push(key);
        findings.push({
          code: "SYSTEM_LINK_INSERTED_AT_SEND",
          level: "warning",
          message: `{{${key}}} is a preview placeholder. The recipient's own ${key === "unsubscribeUrl" ? "one-click unsubscribe" : "preference centre"} link is inserted at send time (MA.7/MA.9); the URL shown here is the preview sentinel and is never sent.`,
        });
      }
      if (used.fallback) fallbacks.push({ name: key, group: definition.group });
      else resolved.push(key);
      return escape ? escapeHtmlValue(used.value) : used.value;
    });

  const subject = input.template.subject === undefined || input.template.subject === null || input.template.subject.trim() === ""
    ? null
    : substitute(input.template.subject, false).trim();

  const bodyText = input.template.body === undefined || input.template.body === null || input.template.body.trim() === ""
    ? null
    : substitute(input.template.body, false);

  const bodyHtmlRaw = input.template.bodyHtml === undefined || input.template.bodyHtml === null || input.template.bodyHtml.trim() === ""
    ? null
    : substitute(input.template.bodyHtml, true);

  let bodyHtml: string | null = null;
  let generatedText: string | null = null;
  if (bodyHtmlRaw !== null) {
    const sanitized = sanitizeMarketingHtml(bodyHtmlRaw);
    bodyHtml = sanitized.html;
    for (const tag of sanitized.removed) {
      findings.push({
        code: "MARKUP_REMOVED",
        level: "warning",
        message:
          tag === "style-attribute"
            ? "Inline style attributes were removed by the content filter (§9.4). Move styling into tables and text pairing."
            : `The content filter dropped <${tag}> markup; it may not be used in marketing email content.`,
      });
    }
    for (const finding of validateMarketingLinks(sanitized.html)) findings.push(finding);
    if (bodyText === null) generatedText = plainTextFromHtml(sanitized.html);
  }

  for (const key of unresolved) {
    findings.push({
      code: "PLACEHOLDER_UNKNOWN",
      level: "warning",
      message: `{{${key}}} is not a placeholder this renderer provides; it renders empty. Check the placeholder list.`,
    });
  }

  const footer = requiredLinkFindings([input.template.subject ?? "", input.template.body ?? "", input.template.bodyHtml ?? ""], input.consentRequired);
  if (footer !== null) findings.push(footer);

  const plainText = bodyText ?? generatedText;
  return {
    subject,
    bodyText,
    bodyHtml,
    generatedText,
    plainText,
    plainTextSource: bodyText !== null ? "template" : generatedText !== null ? "generated" : "none",
    resolved: [...new Set(resolved)],
    unresolved: [...new Set(unresolved)],
    fallbacks: [...fallbacks],
    systemLinks: [...new Set(systemLinks)],
    findings,
    templateContentHash: templateContentHash(input.template),
  };
}

interface ContextValue {
  readonly value: string;
  readonly fallback: boolean;
}

function buildContext(input: RenderInput): Map<string, ContextValue> {
  const context = new Map<string, ContextValue>();
  const recipient = input.recipient ?? {};
  const firstName = trim(recipient.firstName) ?? "";
  const lastName = trim(recipient.lastName) ?? "";
  const name = trim(recipient.name) ?? (firstName !== "" || lastName !== "" ? `${firstName} ${lastName}`.trim() : "");

  const put = (definition: PlaceholderDefinition, value: string): void => {
    context.set(definition.name, { value, fallback: value === definition.fallback });
  };

  for (const definition of MARKETING_PLACEHOLDERS) {
    switch (definition.name) {
      case "recipientName": put(definition, name ?? ""); break;
      case "recipientFirstName": put(definition, firstName); break;
      case "recipientLastName": put(definition, lastName); break;
      case "recipientEmailAddress": put(definition, trim(recipient.emailAddress) ?? ""); break;
      case "campaignName": put(definition, trim(input.campaign.name) ?? ""); break;
      case "campaignCode": put(definition, trim(input.campaign.code) ?? ""); break;
      case "campaignObjective": put(definition, trim(input.campaign.objective) ?? ""); break;
      case "campaignStartsAt": put(definition, trim(input.campaign.startsAt) ?? ""); break;
      case "campaignEndsAt": put(definition, trim(input.campaign.endsAt) ?? ""); break;
      case "currentYear": put(definition, String(new Date().getUTCFullYear())); break;
      case "unsubscribeUrl":
      case "preferenceUrl": put(definition, PREVIEW_SYSTEM_LINK_SENTINELS[definition.name] ?? ""); break;
      default: {
        // `MARKETING_PLACEHOLDERS` is the single source of truth; a name added to the list without a
        // value branch here must fail loudly rather than silently render empty.
        throw new Error(`Unsupported marketing placeholder "${String(definition.name)}" in the render context.`);
      }
    }
  }
  return context;
}

// ---------------------------------------------------------------------------
// Plain-text generation and content hash
// ---------------------------------------------------------------------------

/**
 * Derive a readable plain-text body from sanitised HTML: block elements become line breaks, tags are
 * dropped, entities resolved, and runs of blank lines collapsed. Good enough to be the "plain-text
 * fallback" an email with no template body carries (§5.4), never a pixel-perfect mirror.
 */
export function plainTextFromHtml(html: string): string {
  const lineBreaks = html
    // A list item is a bullet, not a paragraph: only its opening tag becomes the marker.
    .replace(/<\s*(li)\s*>/gi, "\n- ")
    .replace(/<\s*(br)\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, "\n");
  const withoutTags = lineBreaks.replace(/<[^<>]*>?/g, "");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The hash a send's audit trail carries (§6.2 "Content hash"): it fingerprints the **raw** template
 * parts — what the author sealed — and is stable across key order by construction (`fingerprint`).
 * The rendered, per-recipient output is *derived* from this content, never replaces it.
 */
export function templateContentHash(template: TemplateParts): string {
  return fingerprint({
    subject: template.subject ?? null,
    body: template.body ?? null,
    bodyHtml: template.bodyHtml ?? null,
  });
}

function trim(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
