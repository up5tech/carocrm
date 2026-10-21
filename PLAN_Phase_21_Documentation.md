# Phase 21 — In-App Documentation and Product Help

> **Status:** ✅ **Implemented 2026-10-21** (21.0–21.10). This document remains the scope, architecture
> reference and decision record for Phase 21; the progress note in §17 records what each sub-phase shipped
> and where it deviated. Two items are open on purpose: the corpus has no screenshots (21.3 deferred) and
> `vi` covers the P0 set only, pending a native-speaker review — both in
> `docs/compatibility/documentation.md`.
> **Parent roadmap:** `PLAN.md` — Phase 21 (added to §57 alongside this document)
> **Target runtime:** the existing NestJS API + React SPA; no new service, no new database.
> **Functional reference:** EspoCRM's in-app help surface and the documentation/onboarding patterns of
> mainstream CRM products (§2), mapped onto capabilities this repository already ships.
> **Implementation rule:** build on the platform completed in Phases 0–20. Do not reimplement
> kernel capabilities (i18n catalogs, settings documents, ACL, navigation) inside this phase.

---

## 1. Purpose

Every capability this repository ships is currently documented **for engineers** — `docs/modules/`,
`docs/admin/`, `docs/ux/`, `docs/runbooks/`. An administrator who has to add a user, reorder the main
menu or read a failed job has to find a Markdown file on a server; a sales rep who wants to know why a
quote will not issue has nothing at all. The product is therefore usable only by the people who wrote
it.

Phase 21 puts a **documentation surface inside the web UI**: a `/docs` area, written for the two
audiences that actually operate the system — the **administrator** and the **CRM user** — searchable,
bilingual, permission-aware, and deep-linked from the screens it describes.

### 1.1 Primary outcomes

At the end of this phase:

1. Any signed-in user opens `/docs` from the sidebar or the avatar menu, sees a landing page split by
   audience, and reaches the page they need in at most two clicks or one search.
2. The **Administrator handbook** covers every settings tab and administration screen that exists:
   what it controls, what happens when it is wrong, and where the related screen is.
3. The **CRM user guide** covers daily work: finding a record, working a list, editing a record,
   logging an activity, running a quote, working a case, a project, a campaign, the inbox.
4. Search matches with or without Vietnamese diacritics, returns a highlighted snippet, and never
   returns a page the caller is not allowed to see.
5. Every settings tab and the main module screens carry a **"Learn more"** link into the exact page
   that documents them (`HelpTip docKey` / tab `docKey`), so help is one click from the problem.
6. The docs area is **bilingual**: `en` is the source of truth, `vi` is a first-class translation with
   a visible fallback notice when a page is not translated yet.
7. Documentation is **versioned with the release**. Shipping a feature without its page fails a test,
   not a customer.

### 1.2 Explicit scope boundary

In scope: the `/docs` surface, the content engine, the content itself, search, contextual links, the
`docs` settings document, and the tests that keep all of it honest.

**Out of scope** (deliberately, and each with a reason):

| Not in this phase | Why |
|---|---|
| Customer-facing knowledge base / portal help centre | `KnowledgeArticle` + `KnowledgeBaseService` already own that surface (SD.13/14). Portal users are **not** given `/docs` in this phase. |
| Admin-authored pages inside `/docs` | Docs must describe the shipped release, not one instance. Instance-specific notes belong in Knowledge Articles. §17 lists an optional P2 bridge. |
| Video, GIF tours, product tours, tooltips-on-rails | Different medium, different authoring pipeline; screenshots + text first. |
| A CMS, a second editor, or Markdown round-tripping in the browser | Docs are authored in the repository and reviewed like code (§4.7). |
| API reference generated from decorators | The Swagger spec is generated at runtime; a static reference is PLAN §58. |
| Replacing `docs/` (engineering documentation) | `docs/` stays the engineering record. User-facing content lives in `content/docs/` (§4.1). |

---

## 2. Reference Baseline and Compatibility Notes

### 2.1 Upstream feature reference (help surface)

EspoCRM's help model, which this phase reproduces in product terms rather than in code:

1. **Contextual help next to the thing it explains** — a help icon on a panel or field opens the
   relevant documentation, not a generic home page.
2. **A documentation area reachable from the user menu**, separate from the record UI.
3. **Role-appropriate help** — an administrator's help and a user's help are different documents, and
   a user is not shown administration instructions they cannot act on.
4. **Keyboard and search entry points** — help is findable without knowing where it lives.

### 2.2 Market reference (documentation UX)

Applied in §5:

1. **Two doors, not one tree** — landing pages that ask "who are you / what are you doing" convert far
   better than a flat table of contents (Stripe, Linear, Notion help centres).
2. **Search-first with highlighted snippets** — a reader trusts a result they can see the match in.
3. **Reading typography is a feature** — 65–75 character measure, generous line height, a sticky
   table of contents, and no full-width prose on a 2560 px monitor.
4. **Every instruction ends at the screen it describes** — a "Open this screen" button beats a
   sentence that says "go to Settings → Main Menu".
5. **Print/PDF is a real requirement for administrators** — onboarding handouts and audit evidence.

### 2.3 Compatibility policy

- No existing route, endpoint, table or settings document changes shape.
- `/docs` is additive; an installation that removes the navigation entry (Main Menu tab →
  `docs` → off) keeps today's behaviour exactly.
- Content is **data**, not code: adding a page requires no TypeScript change, and removing one
  requires no migration.
- An instance that ships without `content/docs/` boots normally, logs one warning, and renders an
  empty state at `/docs` — the same degradation contract as a missing i18n catalog
  (`i18n.service.ts`, `resolveCatalogDir`).

---

## 3. Prerequisites and Repository Audit

### 3.1 Current state — what already exists and must be reused

| Concern | Existing implementation | How Phase 21 uses it |
|---|---|---|
| Locale resolution and fallback | `apps/api/src/i18n/i18n.service.ts` (`catalogFor`, `acceptLanguageLocale`, `translate`) | Same locale chain (`requested → en`) and the same "warn once, never fail the request" discipline. |
| Static content loading | `resolveCatalogDir()` walks up to the repo root, `I18N_DIR` overrides | `resolveDocsDir()` mirrors it with `DOCS_DIR`. |
| Content hashing / conditional GET | `I18nService.contentHash` + SPA cache in `state/i18n.ts` | `contentHash` per locale drives `ETag` and the SPA query key. |
| Settings documents | `SettingsRegistryService` + `SettingsDocumentService`, `platform-settings.ts` | A new `docs` document (§6.1), envelope storage, `readLevel: 'user'`, `writeLevel: 'admin'`. |
| Navigation | `navigation-defaults.ts` `NAVIGATION_PAGES` + `NAVIGATION_FEATURE_GATE` | One new page seed gated by the `docs` document (§5.7). |
| ACL | `AclApiService.canUser(entity, action)` | Admin pages may declare `requires` and are filtered by it (§10). |
| Admin tab catalog | `admin-panel.service.ts` tab descriptors | Each tab gains an optional `docKey` (§5.6). |
| Server state in the SPA | TanStack Query hooks in `apps/web/src/state/*.ts` | `state/docs.ts` follows `state/admin.ts` exactly. |
| Route ordering | `AppRoutes.tsx` — static routes before `/:entity` | `/docs/*` is declared before the entity wildcard. |
| Test harness | `vitest` (`apps/api/test/**`, `packages/*/src/**/*.test.ts`), Playwright (`e2e/`) | Three new suites + one e2e spec (§13). |

### 3.2 Current state — what is missing

1. **No content pipeline.** `docs/` (109 files) is engineering prose, not structured content: no
   front-matter, no stable slugs, no locale split, no link validation.
2. **No Markdown renderer anywhere.** `apps/web/package.json` has no Markdown dependency; the API has
   none either. Nothing in the repo parses Markdown today.
3. **No `/docs` route**, no navigation entry, no help menu item, no settings document.
4. **`HelpTip` exists but is used by no page** — an explicit Phase 20 deferral
   (`PLAN_Phase_20_Settings_UX.md` §19). It is the natural carrier for "Learn more" (§5.6).
5. **No content test.** Nothing would notice if a page documented a screen that no longer exists.

### 3.3 Gap handling

Each gap above maps to a sub-phase in §17: content pipeline → 21.1, renderer → 21.6, route and
navigation → 21.2/21.7, contextual help → 21.8, content tests → 21.10.

### 3.4 Repository and database safety

- **No migration.** The `docs` settings document is an `app_settings` row written on first save, like
  `security` and `notifications`.
- **No test database.** Every API test uses the configured primary database via the existing
  `bootApi()` helper and writes only `AGENT_TEST_`-prefixed records (AGENTS.MD §3).
- **No writes to `docs/`.** Phase 21 adds `content/docs/` and never rewrites engineering docs.
- Documentation-only work (21.3–21.5) touches no runtime code, so it can land without a deploy risk.

---

## 4. Functional Requirements — Part A: Content Model and Authoring

### 4.1 Content tree and file layout

User-facing content lives in a **new top-level `content/` directory**, deliberately separate from
`docs/`:

```text
content/
  docs/
    en/
      _index.md                          # the docs landing page
      getting-started/
        _index.md                        # section descriptor + intro
        01-sign-in.md
        02-find-your-way.md
        03-your-profile.md
        04-keyboard-shortcuts.md
      user/
        _index.md
        01-lists-and-views.md
        ...
      admin/
        _index.md
        01-settings-overview.md
        ...
      reference/
        _index.md
        01-glossary.md
        02-faq.md
        03-troubleshooting.md
    vi/                                  # same tree, may be partial
      ...
```

