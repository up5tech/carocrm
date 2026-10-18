# Email templates, content preview and revisions

> **Phase:** 19-MA.6 (PLAN_Phase_19_Marketing_Automation.md §5.4, §6.2, §9.4; §15 `19-MA.6`).
> **Where the code lives:** the renderer is `apps/api/src/marketing-automation/marketing-template-render.ts`
> (pure functions, no I/O), the record-reading and sealing services are `marketing-template.service.ts`, and
> the campaign validation maps the render findings into its own report in
> `marketing-campaign-validation.service.ts`.

## 1. Position: wrap the shared template, never fork it

`EmailTemplate` stays a platform-owned metadata entity, edited only through the generic record API and its
existing detail/edit flows. Marketing adds no second template editor. What the module adds is the
*marketing view* on top of one:

- a **restricted recipient context** — a template placeholder may only name a person's own simple fields,
  the campaign's own configuration, or a documented system link (§5.4 "approved placeholders");
- a **preview** that renders what would actually go out, sanitised and explainable;
- an **immutable revision** — `MarketingTemplateRevision` — that a send can cite later, because the
  template itself remains editable (§6.2).

This mirrors the audit decision (`docs/implementation/marketing-automation-audit.md` §3): the platform's
tiny substitution helper (`packages/mail` `renderTemplate`) is unchanged; marketing substitutes from its
own, allowlisted context instead of unrestricted entity hydration.

## 2. Placeholders and fallbacks

