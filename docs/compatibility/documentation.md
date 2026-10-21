# In-app documentation — compatibility note

## Baseline

EspoCRM 9.3.x ships **no in-app product handbook**. Its documentation is external (the public user guide
and admin guide), and the closest thing inside the product is the **Knowledge Base** — an entity for
customer-facing articles, with its own categories, portals and access rules. That is a content repository
for end users of a support desk, not documentation *of* the application.

This phase is therefore recorded in `docs/reference/compatibility-matrix.md` as **new design**, not as a
parity item: there is no upstream behavior to reproduce, and nothing here was derived from upstream
source. The clean-room rule (AGENTS.MD §6) applied with unusual force — the corpus is original prose
written against this codebase, and every claim in it was checked against this repository rather than
against a vendor manual.

The in-app **Knowledge Base module is a separate feature** and is not part of Phase 21. `/docs` never reads
it, and a Knowledge Base article is not a handbook page.

## Deviations from the plan

| Plan | What shipped | Why |
|---|---|---|
| §6.3 invalidates the content cache by polling mtimes. | A **content signature** (hash over every file) computed on read, and a 30 s settings-document cache dropped on the `onChanged` signal. | ~43 small files per signature is cheaper than cache bookkeeping, and it removes a poller that could lag. |
| §8.4 error codes in lowerCamel. | The platform's UPPER_SNAKE codes (`NOT_FOUND`, `AUTHORIZATION_DENIED`, `VALIDATION_FAILED`), with `FEATURE_DISABLED` for a disabled surface as §8.4 asked. | A second error vocabulary inside one API is a defect, not a detail. |
| §8.2 tree payload: sections and page keys. | Also `sections[].blocks` — the section descriptor's own body. | `/docs/:section` renders it, and §8.1 forbids a fourth endpoint to fetch it. |
| §8.1 four endpoints. | Three (`tree`, `page`, `search`) plus the existing settings-document route. Coverage and warnings are an **admin-only `diagnostics` field on `tree`**. | A reader should not pay for a second request, and an administrator should not shell out to see it. |
| §11 lint runs in the API test. | It runs in **both**: `packages/docs/src/corpus.test.ts` on the files alone, and `apps/api/test/docs-content.test.ts` with server knowledge (the admin tab catalog and the entity route allowlist). | Only the second can catch a `docKey` that stopped resolving. |
| §5.10 search matches whole words. | Prefix fallback when the exact token is absent (`side` finds `sidebar`). | Found while verifying 21.6; a handbook that cannot answer half a word is not useful. |

## Deferrals and known limitations

- **No screenshots.** `content/docs/**` has no images, so there is no
  `apps/web/public/docs-assets/` directory and `redirects.json` is `{}`. The parser, the lint (`alt` is
  required, orphans are reported) and the renderer already support them; what is missing is authored,
  reviewed imagery that will not rot on the next UI change. Phase 21.3's acceptance named this and the
  scope excluded it.
- **`vi` covers the P0 set only** — 17 of 38 pages, 45% on the admin tab. The other 21 pages answer in
  English behind the fallback notice, which §4.7 prefers over a wrong translation.
- **The Vietnamese prose has not been reviewed by a native speaker.** §4.7 requires a human pass before
  `vi` is treated as authoritative. The chrome (`web.docs.*`, `web.adminDocs.*`, `core.app.skipToContent`)
  matches the existing catalogue's terminology; the page bodies need a reader's eye.
- **No automated accessibility run.** There is no axe dependency in this repository and Phase 21 does not
  add one (documented the same way in Phase 20). §13.6's landmarks, skip-link order, focus moves,
  `aria-current`, contrast and the 390/1024/1440 bands were measured in Chromium by script, and the
  keyboard-only walkthrough is `e2e/docs.spec.ts` plus the manual pass in 21.9.
- **No frontend unit runner.** The SPA half is covered by the Playwright spec, not by component tests — the
  same deferral every previous phase made.
- **`docs/reference/` pages are `audience: user`,** so the permission matrix and troubleshooting are visible
  to a CRM user. That is deliberate, but it means an administrator-only troubleshooting page still needs
  its own `audience: admin`.
- **Search is in-memory per process** and rebuilt when the content signature changes. There is no shared
  index and no persistence; a large corpus would need one, and 38 pages do not.
- **The app navigation chrome is not fully translated.** With the reader in Vietnamese the handbook is
  Vietnamese, but the sidebar labels (Home, Search, Dashboards) stay English because navigation labels are
  not re-resolved on a locale change. Outside Phase 21's surface; nobody owns it yet.

## What is deliberately not built

- No editing UI. Content is files in the repository, reviewed like code; §4.4 chose that on purpose, and a
  browser editor would need a permission model, a conflict story and an audit trail of its own.
- No versioning or "view this page as of release X". `updated` is a review date, not a version.
- No analytics on reading. There is no consumer for it yet, and a page-view counter over a handbook invites
  a retention question nobody asked.
- No machine translation, no glossary service, no AI answer surface over the corpus.