Rules:

1. **Directory = section, file = page.** `content/docs/<locale>/<section>/<slug>.md`. The section key
   is the directory name; the slug is the filename without `.md`, minus an optional `NN-` ordering
   prefix (`01-lists-and-views.md` → slug `lists-and-views`).
2. **Section keys and slugs are `[a-z][a-z0-9-]*`**, unique per locale, and are part of the URL. They
   are **never** renamed casually: a slug is a permalink. A rename requires a redirect entry in
   `content/docs/redirects.json` (§4.6).
3. **`_index.md`** is both the section descriptor (front-matter `title`, `summary`, `order`,
   `audience`) and the section landing content (body). A section without `_index.md` fails the lint.
4. **`vi` may be partial.** Any page missing in `vi` is served from `en` with `fallback: true`.
5. **`content/docs/` is the only source of truth.** No page content is duplicated into i18n catalogs:
   catalogs hold *UI chrome* (`web.docs.*`), never prose.

Why not `docs/`: engineering docs are reviewed by engineers, use engineering vocabulary, contain
audit reports and ADRs, and must not be shipped selectively. Mixing the two would make the lint
rules unenforceable and would put customer-facing text through the wrong review.

### 4.2 Front-matter contract

```yaml
---
title: Main menu
summary: Enable, rename, reorder and group the entries in the sidebar.
audience: admin            # user | admin
order: 30
tags: [menu, navigation, sidebar]
requires: { entity: Team, action: read }   # optional; ACL check on top of audience
related: [admin/settings-overview, reference/glossary]
updated: 2026-10-21
---
```

| Field | Required | Rule |
|---|---|---|
| `title` | yes | 1–80 characters, sentence case, no trailing period |
| `summary` | yes | 1–160 characters; used on cards, in search results, and as the page lede |
| `audience` | yes | `user` or `admin`; `admin` pages are hidden from non-admin callers |
| `order` | yes | integer ≥ 0, unique within its section |
| `tags` | no | lowercase tokens; feed search and "related" suggestions |
| `requires` | no | `{ entity, action }`; filtered through `AclApiService.canUser` |
| `related` | no | `section/slug` keys; validated to exist, rendered as "See also" |
| `updated` | no | ISO date, author-maintained; shown as "Last reviewed" |

Unknown front-matter keys are a **lint failure**, not a warning: a typo in `audiance` must not
silently produce a page nobody can see.

### 4.3 The supported Markdown subset

A deliberately small, documented subset. Anything outside it is a lint failure, so content cannot
degrade into unsupported HTML that the renderer would silently drop.

| Construct | Syntax | Notes |
|---|---|---|
| Headings | `##`, `###`, `####` | `#` is reserved for the front-matter title; `#####`+ is refused |
| Paragraph | blank-line separated | |
| Emphasis | `**bold**`, `*italic*`, `` `code` `` | no `__`/`_` forms, no nesting beyond one level |
| Links | `[text](href)` | internal `section/slug` or `/Route`, external `https://` (§4.5) |
| Lists | `-` / `1.` | two nesting levels maximum |
| Table | pipe syntax with a separator row | header row required |
| Code block | triple backticks + language | rendered as a read-only block, never executed |
| Callout | `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!DANGER]` | GitHub-alert style; the only blockquote form |
| Divider | `---` on its own line | |
| Image | `![alt](/docs-assets/x.png "caption")` | alt text **required**; local assets only (§4.5) |
| Raw HTML | — | **refused** by the lint and escaped by the parser |

### 4.4 Block model (what the API returns)

The API does not return HTML. It returns a **typed block tree**, which the SPA renders with real React
components. Two reasons: there is no `dangerouslySetInnerHTML` anywhere in the product, so an XSS
surface never appears; and internal links, callouts and tables get the design system's behaviour
(hover, focus, responsive scroll) instead of whatever the Markdown emitted.

```ts
// packages/docs/src/types.ts
export type DocAudience = 'user' | 'admin';

export type DocInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; href: string; internal: boolean };

export type DocBlock =
  | { type: 'paragraph'; inlines: DocInline[] }
  | { type: 'heading'; level: 2 | 3 | 4; id: string; text: string }
  | { type: 'list'; ordered: boolean; items: DocBlock[][] }
  | { type: 'code'; language: string | null; code: string }
  | { type: 'callout'; variant: 'note' | 'tip' | 'warning' | 'danger'; blocks: DocBlock[] }
  | { type: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: DocInline[][]; rows: DocInline[][][] }
  | { type: 'image'; src: string; alt: string; caption: string | null }
  | { type: 'divider' };
```

`heading.id` is a slug of the heading text, de-duplicated within the page (`main-menu`, `main-menu-2`),
and is what `#anchor` links and the table of contents point at.

### 4.5 Internal links, deep links and assets

Three link forms, each validated at build time:

1. **Doc links** — `[Main menu](admin/main-menu)` or `[Main menu](../admin/main-menu.md)`. Both
   normalise to the key `admin/main-menu`; the renderer emits `/docs/admin/main-menu`. The lint fails
   on an unknown key.
2. **App links** — `[Open Settings → Main Menu](/admin/settings/menu)`. Any root-absolute path is
   treated as an in-app route: the SPA renders it as a router `<Link>`, and the page shows an
   **"Open this screen"** button for the *first* app link of the page. The lint checks the path
   against a static allowlist of routes (from `AppRoutes.tsx` and the entity list) so a renamed route
   cannot leave a dead instruction behind.
3. **External links** — `https://…` only, rendered with `target="_blank"` and
   `rel="noopener noreferrer"` plus an external-link icon.

**Assets.** Screenshots live in `apps/web/public/docs-assets/` and are referenced as
`/docs-assets/<name>.png`, so they are served by the SPA's static handler, hashed by the build, and
never pass through the API. The trade-off — content and images in two directories — is accepted
because it keeps the API JSON-only and gives the images normal static caching. The lint asserts every
referenced asset exists, that every asset is referenced by at least one page (no orphans), that the
file is a PNG or WebP under 400 KB, and that `alt` is non-empty.

### 4.6 Locale, fallback and redirects

- **Source of truth is `en`.** Every key must exist in `en`. `vi` may be a subset.
- **Fallback is per page, not per section**: a translated section may contain untranslated pages.
- The API marks a fallback page `fallback: true` and the reader renders a quiet notice
  ("This page is not translated yet — showing English") with a link to the English page.
- **Search is locale-scoped**: it searches the requested locale's corpus and, when that yields fewer
  than 3 hits, adds `en` hits marked `locale: 'en'`.
- **Redirects** — `content/docs/redirects.json`:

  ```json
  { "admin/navigation": "admin/main-menu" }
  ```

  A request for a redirect source answers `301` to the target. This is the only sanctioned way to
  rename a published slug. Redirect chains and cycles are refused by the lint.

### 4.7 Authoring workflow and review rules

1. **Docs are code.** A page change is a normal pull request against `content/docs/`.
2. **Written from the implementation, not from the plan.** An author opens the screen (or reads the
   service) before writing a sentence. A page that describes a control that does not exist is a bug
   and is caught by §13.3 where it is checkable (routes, doc keys), and by review where it is not.
3. **One page = one job.** "Add a user" is a page; "Users, teams and roles" is a section. A page that
   needs three unrelated headings is split.
4. **Every page answers, in order**: what this is → when you need it → the steps → what can go wrong
   → where to go next. The `summary` is the lede; the first `##` is a step list or a definition.
5. **No aspirational content.** No "coming soon", no future tense, no screenshots of unbuilt screens.
6. **Screenshots are captured, not designed** — 1440×900, seeded demo data, no real customer data, no
   personal names, no tokens in the frame.
7. **`vi` is translated by a human**, not machine-translated and committed unreviewed. A missing
   translation is better than a wrong one; the fallback notice makes that acceptable.

### 4.8 Content inventory

Thirty-eight pages across four sections. `P0` = required before the phase can be called usable; `P1` =
required before the phase is done.

**`getting-started` (audience: user, visible to all) — P0**

| Slug | Title | Notes |
|---|---|---|
| `sign-in` | Signing in and out | Password reset, session, language at login |
| `find-your-way` | Finding your way around | Sidebar, groups, header search, `⌘K` palette, `/profile` |
| `your-profile` | Your profile, language and time zone | Avatar menu, per-user preferences |
| `keyboard-shortcuts` | Keyboard shortcuts | One table, every shortcut that exists today |

**`user` (audience: user) — P0**

| Slug | Title | Notes |
|---|---|---|
| `lists-and-views` | Working with lists | Columns, density, saved filters, URL state, bulk actions + undo |
| `record-page` | Reading and editing a record | Panels, inline edit, unsaved-changes guard, `⌘/Ctrl+Enter` |
| `activities-and-tasks` | Activities, tasks and the calendar | Task/Call/Meeting/Email, `/tasks`, `/calendar` |
| `stream-and-notifications` | Stream and notifications | `/stream`, follows, mentions |
| `search` | Search and the command palette | Global search, palette modes, recent |
| `dashboards-and-reports` | Dashboards and reports | `/dashboards`, `/reports`, role default |
| `import-export` | Importing and exporting CSV | The round-trip that exists in `import-export.service.ts` |