| Placeholder | Group | Resolved from | Missing value renders as |
| --- | --- | --- | --- |
| `{{recipientName}}` | recipient | `Contact.name` / `Lead.name` (falls back to "`firstName lastName`" when the record's own `name` is empty) | empty |
| `{{recipientFirstName}}` | recipient | `firstName` | empty |
| `{{recipientLastName}}` | recipient | `lastName` | empty |
| `{{recipientEmailAddress}}` | recipient | `emailAddress` | empty |
| `{{campaignName}}`, `{{campaignCode}}`, `{{campaignObjective}}`, `{{campaignStartsAt}}`, `{{campaignEndsAt}}` | campaign | the campaign record's own fields | empty |
| `{{currentYear}}` | system | the render time (UTC) | — |
| `{{unsubscribeUrl}}`, `{{preferenceUrl}}` | system | per-recipient public links, inserted **at send time** (MA.7/MA.9) with the recipient's own scoped token | preview sentinel |

Rules (§5.4):

- **Known but missing is a fallback, not an error.** A recipient without a `firstName` renders an empty
  string, and the preview lists the placeholder under `fallbacks` with its group. A known-but-empty value
  is the normal state of person data.
- **Unknown is reported.** A placeholder name the renderer does not provide renders empty and appears in
  the preview's `unresolved` list with a `PLACEHOLDER_UNKNOWN` finding — a template mistake, never an
  internal error sourced into a message (§5.4 "preview warning or deliberate fallback").
- **Access rules first.** Values come from records read through the Entity Engine with the *previewing
  actor's* ACL applied, so a field the sender cannot read simply never enters the context; previewing a
  record the actor cannot read is a refusal (§9.2). A campaign may only preview what its owner may read.
- The list is one constant (`MARKETING_PLACEHOLDERS`) in `marketing-template-render.ts`; the context
  builder throws on a name added without a value branch, so the two cannot drift.

## 3. Preview

`POST /api/v1/MarketingAutomation/action/campaign/:id/previewContent`
body `{"recipientType": "Contact" | "Lead" (optional), "recipientId": … (optional)}`.

The answer carries the rendered `subject`, `bodyHtml` (sanitised, with a `findings` list of what the
filter dropped), a `plainText` body (the template's own text version, or a generated fallback derived
from the HTML when the template carries none), the `resolved` / `unresolved` / `fallbacks` lists, the
`systemLinks` present in the template, and the raw content's `templateContentHash`, plus the
`latestRevision` already sealed for the template.

- A preview **with** a named sample contact resolves real personalisation; **without** one, every
  recipient placeholder is a documented fallback and the preview says so.
- A preview is not a send and never resolves consent; eligibility and consent stay with the MA.4/MA.5
  gates at send time.
- **The system link placeholders render a preview sentinel**
  (`https://unsubscribe.preview.invalid/marketing/unsubscribe` and a matching preference path). A preview
  must not mint a live unsubscribe credential on every open, and the sentinel's reserved `.invalid` host
  makes accidental delivery a safe failure. The send path (MA.7/MA.9) replaces both placeholders with the
  recipient's own links *before* anything goes on the wire — the sentinel must never be sent, and the
  preview response notes this per placeholder (`SYSTEM_LINK_INSERTED_AT_SEND`).
- The capability is behind the `templates` feature flag (`features.templates`, default off), which also
  gates revision sealing.

## 4. Render safety (§9.4)

Insertion first, filter second, on every rendered HTML body:

1. **Context-aware escaping** — values substituted into the HTML body are HTML-escaped first, so a
   hostile field value (`"><img src=x onerror=…>`) cannot break out of the author's markup.
2. **`sanitizeMarketingHtml`** — one allowlist filter, deliberately conservative (audit §4.5): a tag
   survives only if it is on the list (`a`, `b/strong/i/em/u/s`, `p`, `div`, `span`, headings, `br`, `hr`,
   `blockquote`, `pre`, `code`, lists, tables, `img`); attributes survive only for the tags that have
   them (`a[href,title]`, `img[src,alt,width,height]`, table/numeric layout attributes); `style`,
   event handlers and every unknown attribute are dropped. `script`, `style`, `iframe`, `object`,
   `embed`, `svg`, `template` and friends are removed *with their content*; structural tags
   (`html`, `head`, `meta`, `link`, `base`, `form`, `body` …) are removed with their text kept. Comments
   and conditional comments cannot survive as markup (a `<` that opens nothing parseable is emitted as
   escaped text).
3. **URL validation on the effective value** — entities are decoded and control/whitespace characters
   stripped before the scheme check (mail clients ignore both inside a scheme, so
   `jav&#x09;ascript:`/`java script:` must not pass). Only `http`/`https` survive for `src`; `href`
   also allows `mailto`. Relative URLs are dropped: an email client resolves them against its own,
   unreadable context. Dropped attributes are reported (`a.href`, `img.src`) and appear as
   `CONTENT_LINK_INVALID` in the campaign validation report.

The whole output is re-checked (`validateMarketingLinks`) after sanitisation, so a finding means "the
template asked for something the filter refused", which is an authoring mistake a preview must surface.

## 5. Required opt-out links

For a purpose that requires consent (`Newsletter`, `ProductMarketing`, `EventUpdate` — §5.3), the content
must carry `{{unsubscribeUrl}}` or `{{preferenceUrl}}` in at least one part; the preview raises
`FOOTER_MISSING` (module warning `CONTENT_FOOTER_MISSING` in the validation report) when neither is
present. A `ServiceNotice` carries no such obligation, and the preview of an opted-out-path template
notes that the real links are per-recipient, inserted at send time.

## 6. Revisions and the content hash (§6.2)

`sealRevision` (`POST …/action/campaign/:id/contentRevision`, campaign **edit** required):

- copies the template's raw `subject` / `body` / `bodyHtml` into a `MarketingTemplateRevision` row, with
  `templateId`, a monotonic `revisionNumber` per template, the SHA-256 `contentHash` of the raw parts,
  the sealing campaign as provenance, and `sealedById`/`sealedAt`;
- creates it as a module-internal write in one transaction; the record API refuses all client writes
  (`MARKETING_INTERNAL_WRITE_ONLY`), the module write guard protects every field, and the uniqueness
  index `uq_entity_records_marketing_template_revision_number` makes the numbering safe against
  concurrent seals (migration `040_phase19_marketing_template_revision.sql`);
- is **idempotent for identical content**: sealing content whose hash already has a live revision of that
  template returns the existing revision (`reused: true`) instead of minting a sibling;
- emits `marketingAutomation.template.revisionSealed`, with identifiers and the hash only — never the
  message content (§7.3).

`GET …/action/campaign/:id/contentRevisions` lists a campaign's seals, newest first (campaign read
required).

**Why it matters for the phase's acceptance rule:** "a sent message can be associated with the content
revision/hash actually used" — the send infrastructure of MA.7–MA.9 must stamp `revisionId` +
`contentHash` on each delivery record and render from the sealed revision, never from the still-editable
template. That contract exists from MA.6 (the revision record and its hash); the stamps land with the
send path and are part of MA.7–MA.9's acceptance.

Retention: revisions are content evidence ("what did message X say?") and follow the
`MarketingTemplateRevision` retention policy in the domain settings (default three years).

## 7. Validation integration

The MA.3 campaign report (`POST …/action/campaign/:id/validate`) now analyses the linked template with
the same renderer and raises warnings: `CONTENT_MARKUP_REMOVED`, `CONTENT_LINK_INVALID`,
`CONTENT_FOOTER_MISSING`, `CONTENT_PLACEHOLDER_UNKNOWN`. Recipient personalisation is *not* part of this
report (there is no recipient in a validation): a missing recipient value is a documented fallback, not a
finding; a template *mistake* is. Validation and preview deliberately share one renderer, so an author
can never see a warning in the report that the preview disagrees with.
