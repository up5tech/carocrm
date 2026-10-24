# In-app documentation (Phase 21)

Scope: `PLAN_Phase_21_Documentation.md`. Implemented: 21.0 audit and content contract, 21.1 the engine,
21.2 the API module + settings document + navigation entry, 21.3 the administrator handbook content,
21.4 the CRM user guide content, 21.5 the reader UI, 21.6 landing, search and entry points, 21.7
contextual help and the admin tab, 21.8 the P1 pages and the `vi` translation of the P0 set, 21.9 the
accessibility/responsive/i18n pass, and 21.10 this hardening pass.

The handbook is **content, not a feature with a database**. Every page is a Markdown file shipped with the
release; the server parses it into a typed block tree and the SPA renders that tree with its own
components. Nothing a reader sees is ever raw HTML, and no record, table or migration belongs to this
subsystem.

## Where things live

```
packages/docs/src/
  front-matter.ts                   the YAML subset a page header may use
  parser.ts                         Markdown → DocBlock tree; total, never throws
  index-builder.ts                  a locale's tree, page index, landing data
  search.ts                         the inverted index and the snippet ranges
  links.ts                          href classification and the app-route allowlist
  lint.ts                           every §11 rule; errors fail the build
  corpus.test.ts                    the shipped corpus is the contract test

content/docs/
  en/{getting-started,user,admin,reference}/*.md   47 pages + section descriptors
  vi/…                                              the 18 P0 pages, translated
  redirects.json                                    old slug → new key

apps/api/src/docs/
  docs.service.ts                   content loading, ACL + audience filtering, diagnostics
  docs.controller.ts                /api/v1/Docs/{tree,page/:section/:slug,search} + ETag/304
  docs.module.ts                    wiring

apps/web/src/
  pages/docs/                       landing, section, page, search
  components/docs/                  block renderer, TOC, anchors, search field, DocsLink
  state/docs.ts                     the queries, keyed by locale
  admin/tabs/DocsTab.tsx            the settings tab and the coverage panel

docs/reference/docs-authoring.md    the author's guide — keep it in sync with the parser
```

## The settings document

`docs` is one entry in the Phase 20 settings-document registry: `readLevel: user`, `writeLevel: admin`, so
every signed-in caller can ask whether the surface exists and only an administrator can change it.

| Field | What it does |
|---|---|
| `enabled` | Off means `/docs` and every contextual link answer 404 `FEATURE_DISABLED`, and the sidebar entry disappears. |
| `showInSidebar` | Hides the navigation entry only; `/docs` still works. |
| `showHelpMenu` | The "Help & documentation" item in the avatar menu. |
| `externalUrl` | When set, the reader surface is replaced by a pointer to that address and **every** contextual link (`docKey`) points there instead. |
| `landingPage` | Overrides the first card on `/docs`. |
| `supportEmail` | Shown as "Ask your administrator" when a search finds nothing. |

Writes go through `PUT /api/v1/Settings/documents/docs` with the usual optimistic-concurrency version, and
`DocsSettingsService` drops its cache on the `onChanged` signal — which is why toggling a switch takes
effect without a restart.

## Reading rules

- **`en` defines the tree.** Other locales supply translations; a page missing from `vi` is served from `en`
  with `fallback: true`, and the reader says so. Coverage on the admin tab counts non-fallback pages.
- **Audience filters before the reader sees anything.** A section or page marked `audience: admin` is absent
  from the tree, from search, and refused with `AUTHORIZATION_DENIED` at a direct URL — the refusal is
  deliberately not a 404, because the page exists and the reader is allowed to know that.
- **`requires` filters by ACL**, using the same `AclApiService.canUser()` the screens use.
- **Portal principals are refused on all three endpoints.** A portal user has no internal handbook.
- Responses carry `ETag: W/"<content-hash>-<locale>"` and revalidate to 304; the hash is a signature over
  the corpus files, so editing a page changes it and no polling is involved.

## Adding a page

`docs/reference/docs-authoring.md` is the contract; the short version is: create
`content/docs/<locale>/<section>/<slug>.md`, give it front matter with `title`, `summary`, `audience`,
`order`, `tags`, `related` and `updated`, write inside the Markdown subset the parser implements, and run
`pnpm test`. The lint fails on a dead link, an unknown callout, a skipped heading level, a page over the
size ceiling, a secret-looking string, or an `admin` tab whose `docKey` no longer resolves — which is the
point: a handbook page that rots is worse than no page.

## Screenshots and assets

The corpus has **no screenshots**, so there is no `apps/web/public/docs-assets/` directory yet and
`redirects.json` is `{}`.
The lint already supports `alt`-required images and orphan-asset detection; the blocker is authoring and
reviewing the images, not plumbing. Pages say "on the Contact list screen" rather than pointing at a
picture that would drift on the next UI change.

## Deployment

Content is read from `DOCS_DIR`, falling back to walking up from the API's working directory to find
`content/docs`. A deployment that ships without that directory gets an honest "documentation is not
installed on this instance" state rather than an empty 404. No environment variable is required for a
normal checkout.