**`user` — P1**

| Slug | Title | Notes |
|---|---|---|
| `sales-quotes` | Quotes and orders | Draft → issue → render → send; documents |
| `service-desk-cases` | Cases, queues and SLAs | Case lifecycle, queue, SLA clock, CSAT |
| `projects` | Projects | Plan, board, Gantt, members, settings |
| `customer-success` | Customer success | Health, plans, playbooks, reviews |
| `marketing` | Campaigns and audiences | Campaign lifecycle, target lists, consent/suppression |
| `chat-and-voice` | Chat and the voice inbox | `/crm-chat`, `/voice-inbox`, call log, composer |

**`admin` (audience: admin) — P0**

| Slug | Title | Notes |
|---|---|---|
| `settings-overview` | The administration area | The tab model, save bar, per-tab permissions, where each tab lives |
| `branding-and-localization` | Branding, language and time | General + Localization tabs, `brand`/`i18n` documents |
| `main-menu` | The main menu | Enable/disable, rename, reorder, accents, groups, reset |
| `users-teams-roles` | Users, teams and roles | Last-admin protection, role levels, field permissions |
| `api-keys` | API keys | Show-once secret, scopes, revocation |
| `entities-and-fields` | Entities, fields and layouts | Entity Manager, metadata, layout manager |

**`admin` — P1**

| Slug | Title | Notes |
|---|---|---|
| `authentication-and-security` | Authentication and security | Password policy, session, `security` document, danger zone |
| `email-and-notifications` | Email accounts and notifications | Mailboxes, `MAIL_TRANSPORT`, notification document |
| `files-and-storage` | Files and storage | Attachments, limits, `fileStorage` document, retention |
| `workflows-and-processes` | Workflows and processes | `/admin/workflows`, `/admin/processes`, BPM |
| `extensions` | Extensions | Install, enable, contributed navigation |
| `integrations` | Integrations | `/advanced-integrations`, connectors, webhooks tab |
| `module-settings` | Module settings | Sales, Service Desk, Customer Success, Marketing, Chat, Voice, AI documents |
| `portals` | Portals | Portal users, navigation, ACL scope |
| `audit-jobs-and-operations` | Audit log, jobs and operations | `/admin/audit-log`, `/admin/jobs`, failed job triage |
| `first-run` | First-run checklist | Mirrors the setup checklist items and their routes |

**`reference` (audience: user) — P1**

| Slug | Title | Notes |
|---|---|---|
| `glossary` | Glossary | The vocabulary the UI uses (record, relation, stream, queue, SLA, playbook) |
| `faq` | Frequently asked questions | Short, link-out answers |
| `troubleshooting` | Troubleshooting | Symptom → cause → fix, with links to the admin page |
| `permissions-matrix` | Who can see what | Role levels × actions, and why a button is missing |
| `release-notes` | What's new | Points at the release notes file; last release only |

---

## 5. Functional Requirements — Part B: The Docs Surface

### 5.1 Routes and information architecture

```text
/docs                          landing: audience cards, popular pages, search box
/docs/search?q=…               search results
/docs/:section                 section landing (from _index.md)
/docs/:section/:slug           a page
/docs/:section/:slug#anchor    a page at a heading
```

Route declaration order in `AppRoutes.tsx` matters and mirrors the existing comments: `/docs`,
`/docs/search`, `/docs/:section`, `/docs/:section/:slug` are all declared **before** `/:entity`, so
`docs` is never read as an entity name and `search` never as a section.

Portal principals have no docs routes at all (§10).

### 5.2 Landing page

Three zones, top to bottom:

1. **A search field** with placeholder "Search the handbook" and a hint for `⌘K`.
2. **Two audience cards** — *Administrator handbook* and *CRM user guide* — each with its summary and
   its first three page links. The administrator card is listed first for an admin, second otherwise;
   a non-admin never sees it at all.
3. **"Start here"** — four getting-started links, plus "Recently reviewed" (the five pages with the
   newest `updated`).

No carousel, no hero image, no marketing copy.

### 5.3 Section index and page reader

**Section index**: section summary, then its pages as cards (title, summary, `updated`), ordered by
`order`.

**Page reader** — a three-column layout at ≥ 1180 px, collapsing to one column below 900 px:

| Column | Content |
|---|---|
| Left (220 px) | Section list + page list of the current section, current page highlighted |
| Centre (max 72 ch) | Breadcrumb (`Docs / Admin / Main menu`), `title`, `summary` lede, blocks, "See also", prev/next |
| Right (200 px, sticky) | Table of contents (h2/h3), "On this page", "Open this screen" button, "Copy link", "Print" |

Behaviour:

- The TOC highlights the section currently in view (`IntersectionObserver`, no scroll listener).
- Anchors are real `id`s on headings; a deep link scrolls to the heading and moves focus to it, so a
  keyboard user lands where the link promised.
- `prev`/`next` follow section order and never cross sections silently — the last page of a section
  links to the next section's index.
- A fallback page shows the translation notice above the lede (§4.6).
- Print stylesheet: sidebar, TOC and buttons are hidden, the measure becomes full width, links print
  their URL, and each page starts on a new sheet (§5.9).

### 5.4 Search

- Entry points: the docs search field, `/docs/search?q=`, and the command palette (§5.7).
- Debounced 200 ms; Enter navigates to the results route so a search is shareable.
- Results: title, section, snippet with the matched terms highlighted (`ranges` from the API, rendered
  as `<mark>` — the API never returns HTML), and a `locale` badge when the hit came from `en`.
- Empty state: "No page matches *q*" + the three most popular pages + "Ask your administrator"
  (mailto from the `docs` document's `supportEmail`, when set).
- Zero-results queries are logged at `debug` with the term length only — never the term itself in
  production logs (§12).

### 5.5 Table of contents, breadcrumbs, prev/next

Derived on the server from the parsed blocks, so the TOC cannot disagree with the body. `toc` carries
`{ id, text, level }` for h2 and h3 only; h4 stays in the body without cluttering the rail.

### 5.6 Contextual help — "Learn more"

Three wiring points, all server-driven:

1. **`HelpTip`** gains an optional `docKey`:

   ```tsx
   <HelpTip docKey="admin/main-menu">Reordering applies to every role at once.</HelpTip>
   ```

   The tooltip keeps its text and adds a "Learn more →" link to `/docs/<docKey>`. This finally puts the
   unused Phase 20 component to work.
2. **Admin tabs** — the tab descriptor gains `docKey?: string`, so `AdminSettingsShell` renders a small
   book icon in the tab header for every tab that has a page. One change covers all eighteen tabs.
3. **Module screens** — the pages listed in §4.8 P0 carry a "Documentation" link in their header
   (`PageHeader`-style action), pointing at their own page.

The lint (§13.3) asserts that every `docKey` in the admin catalog and every `docKey` passed to
`HelpTip` resolves to a real page — a rename cannot leave a dead link.

### 5.7 Sidebar, avatar menu and command palette

- **Sidebar**: one new page seed in `NAVIGATION_PAGES` —

  ```ts
  {
    key: 'docs',
    kind: 'page',
    route: '/docs',
    labelKey: 'web.docs.title',
    icon: 'BookOutlined',
    order: 80,
    inQuickSearch: true,
    feature: { module: 'docs', flag: 'showInSidebar' },
  }
  ```

  `NAVIGATION_FEATURE_GATE` in `AppModule` learns `module === 'docs'` and returns the `docs`
  document's `showInSidebar`. Because the gate runs **after** the ACL and after the navigation
  document, an administrator can still hide the entry from the Main Menu tab, and the flag can only
  remove an entry — never reveal one.
- **Avatar menu**: a "Help & documentation" item, always present while the document's
  `showHelpMenu` is true. It opens `/docs` (or `externalUrl`, §6.1).
- **Command palette**: a `Documentation` group in `commands` mode, filled from
  `GET /Docs/search?q=…&limit=5` when the query is at least two characters, debounced. An empty query
  shows the four getting-started pages. Nothing is fetched before the palette opens.

### 5.8 States, print and sharing

| State | Behaviour |
|---|---|
| Loading | Skeleton of the reader layout (title bar, three paragraphs), never a spinner over a blank page |
| Empty corpus | "Documentation is not installed on this instance" + the admin's contact link; one server warning at boot |
| Unknown slug | 404 page: "This page does not exist" + search + section index (never a bare error) |
| Forbidden | A non-admin opening an admin URL directly gets the existing `PermissionDenied` state, not a 404 — the page exists, the caller may not read it |
| Docs disabled | `/docs` renders "Documentation has moved" with `externalUrl` when set, otherwise the empty state |
| Print | `@media print` stylesheet, per-page sheet breaks, URLs printed after links |
| Share | "Copy link" copies the absolute URL including the anchor; no share tokens, no expiry |

### 5.9 Accessibility

- One `<h1>` per page (the front-matter title), headings never skip a level — the lint enforces the
  body heading order.
- The reader is a `<main>` with a skip link ("Skip to content") that is the first focusable element.
- The TOC is a `<nav aria-label="On this page">`; the current item is `aria-current="true"`.
- Search results are announced through the existing `#carocrm-live-region` ("12 results for *menu*").
- Focus is moved to the heading on anchor navigation and to the results list on search submit.
- Contrast, focus-visible rings, 44 px touch targets and `prefers-reduced-motion` come from the Phase
  20 tokens — no new colours are introduced for docs.
- Images carry the author's `alt`; a decorative image is not allowed (the lint requires `alt`).

### 5.10 Responsive behaviour

| Viewport | Layout |
|---|---|
| ≥ 1180 px | Three columns (section rail, prose, TOC) |
| 900–1179 px | Two columns (rail collapses into a `<details>`-style disclosure above the prose; TOC hidden) |
| < 900 px | One column, prose at full width with 16 px gutters, TOC behind a "Contents" button |
| Print | Single column, no chrome |

No horizontal scrolling at 390 px; tables scroll inside their own container.

---

## 6. Domain Model and Persistence Design

### 6.1 The `docs` settings document

Registered in `platform-settings.ts` beside `brand`, `i18n` and `navigation`:

```ts
// apps/api/src/admin-panel/docs-settings.ts
export const DOCS_SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true),
  showInSidebar: z.boolean().default(true),
  showHelpMenu: z.boolean().default(true),
  externalUrl: z.string().url().nullable().default(null),
  landingPage: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/).nullable().default(null),
  supportEmail: z.string().email().nullable().default(null),
});
```

| Property | Meaning |
|---|---|
| `enabled` | When false, the docs endpoints answer `404` and the SPA shows the disabled state |
| `showInSidebar` | Drives the navigation feature gate (§5.7) |
| `showHelpMenu` | The avatar-menu item |
| `externalUrl` | An organisation that hosts its own wiki: `/docs` and every doc link redirect there |
| `landingPage` | Overrides the landing's "Start here" first card |
| `supportEmail` | The "Ask your administrator" mailto in empty states |

Registration: `name: 'docs'`, `group: 'documentation'`, `readLevel: 'user'`, `writeLevel: 'admin'`,
`storage: 'envelope'`. **No migration** — the row appears on first write; before that, defaults apply.

### 6.2 The content index (in memory, per process)

```ts
interface DocsIndex {
  locale: string;
  hash: string;                    // sha256 of every file's path + content
  sections: DocSection[];          // ordered, ACL not applied
  pages: Map<string, DocPage>;     // key = "section/slug", fully parsed
  tokens: Map<string, Posting[]>;  // normalized token → hits, for search
  warnings: DocsWarning[];         // bad front-matter, dead links, missing assets
}
```

Built lazily on the first request for a locale, then reused. The corpus is ~38 pages and a few hundred
kilobytes, so the whole index is a few megabytes at most and no database, cache server or search
engine is involved.

### 6.3 Cache and invalidation

| Layer | Key | Invalidated by |
|---|---|---|
| Index | locale | Content hash change (dev: `mtime` poll every 2 s; prod: process restart) |
| `GET /Docs/tree` | `locale + hash + userId` | Same as the index; the user id is in the key because the tree is ACL-filtered |
| `GET /Docs/page/…` | `locale + hash + key + userId` | Same |
| `docs` document | `app_settings` row | The existing settings cache; a write calls `NavigationService.invalidate()` so the sidebar follows |

`ETag: W/"<hash>-<locale>"` on the tree and on each page; `If-None-Match` answers `304` with no body.
The SPA stores the hash in `localStorage` per locale, exactly like the i18n catalog, so a returning
reader downloads the index once per release.

### 6.4 Audit and retention

Reading docs is **not** audited: it is reference material, not business data, and auditing every page
view would drown the audit log. The only audited action is writing the `docs` settings document, which
flows through the existing settings-document audit path with no extra work.

---

## 7. Backend Architecture

### 7.1 Module boundaries

```text
content/docs/**  ──►  packages/docs (pure engine)  ──►  apps/api/src/docs (Nest module)  ──►  SPA
                      parse · index · search              HTTP · ACL · settings · cache
```

- **`packages/docs`** is a pure TypeScript package: no Nest, no filesystem writes, no network. It takes
  file contents (`{ path, content }[]`) and returns an index. Everything in it is unit-testable
  without a database or a server, which is where the majority of this phase's automated coverage
  lives.
- **`apps/api/src/docs`** is a thin kernel module: it reads files, holds the cache, applies ACL and
  settings, and exposes the HTTP surface. It owns no content logic.

### 7.2 `packages/docs` layout

```text
packages/docs/
  package.json
  tsconfig.build.json
  src/
    index.ts               barrel: parseDocument, buildIndex, searchIndex, lintContent, types
    types.ts               DocBlock, DocInline, DocPage, DocSection, DocSearchHit, DocsWarning
    front-matter.ts        a 40-line YAML-subset reader (scalars, inline arrays, inline maps) + Zod schema
    parser.ts              Markdown subset → DocBlock[] (headings, paragraphs, lists, tables, code,
                           callouts, images, dividers, inlines)
    slug.ts                slugify, headingId, de-duplication
    index-builder.ts       files → DocsIndex (sections, order, prev/next, related, warnings)
    search.ts              normalizeForSearch, tokenize, Posting, score, snippet with ranges
    links.ts               classifyHref, resolveDocLink, validateAppRoute
    lint.ts                the content contract as a pure function (§13.3)
    *.test.ts              beside the source, per repository convention
```

No runtime dependency beyond `zod` (already a workspace dependency). A Markdown library was
considered and rejected: it emits HTML (which this phase must not render), it cannot enforce the
subset, and it would be a second rendering engine next to the one the SPA needs. The parser is ~400
lines and fully covered by tests.

### 7.3 `apps/api/src/docs` layout

```text
apps/api/src/docs/
  index.ts               DOCS_CONTROLLERS / DOCS_PROVIDERS barrel
  docs.module.ts         providers + controllers
  docs.controller.ts     GET /Docs/tree | page/:section/:slug | search
  docs.service.ts        resolveDocsDir, read files, build/caches indices, settings, ACL filtering
  docs-settings.service.ts   read/write the `docs` document (registered in platform-settings.ts)
```

`DOCS_CONTROLLERS` is spread into `AppModule` **before** the generic `:entity` wildcard controller,
next to `I18nController` — the same reason: `/Docs` is a static prefix and must never be read as an
entity name.

### 7.4 Services

**`DocsService`**

```ts
class DocsService {
  tree(locale: string): Promise<DocsTree>;                     // ACL-filtered
  page(key: string, locale: string): Promise<DocPage>;         // ACL-checked, fallback applied
  search(q: string, locale: string, limit: number): Promise<DocsSearchResult>;
  contentHash(locale: string): string;
  private index(locale: string): DocsIndex;                    // lazy, cached
  private visible(page: DocPageMeta): Promise<boolean>;         // audience + requires
}
```

**`DocsSettingsService`** — `settings()` (30 s cache, defaults on miss), `save(patch)` (validates,
writes the envelope, invalidates the navigation cache). Same shape as `CRMChatSettingsService`.

### 7.5 Transaction and consistency rules

- Docs reads never open a transaction; they touch no business table.
- The `docs` document write is a single `app_settings` upsert inside the existing settings-document
  service, which already guarantees version and optimistic concurrency.
- Index building is **all-or-nothing per locale**: a parse error leaves the previous index in place
  and records a warning, so one broken page cannot blank the whole documentation area. In
  `NODE_ENV=test` and in the lint, the same error is a hard failure.

### 7.6 Events and hooks

None. No domain event, no hook, no job. Docs are read-only content plus one settings document; adding
an event surface here would be invented architecture.

---

## 8. API Plan

All endpoints are under `/api/v1/Docs`, require an authenticated session, and are documented with
`@ApiTags('Docs')` so the runtime OpenAPI spec covers them.

### 8.1 Endpoints

| Method | Path | Purpose | Notes |
|---|---|---|---|
| `GET` | `/Docs/tree?locale=vi` | Sections and pages for the caller | ACL-filtered, ETag, 30 s cache |
| `GET` | `/Docs/page/:section/:slug?locale=vi` | One parsed page | `ETag`/`304`, 404 unknown, 403 forbidden |
| `GET` | `/Docs/search?q=…&locale=vi&limit=20` | Ranked hits with snippets | `limit` 1–50, default 20 |

No write endpoint. No asset endpoint (§4.5). The settings document uses the existing
`GET/PATCH /Settings/documents/docs` routes.

### 8.2 Response shapes

```jsonc
// GET /Docs/tree
{
  "enabled": true,
  "externalUrl": null,
  "locale": "vi",
  "fallbackLocale": "en",
  "hash": "3f9c…",
  "sections": [
    {
      "key": "admin",
      "title": "Administrator handbook",
      "summary": "Configure the instance without a code change.",
      "audience": "admin",
      "order": 20,
      "pages": [
        { "key": "admin/main-menu", "slug": "main-menu", "path": "/docs/admin/main-menu",
          "title": "Main menu", "summary": "Enable, rename, reorder…", "audience": "admin",
          "order": 30, "updated": "2026-10-21", "fallback": false }
      ]
    }
  ]
}

// GET /Docs/page/admin/main-menu
{
  "page": {
    "key": "admin/main-menu", "path": "/docs/admin/main-menu",
    "title": "Main menu", "summary": "Enable, rename, reorder…", "audience": "admin",
    "locale": "vi", "fallback": false, "updated": "2026-10-21",
    "blocks": [ { "type": "paragraph", "inlines": [ … ] } ],
    "toc": [ { "id": "enable-an-entry", "text": "Enable an entry", "level": 2 } ],
    "prev": { "key": "admin/branding-and-localization", "title": "Branding…", "path": "…" },
    "next": { "key": "admin/users-teams-roles", "title": "Users…", "path": "…" },
    "related": [ { "key": "admin/settings-overview", "title": "The administration area", "path": "…" } ]
  }
}

// GET /Docs/search?q=cau hinh
{
  "query": "cau hinh", "locale": "vi", "total": 3,
  "hits": [
    { "key": "admin/settings-overview", "path": "/docs/admin/settings-overview",
      "title": "The administration area", "section": "admin", "audience": "admin",
      "locale": "vi", "score": 128,
      "snippet": { "text": "…mọi thứ bạn cấu hình cho instance nằm ở đây…",
                   "ranges": [[7, 14]] } }
  ]
}
```

### 8.3 Caching, conditional requests and limits

- `ETag: W/"<contentHash>-<locale>"`; `If-None-Match` → `304`, empty body.
- `Cache-Control: private, max-age=0, must-revalidate` — content is per-caller, so no shared cache.
- Query length ceiling 120 characters; `limit` clamped to 50; `locale` must be an enabled locale,
  otherwise the instance default is used (never a 400 — the reader should not break on a bad bookmark).
- Page payload ceiling 256 KB; a page that exceeds it is a lint failure, not a runtime truncation.

### 8.4 Errors

| Situation | Status | Body `code` |
|---|---|---|
| Unknown section or slug | `404` | `notFound` |
| Docs disabled, page requested | `404` | `featureDisabled` |
| Admin page, non-admin caller | `403` | `forbidden` |
| Portal principal | `403` | `forbidden` |
| Invalid `limit` | `422` | `validationFailed` (platform `ValidationError` mapping) |

Errors use the platform body shape `{ error: { code, message, details } }` — no new error envelope.

### 8.5 OpenAPI

`@ApiTags('Docs')`, `@ApiOperation`, `@ApiResponse` for 200/304/403/404 on all three routes. The spec
is generated at runtime; no `api-spec/` file is added (PLAN §58 remains a separate phase).

---

## 9. Frontend Plan

### 9.1 Structure

```text
apps/web/src/
  pages/docs/
    DocsLayout.tsx        rail + prose + TOC, section/page lists, responsive collapse
    DocsLandingPage.tsx   audience cards, start-here, recent
    DocsSectionPage.tsx   section index
    DocsPage.tsx          the reader (blocks, TOC, prev/next, related, actions)
    DocsSearchPage.tsx    results, snippet highlight, live-region announcement
  components/docs/
    DocBlocks.tsx         block renderer (paragraph/heading/list/code/callout/table/image/divider)
    DocInline.tsx         inline renderer; internal links become router <Link>
    DocCallout.tsx        note/tip/warning/danger with antd Alert styling
    DocTable.tsx          antd Table-free semantic <table> with a scroll container
    DocToc.tsx            sticky TOC with IntersectionObserver
    DocSearchInput.tsx    debounced input, reused by landing and layout
    DocFeedback.tsx       "Was this page useful?" — local only (§17 P2 for server-side)
  state/docs.ts           useDocsTree, useDocPage, useDocSearch, useDocsSettings
  api/types.ts            DocsTree, DocPage, DocBlock, DocSearchHit, DocsSettings
  api/client.ts           docsTree, docsPage, docsSearch (three thin methods)
```

Route registration in `AppRoutes.tsx`, before `/:entity`:

```tsx
<Route path="/docs" element={<DocsLandingPage />} />
<Route path="/docs/search" element={<DocsSearchPage />} />
<Route path="/docs/:section" element={<DocsSectionPage />} />
<Route path="/docs/:section/:slug" element={<DocsPage />} />
```

### 9.2 Interaction rules

1. **No full-page spinner.** The layout renders immediately; the prose area shows a skeleton.
2. **Navigation preserves the reader's place** — following a link scrolls to the top of the prose
   column, not the window top, unless the target is an anchor.
3. **Anchors are addressable.** Clicking a TOC entry updates the URL (`replace`, no history spam) and
   the heading gets focus.
4. **Search is shareable and back-button safe** — `?q=` is the state.
5. **A dead link never bounces silently.** An internal doc link to a missing page renders in place as
   an inline warning ("This link is broken — *admin/old-page*") instead of navigating to a 404; the
   lint makes this unreachable in a release, but a stale bookmark must still behave.
6. **"Open this screen"** appears only when the page has an app link, and it opens in the same tab.

### 9.3 Design system and reading typography

Uses the existing tokens and antd theme (`theme.ts`); no new palette.

| Token | Value | Reason |
|---|---|---|
| Measure | `72ch` | 65–75 characters is the readable band |
| Body size / line height | 15 px / 1.65 | Denser than marketing, looser than a data grid |
| Heading scale | h1 26/32, h2 20/28, h3 16/24, h4 15/22 | Clear hierarchy inside a dense app |
| Paragraph spacing | 0.9em | |
| Code | existing mono stack, `background: var(--carocrm-surface-2)` | |
| Callout colours | antd `info` / `success` / `warning` / `error` semantics | Reuse, never invent |
| Max page width | 1180 px including rails | |

### 9.4 State management

TanStack Query, exactly like `state/admin.ts`:

```ts
export const DOCS_TREE_KEY = ['docs', 'tree'] as const;

useDocsTree()                  // staleTime 5 min, keyed by locale
useDocPage(section, slug)      // staleTime 5 min, keyed by locale + key
useDocSearch(q)                // enabled when q.length >= 2, staleTime 30 s, placeholderData keeps
                               // the previous results visible while typing
useDocsSettings()              // from the settings-document endpoint, staleTime 60 s
```

A locale switch (existing avatar-menu flow) invalidates `['docs']` so the reader repaints in the new
language; the existing i18n activation already re-renders the tree.

### 9.5 Rendering the blocks

`DocBlocks` is a pure switch over `DocBlock['type']` — no HTML injection, no `dangerouslySetInnerHTML`,
no `innerHTML`. Internal links resolve through `useNavigate`; external links get
`rel="noopener noreferrer"`. Images use plain `<img>` with `loading="lazy"`, `width`/`height` from the
asset manifest when present, and the caption as a `<figcaption>`.

---

## 10. Security and Authorization Matrix

### 10.1 Threat model

| Threat | Control |
|---|---|
| **Path traversal** (`../../etc/passwd`, `%2e%2e%2f`) | The slug is **never** joined to a path. The request key is looked up in the in-memory `pages` map built from a directory scan; a key that is not in the map is `404`. No `fs` call ever receives caller input. |
| **XSS through content** | No HTML is produced or rendered. Raw HTML in a page is escaped by the parser and refused by the lint. Link `href` is validated against `^https?://` or a root-absolute path. |
| **Content leaking to the wrong audience** | `audience` and `requires` are applied server-side on tree, page and search. Docs are **descriptive, never authoritative**: hiding a page is convenience, and the underlying screen still enforces ACL. Stated in the page footer of admin pages. |
| **Portal exposure** | Portal principals receive `403` on every `/Docs` route and have no docs route in the SPA. |
| **Enumeration** | A non-admin requesting an admin page gets `403` (the page exists) — deliberately, because a `404` would make the docs area inconsistent with the rest of the product, where a forbidden record is `403`. No data is returned in either case. |
| **DoS through search** | Query length ≤ 120, `limit` ≤ 50, search runs over an in-memory index with a hard result cap, and the endpoint is behind the existing rate limiter. |
| **Secret leakage in content** | The lint refuses token-shaped strings (`sk-`, `Bearer `, long hex/base64 blobs) and `@`-addresses in code blocks. Screenshots are reviewed against §4.7 rule 6. |
| **Supply chain** | No new runtime dependency is added for parsing or rendering. |

### 10.2 Authorization matrix

| Caller | `/Docs/tree` | `/Docs/page` (user) | `/Docs/page` (admin) | `/Docs/search` | `docs` document read | write |
|---|---|---|---|---|---|---|
| Anonymous | `401` | `401` | `401` | `401` | `401` | `401` |
| Portal user | `403` | `403` | `403` | `403` | `403` | `403` |
| CRM user | `200`, user sections only | `200` | `403` | `200`, user hits only | `200` | `403` |
| Admin | `200`, all sections | `200` | `200` | `200`, all hits | `200` | `200` |
| sysAdmin | same as admin | `200` | `200` | `200` | `200` | `200` |

An admin page whose `requires` names an entity the admin cannot read is hidden from that admin too —
`requires` is an ACL check, not a hint.

### 10.3 Security-specific tests

`apps/api/test/docs.test.ts` asserts, at minimum:

1. `/Docs/page/..%2f..%2fpackage.json` → `404`, and no file outside `content/docs` is read.
2. A CRM user's tree contains no `admin` section and no admin page key; direct page fetch → `403`.
3. A CRM user's search for a term that only appears in admin content returns zero hits.
4. A portal principal gets `403` on all three routes.
5. `PATCH /Settings/documents/docs` as a CRM user → `403`; as an admin → `200`.
6. A page containing `<script>alert(1)</script>` produces a `text` block, never markup (parser unit
   test plus an API round-trip).

---

## 11. Validation, Business Rules and Failure Modes

| Rule | Enforcement | Failure mode |
|---|---|---|
| Every page has valid front-matter | Lint + index builder | Index records a warning; in test/lint it fails |
| Slug and section names are URL-safe and unique | Lint | Duplicate key refuses the second file |
| `order` unique within a section | Lint | Duplicate → lint failure (deterministic ordering matters for prev/next) |
| Every internal doc link resolves | Lint | Failure |
| Every app link resolves to a known route | Lint (static allowlist) | Failure |
| Every referenced asset exists; every asset is referenced | Lint | Failure |
| Every `docKey` in the admin tab catalog and in `HelpTip` resolves | Lint | Failure |
| `en` is complete; `vi` never has a page `en` lacks | Lint | Failure |
| Redirects: no cycles, no chains, target exists | Lint | Failure |
| Body heading levels never skip | Lint | Failure |
| Page payload ≤ 256 KB | Lint + API guard | Lint failure; API truncates never — it refuses at build time |
| Missing `content/docs` directory | Service | Boots, logs one warning, `/docs` renders the empty state |
| Broken page at runtime | Service | Previous index retained, warning recorded, page answers `404` |
| Docs disabled | Settings | `404` on page routes, `enabled: false` in the tree, SPA shows the disabled state |

---

## 12. Notifications, Audit and Observability

- **Logs** (pino, structured):
  - `docs.index.built` — `{ locale, pages, hash, ms, warnings }` at `info`, once per locale per process.
  - `docs.index.warning` — `{ locale, key, code, message }` at `warn`, once per warning.
  - `docs.content.missing` — `{ dir }` at `warn`, once, when the content directory is absent.
  - `docs.search.empty` — `{ locale, queryLength }` at `debug` only; **never** the query text.
- **No audit rows** for reads (§6.4). The `docs` document write is audited by the existing settings
  path.
- **No notifications, no jobs, no queue.** Nothing in this phase needs a worker.
- **Health**: `/health/ready` is untouched. The docs index is built lazily, so a broken corpus cannot
  fail readiness — a deliberate choice, because documentation must never take the CRM down.
- **Admin visibility**: the docs settings tab shows `pages`, `locale coverage %`, the content hash and
  the index warnings, so an administrator can see "12 of 38 pages translated" without shell access.

---

## 13. Testing Strategy

### 13.1 Unit tests — `packages/docs/src/*.test.ts`

| File | Covers |
|---|---|
| `parser.test.ts` | Every block type; nesting; inline emphasis and code; links; tables with alignment; callouts; fences with and without a language; malformed input (unclosed fence, broken table, stray `#`); raw HTML escaped; CRLF input; BOM; unicode/Vietnamese text |
| `front-matter.test.ts` | Scalars, inline arrays, inline maps, quoted strings, missing required fields, unknown keys, wrong types |
| `slug.test.ts` | `slugify`, heading ids, de-duplication, accent stripping (`Cấu hình` → `cau-hinh`) |
| `index-builder.test.ts` | Section/page ordering, prev/next across sections, related resolution, locale fallback flags, warning collection, deterministic output for the same input |
| `search.test.ts` | Ranking (title > heading > tag > body), diacritic-insensitive matching, phrase bonus, snippet boundaries and `ranges` correctness, cap, empty query |
| `links.test.ts` | Internal resolution (relative and key form), app-route allowlist, external scheme refusal (`javascript:`, `data:`), redirect cycle detection |
| `lint.test.ts` | Each rule fails on a purpose-built fixture and passes on the shipped corpus |

### 13.2 Repository / integration tests — `apps/api/test/docs.test.ts`

Uses the existing `bootApi()` helper against the configured primary database. No new table, so the
only records created are `AGENT_TEST_`-prefixed users/roles needed to exercise the matrix.

Covers: tree shape and ordering; page fetch and ETag/`304`; `404` unknown; `403` audience; portal
`403`; traversal attempts; search scoping and ranking; locale fallback; `docs` document read/write
levels; navigation entry present/absent with `showInSidebar` toggled (and the cache invalidated);
disabled instance behaviour.

### 13.3 Content contract test — `apps/api/test/docs-content.test.ts`

The lint, run against the **shipped corpus**, in CI:

```ts
const report = lintContent(loadContent('content/docs'));
expect(report.errors).toEqual([]);
expect(report.stats.pages.en).toBeGreaterThanOrEqual(38);
expect(report.stats.coverage.vi).toBeGreaterThan(0);
```

This is the test that makes "shipping a feature without its page" visible. It is also where the
admin-tab `docKey` cross-check lives, because it needs the server's tab catalog.

### 13.4 Frontend tests

This repository has **no frontend test runner** (documented Phase 20 deferral). The UI half is
verified by:

1. A **manual browser walkthrough** of §13.5 scenarios at 1440, 1024 and 390 px.
2. The **Playwright spec** in §13.5, which is the automated part.
3. A **keyboard-only** pass: open docs from the sidebar, search, open a page, use the TOC, print
   preview, copy link.

Stated honestly in the Definition of Done rather than claimed as covered.

### 13.5 End-to-end — `e2e/docs.spec.ts`

One spec, five tests, reusing the seeded demo data:

1. Open `/docs` from the sidebar → landing renders both cards for an admin.
2. Open a user page from the landing → prose renders, TOC has entries, "Open this screen" navigates
   to the documented route.
3. Search `cau hinh` (no diacritics) → at least one hit, snippet highlighted, Enter-able.
4. Sign in as a non-admin → the admin card and the admin section are absent; `/docs/admin/main-menu`
   directly → the permission-denied state.
5. Deep link with an anchor → the heading is scrolled into view and focused.

### 13.6 Accessibility

- Heading order, landmark structure and `aria-current` are asserted by the lint (structure) and by the
  Playwright spec (landmarks exist, skip link is first in tab order).
- No automated axe run: no axe dependency exists in this repository, and Phase 21 does not add one
  (documented, same as Phase 20).

---

## 14. Performance and Scalability

| Metric | Target | How |
|---|---|---|
| Index build (one locale) | < 100 ms for 38 pages | Single pass, no I/O in the builder, pure functions |
| `GET /Docs/page` (warm) | < 15 ms server time | In-memory map lookup, no rendering on the server |
| `GET /Docs/tree` (warm) | < 20 ms | Cached per user + locale + hash |
| `GET /Docs/search` | < 10 ms for a 38-page corpus | Inverted token map, cap 50 |
| Memory | < 15 MB for both locales | Parsed pages + postings |
| SPA first paint of `/docs` | Layout immediately, prose after one request | Route-level lazy chunk, skeleton |

Scaling limits, stated rather than engineered around: at ~500 pages the index is still small, but the
build time and memory grow linearly. If the corpus ever exceeds that, the plan is to pre-build the
index at deploy time and ship it as JSON — not to add a search engine. Recorded in §17 P2.

---

## 15. Migration and Installation

### 15.1 Migrations

**None.** No table, column, index or seed row is added. The `docs` settings document is an
`app_settings` row created by the existing settings-document service on first save; before that the
defaults apply.

### 15.2 Deployment

- `content/docs/` must be present in the deployed artifact (it ships with the repository).
- `DOCS_DIR` overrides the location, resolved the same way as `I18N_DIR` (walk up to the repository
  root, then the env var wins) — the same fix for "the process cwd is not always the repo root".
- `apps/web/public/docs-assets/` ships with the SPA build.
- The worker needs nothing.

### 15.3 Backward compatibility and upgrade notes

- An existing installation upgrades with no action: `/docs` appears in the sidebar with 38 pages, and
  `vi` pages appear as they are translated.
- An installation that does not want it turns the entry off in **Main Menu** (`docs` → off) or sets
  `docs.enabled = false`.
- An installation that already has a wiki sets `externalUrl`; `/docs` and every contextual
  "Learn more" link then point there, and the built-in pages stay available at
  `/docs?internal=1` for administrators.
- Nothing in `docs/` is renamed or rewritten; the engineering record is untouched.

---

## 16. Documentation Deliverables

| File | Content |
|---|---|
| `PLAN_Phase_21_Documentation.md` | This plan |
| `PLAN.md` §57 | Phase 21 entry with scope and acceptance |
| `docs/admin/documentation.md` | How the docs surface works: content tree, front-matter, lint, settings document, deployment |
| `docs/reference/docs-authoring.md` | The author's guide: the Markdown subset, screenshots, review rules, how to add a page in 10 minutes |
| `docs/compatibility/documentation.md` | Deferrals, deviations from this plan, known limitations |
| `docs/reference/alpha-status.md` | Phase 21 status line |
| `docs/reference/compatibility-matrix.md` | "In-app documentation — new design — P1" row |
| `content/docs/**` | The 38 pages themselves (this is the product deliverable, not an afterthought) |

---

## 17. Implementation Phases and Work Order

Each sub-phase is independently reviewable and leaves the tree green. Do not attempt the whole phase
in one pass.

> **Progress (2026-10-21).** **Phase 21 is complete** — 21.0–21.10, except 21.3's screenshots, which a
> browser pass this scope excluded. `packages/docs` (parser, index, search, links, lint) is green with
> 174 unit tests, `content/docs/en/` carries the 17 P0 pages plus four section descriptors, and the corpus
> lint runs in two places: `packages/docs/src/corpus.test.ts` checks the shipped files alone, and
> `apps/api/test/docs-content.test.ts` re-runs it with server knowledge (the admin tab catalog and the
> entity route allowlist), which is the only place the §13.3 cross-check can live.
> `apps/api/src/docs` serves `GET /Docs/{tree,page,search}` with ETag/304, the §10.2 matrix, the `docs`
> settings document and the sidebar entry, covered by `apps/api/test/docs.test.ts` (28 tests).
> 21.5 is done too: `/docs`, `/docs/:section` and `/docs/:section/:slug` render the block tree in a
> three-column reader (verified in Chromium at 1440/1024/390 and in print emulation — TOC click focuses the
> heading, no horizontal overflow, chrome hidden on paper, a CRM user sees no administrator section and gets
> the permission-denied card at a direct admin URL).
> 21.6 is done too: the landing carries the search field, `/docs/search?q=…` renders ranked hits with
> `<mark>` built from the API's `ranges`, the avatar menu has "Help & documentation", and the palette has a
> `Documentation` group that requests nothing until it opens. Two defects surfaced while verifying it in
> Chromium: the command palette dialog has had **no positioning since Phase 20** (it rendered below the
> fold, so no one could see it) — fixed in `carocrm.css`; and search could not answer a prefix (`side` for
> `sidebar`), so `searchIndex` now falls back to prefix tokens when the exact word is absent.
> 21.7 is done too: admin tab descriptors carry `docKey` and `AdminSettingsShell` shows the book icon,
> `HelpTip` gained a `docKey` "Learn more" row, eight P0 screen headers link to their page, and the new
> `Docs` settings tab edits the `docs` document and renders coverage plus warnings from an admin-only
> `diagnostics` block on `/Docs/tree`. Verified in Chromium: the icon resolves to `/docs/admin/main-menu`
> and clicking it lands there, the tooltip link follows it, a CRM list header links to
> `/docs/user/lists-and-views`, and setting `externalUrl` moves **every** contextual link at once (then
> restores). Two defects found only by looking at it: the "Learn more" link inherited the light-surface
> colour and was unreadable on the dark tooltip, and the coverage footnote rendered literal backticks.
> **Not built yet:** nothing in scope. The two open items are both deliberate: the corpus has **no
> screenshots** (21.3 deferred them and the plumbing already supports them), and the `vi` set is **P0 only**
> — 17 of 38 pages — with the Vietnamese prose still needing a native-speaker review (§4.7). Both are
> recorded in `docs/compatibility/documentation.md`.
> 21.8 is done too: the corpus is the full §4.8 inventory — 38 `en` pages across four sections (the new
> `reference` section included) — and `vi` translates the 17 P0 pages plus the section descriptors, with
> everything beyond them falling back to English behind the notice. Verified in Chromium: four doors on
> `/docs`, a P1 admin page and the glossary render with zero dead links, the `vi` reader shows Vietnamese
> for a translated page and the fallback notice for an untranslated one, and the admin `Docs` tab reports
> 38 pages / 45% translated.
> 21.9 is done too, and it earned its keep: there was **no skip link**, antd's `a:focus { outline: 0 }` had
> stripped the keyboard focus ring from **every link in the app**, the search page stole the caret out of the
> field on every debounced response, a closed `<details>` still painted its contents on a phone, and the
> 900–1179 band left the prose 464 px instead of collapsing the rail as §5.10 specifies (now 681 px). All
> five fixed and re-measured; the keyboard-only walkthrough completes §13.5 scenarios 1, 2, 3 and 5.

### Phase 21.0 — Audit, content contract and parser skeleton ✅

Tasks:

1. Re-read `i18n.service.ts` (`resolveCatalogDir`, `contentHash`), `navigation-defaults.ts`,
   `platform-settings.ts`, `AppRoutes.tsx` and `HelpTip.tsx`; confirm the seams named in §3.1 still
   match the code.
2. Write `docs/reference/docs-authoring.md` **first** — the subset, front-matter and review rules
   (§4.2–§4.7) — so the contract is reviewable before any code depends on it.
3. Create `packages/docs` with `package.json`, `tsconfig.build.json`, the barrel and `types.ts`
   (`DocBlock`, `DocInline`, `DocPage`, `DocSection`, `DocsWarning`).
4. Implement `front-matter.ts` + `slug.ts` with their tests.
5. Land three fixture pages under `content/docs/en/getting-started/` so later phases have real input.

Acceptance: `pnpm --filter @carocrm/docs build` and the package's unit tests pass; the authoring guide
describes exactly what the parser will accept.

### Phase 21.1 — The docs engine ✅

Tasks:

1. `parser.ts`: the Markdown subset → `DocBlock[]`, including callouts, tables and inline links.
2. `index-builder.ts`: files → `DocsIndex` (sections, ordering, prev/next, related, fallback flags,
   warnings).
3. `search.ts`: normalization (diacritics, case, `đ`), postings, scoring, snippet with ranges.
4. `links.ts`: href classification, doc-link resolution, app-route allowlist, redirect validation.
5. `lint.ts`: the §11 table as a pure function returning `{ errors, warnings, stats }`.
6. Unit tests for all of the above (§13.1), including a fixture corpus with one deliberate violation
   per rule.

Acceptance: the engine builds an index from a 5-page fixture in under 100 ms; every lint rule has a
failing fixture and a passing one; search finds `cau hinh` in a page containing "Cấu hình".

### Phase 21.2 — API module, settings document and navigation ✅

Tasks:

1. `docs-settings.ts`: the Zod schema, defaults, and `DocsSettingsService` (30 s cache, write +
   navigation invalidation).
2. Register the document in `platform-settings.ts` (`docs`, group `documentation`, read `user`, write
   `admin`, envelope).
3. `docs.service.ts`: `resolveDocsDir`, lazy per-locale index cache, `tree`/`page`/`search` with ACL
   filtering, `ETag`.
4. `docs.controller.ts` + `docs.module.ts` + barrel; spread into `AppModule` before the `:entity`
   wildcard.
5. `NAVIGATION_PAGES` seed + the `docs` branch in the `NAVIGATION_FEATURE_GATE` factory.
6. `apps/api/test/docs.test.ts` (§13.2).

Acceptance: the three endpoints answer for an admin and a CRM user with the §10.2 matrix; the sidebar
shows the entry and loses it when `showInSidebar` is false without a restart; `pnpm typecheck` and
`pnpm lint` are clean.

### Phase 21.3 — Administrator handbook content ✅ (screenshots pending)

Tasks: the six P0 admin pages (§4.8), each written from the shipped screens, each with at least one
app link and one "what can go wrong" section; screenshots for `settings-overview` and `main-menu`
only.

Acceptance: every P0 admin page passes the lint; every settings tab named in the page exists in
`GET /AdminPanel`; the `docKey` of each of those tabs resolves.

### Phase 21.4 — CRM user guide content ✅

Tasks: the seven P0 user pages; the `getting-started` section complete (four pages).

Acceptance: a reader who has never used the product can create a record, find it again, log a call and
export a list using only these pages — verified by walking the steps in a fresh session.

### Phase 21.5 — The reader UI ✅

Tasks:

1. `state/docs.ts`, `api/types.ts` additions, three `api/client.ts` methods.
2. `DocsLayout`, `DocsPage`, `DocsSectionPage` + `DocBlocks`/`DocInline`/`DocCallout`/`DocTable`/
   `DocToc`.
3. Routes in `AppRoutes.tsx` before `/:entity`.
4. Reading typography in the stylesheet (§9.3), print stylesheet, anchor focus handling.

Acceptance: a page renders every block type from the fixture corpus; the TOC tracks scroll; anchors
focus the heading; print preview hides chrome; no horizontal overflow at 390 px.

### Phase 21.6 — Landing, search and entry points ✅

Tasks:

1. `DocsLandingPage` (audience cards, start-here, recent) and `DocsSearchPage` (snippet highlight,
   live region).
2. `DocSearchInput` in the layout; `?q=` state.
3. Avatar-menu "Help & documentation" item; command-palette `Documentation` group.
4. `PermissionDenied` used for a forbidden page (finally consuming the Phase 20 component).

Acceptance: search works without diacritics; results are shareable and back-button safe; the palette
finds a page in ≤ 2 keystrokes after the query; a non-admin sees no admin card and no admin hits.

### Phase 21.7 — Contextual help and the admin tab ✅

Tasks:

1. `HelpTip` gains `docKey` and a "Learn more" link.
2. Tab descriptors gain `docKey`; `AdminSettingsShell` renders the book icon in the tab header.
3. `DocsTab` in the admin shell (settings, coverage, warnings, hash) + `TAB_COMPONENTS` entry +
   `admin-panel.service.ts` descriptor.
4. `docKey` on the six P0 user screens' headers.
5. The lint cross-check between the tab catalog and the corpus (§13.3).

Acceptance: every tab with a page shows the icon and lands on the right page; changing `externalUrl`
redirects every contextual link; the tab shows coverage and warnings without a shell.

Done: items 1–3 and 5 as written. Item 4 covers **eight** headers, not six — `EntityListPage`,
`EntityDetailPage`, `TasksPage`, `CalendarPage`, `StreamPage`, `SearchPage`, `DashboardsPage`,
`ReportsPage` — because the two activity screens and the two reporting screens each needed their own
entry. The ten admin tabs with a page share six distinct handbook pages, so the cross-check asserts
`six or more` resolved keys rather than one per tab.

### Phase 21.8 — Remaining content ✅

Tasks: the P1 admin pages (ten), P1 user pages (six), the `reference` section (five), plus the `vi`
translation of `getting-started` and the P0 pages.

Acceptance: 38 pages in `en`, lint clean, `vi` covers `getting-started` + all P0 pages with a visible
fallback notice elsewhere.

Done, and the corpus is now the §4.8 inventory exactly: `getting-started` 4, `user` 13, `admin` 16,
`reference` 5 = 38 pages in `en`. `vi` carries the 17 P0 pages plus the root and three section
descriptors; everything beyond that still answers in English and says so. Two things the pass fixed
beyond the new pages: the P0 `admin` section descriptor and `settings-overview` named the save-bar button
**Publish**, which is the internal hook name (`usePublishTabActions`) rather than the label the product
renders (`web.common.save` = **Save** / **Lưu**) — corrected in four pages, and the workflow editor's real
**Publish** button left alone. `corpus.test.ts` now asserts the full inventory and the exact P0/`vi` split
instead of the P0-only counts.

### Phase 21.9 — Accessibility, responsive and i18n chrome ✅

Tasks: skip link, landmarks, `aria-current`, focus moves, live-region announcements; the 900/1180 px
breakpoints; `web.docs.*` keys in `en` and `vi` (catalogs stay in parity — the i18n test enforces
count equality); keyboard-only walkthrough.

Acceptance: keyboard-only completion of the five e2e scenarios; no missing i18n key; no layout break
at 390/1024/1440 px.

Done, measured in Chromium rather than asserted. Four defects only the pass found:

1. There was **no skip link at all**. `core.app.skipToContent` now renders one as the first focusable
   element of the shell, targeting `<Content id="carocrm-content" tabIndex={-1}>`.
2. antd's `a:focus { outline: 0 }` erased the keyboard focus ring on **every link in the app**, so a Tab
   user in the sidebar could not see where they were. `html a:focus-visible` restores it without
   `!important` and without touching mouse clicks.
3. Focus moved to the results list on **every debounced response**, which pulled the caret out of the
   search field mid-word. It now moves on a submit only — including arriving with `?q=` already in the
   address bar, which is how the landing field sends you.
4. A closed `<details>` disclosure still **painted** its contents (an author `display` outranks the UA
   rule), so the phone reader saw the whole TOC under a collapsed "Contents" summary.

§5.10 also disagreed with the build at 900–1179 px: the rail stayed a 220 px column and left the prose
464 px. The rail is now the disclosure the table asks for, which gives the prose 681 px at 1024.

Keyboard-only walkthrough completed for scenarios 1, 2, 3 and 5 of §13.5 (scenario 4, the non-admin
reader, is the API matrix in `docs.test.ts` and the e2e spec in 21.10). No untranslated key renders on
the reader, the search page or the admin tab, in either language.

### Phase 21.10 — Hardening and release readiness ✅

Tasks: `e2e/docs.spec.ts`; content lint wired into `pnpm test`; `docs/admin/documentation.md`,
`docs/compatibility/documentation.md`, alpha status, compatibility matrix; `pnpm typecheck`,
`pnpm lint`, `pnpm test`, `pnpm build`; a diff review for secrets, unsafe SQL and upstream assets.

Acceptance: every command in §19 passes or has a documented reason; no migration; no extra database.

Done. The spec found one real defect while being written: a deep link with an anchor only scrolled and
focused when the **navigation tree** had also arrived, because the shell renders a skeleton in place of
the prose until it does — so the effect ran, found no heading, and scrolled to the top instead. It now
waits for both queries (`DocsPage.tsx`), and the spec has been run four times without a flake.

`pnpm test` is 2235/2236 at this hour; the one failure is a pre-existing Phase 19-SD.8 SLA assertion that
only holds inside the seeded business-hours window, recorded in `docs/reference/alpha-status.md` rather
than weakened here.

---

## 18. Priorities and Release Gates

### P0 — Required for the first usable release

- `packages/docs`: parser, index, search, lint (21.0–21.1).
- `/Docs/tree|page|search` with the §10.2 matrix (21.2).
- `docs` settings document and the navigation entry (21.2).
- The reader UI with all block types, TOC, anchors, print (21.5).
- Landing + search (21.6).
- Content: `getting-started` (4), P0 `user` (7), P0 `admin` (6) = 17 pages (21.3–21.4).
- Content lint in CI (21.10).
- `en` chrome strings; `vi` chrome strings (21.9).

### P1 — Required for the phase to be done

- Contextual help: `HelpTip docKey`, tab `docKey`, admin `DocsTab` (21.7).
- Avatar-menu item, command-palette group (21.6).
- Remaining content: P1 `admin` (10), P1 `user` (6), `reference` (5) = 21 pages (21.8).
- `vi` translation of the P0 set (21.8).
- Playwright spec (21.10).
- Accessibility and responsive pass (21.9).
- Admin/authoring/compatibility docs (§16 deliverables).

### P2 — Post-first-release

- Server-side "Was this page useful?" feedback with a small aggregate report.
- Per-entity "documentation" icon on list/detail pages, driven by a `docs` metadata hint.
- Admin-authored pages inside `/docs` (a bridge from `KnowledgeArticle`, gated by a document flag).
- Pre-built index artifact at deploy time, for corpora beyond ~500 pages.
- Public (unauthenticated) user guide export for portal users, if the portal ever needs it.
- Docs coverage report in the admin tab: features shipped without a page.

---

## 19. Definition of Done

Phase 21 is complete when all of the following hold:

- [x] `/docs` is reachable from the sidebar, the avatar menu and the command palette, and renders 38
      pages in `en` across four sections.
- [x] A CRM user sees no administrator page in the tree, in search, or at a direct URL; a portal user
      is refused on every route. (`docs.test.ts` §10.2 matrix, `e2e/docs.spec.ts` scenario 4)
- [x] Every page carries valid front-matter, valid internal links, existing assets and non-empty alt
      text; the content lint is part of `pnpm test` and fails on a regression. (no images are authored
      yet, so the `alt` rule has nothing to fail on — see the compatibility note)
- [x] Every `docKey` in the admin tab catalog and in `HelpTip` resolves to a real page.
      (`apps/api/test/docs-content.test.ts`, including a test that proves it catches a dead key)
- [x] Search matches with and without Vietnamese diacritics and returns highlighted snippets.
- [x] Anchors are addressable and focus the heading; print output is usable as a handout.
- [x] `en` and `vi` chrome catalogs are in parity; untranslated pages show the fallback notice.
- [x] The `docs` settings document round-trips through the settings API with `readLevel: user` and
      `writeLevel: admin`; `externalUrl` redirects `/docs` and every contextual link.
- [x] No migration, no new table, no new runtime dependency, no new database.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm build` pass; `e2e/docs.spec.ts` passes 5/5. `pnpm test`
      is 2235/2236 — the one failure is a pre-existing Phase 19-SD.8 SLA test that only holds inside
      the seeded business-hours window, documented in `docs/reference/alpha-status.md`.
- [x] Deferrals and deviations are written down in `docs/compatibility/documentation.md`; the
      authoring guide exists and matches the parser.
- [x] No upstream PHP source, unlicensed asset or third-party branding is copied; screenshots contain
      no customer data and no credentials. (there are no screenshots at all)

---

## 20. Suggested First Coding-Agent Task

Start with **Phase 21.0 only**.

The first agent must:

1. Read `apps/api/src/i18n/i18n.service.ts`, `apps/api/src/admin-panel/platform-settings.ts`,
   `apps/api/src/admin-panel/navigation-defaults.ts`, `apps/web/src/AppRoutes.tsx` and
   `apps/web/src/components/HelpTip.tsx`, and confirm (or correct) the seam table in §3.1.
2. Confirm that the configured primary database is the intended test target and that no test command
   provisions a database (AGENTS.MD §3), without printing credentials.
3. Write `docs/reference/docs-authoring.md` — the Markdown subset, the front-matter contract and the
   review rules — and stop for review. **The contract must be agreed before the parser exists**,
   because every later page depends on it.
4. Create `packages/docs` with `types.ts`, `front-matter.ts`, `slug.ts` and their tests, plus three
   fixture pages.

Do not start the API module or the UI in the same pass. The engine is the only part with real
algorithmic risk; get it green and reviewed first.

---

## 21. References

Functional reference (help surfaces and documentation UX):

1. EspoCRM user interface overview (help and navigation patterns): https://www.espocrm.com/user-interface/
2. EspoCRM administration areas, as the subject matter the admin handbook documents:
   https://docs.espocrm.com/development/metadata/app-admin-panel/
3. Documentation information architecture — two doors, search-first, task-oriented pages:
   https://www.nngroup.com/articles/documentation-usability/
4. Technical writing for procedures (steps, prerequisites, failure modes):
   https://developers.google.com/style/procedures
5. Reading typography and measure: https://practicaltypography.com/line-length.html
6. In-app help and contextual guidance patterns:
   https://uitop.design/blog/best-ux-practices-for-crm-and-internal-business-systems/

Internal references: `PLAN.md` (§12 Metadata, §19 Entity Manager, §37 Portals, §41 i18n, §42
Configuration, §57 Phases), `AGENTS.MD`, `PLAN_Phase_20_Settings_UX.md` (§4.4 navigation, §9 frontend,
§19 deferrals — `HelpTip` and `PermissionDenied` unused), `docs/admin/settings.md`,
`docs/admin/navigation.md`, `docs/ux/design-principles.md`, `docs/reference/alpha-status.md`.
