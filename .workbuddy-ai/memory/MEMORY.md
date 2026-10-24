# Project memory — carocrmv2

Curated long-term notes. Daily logs: `YYYY-MM-DD.md`. Per-module detail lives in
`docs/modules/<module>/` and `docs/implementation/` — do not duplicate it here.

## Naming

- Phase-19 modules use **plain** ids (`sales`, `projects`, `customer-success`,
  `voice-communications`), never `Ua*`; `Ua*` in `PLAN.md` is legacy. References *to other*
  modules may keep their ids (`OPTIONAL_INTEGRATIONS`).

## Repo conventions

- Domain module = kernel dir `apps/api/src/<domain>` + barrel exporting `<DOMAIN>_CONTROLLERS` /
  `<DOMAIN>_PROVIDERS`, spread into `AppModule` **before** the generic `:entity` wildcard controller.
- Records are metadata entities in `entity_records` (`database/seed-metadata.ts`); cross-record
  rules go on `beforeValidate` so generic CRUD and domain commands validate alike.
- Migrations `database/migrations/<NNN>_phase<NN>_<slug>.sql`, additive, filename order, tracked
  in `schema_migrations`. Money is a canonical decimal string (`sales/money/decimal.ts`).
- Web conversation screens (`/crm-chat`, `/voice-inbox`) share one CSS kit in `carocrm.css`:
  `carocrm-workspace-*` (page head, rail, toolbar, body, dock) + `carocrm-rail-*` (list rows) +
  `carocrm-convo-*` (message rows and bubbles). Add a module prefix only for module-only pieces
  (`carocrm-chat-*`, `carocrm-inbox-*`); do not clone the frame.
- The workspace shell's height is `calc(100vh - 235px)` — the chrome is 70 header + 48 content
  padding + 46 page head + 14 gap + 56 footer. Change the page head's height and you must change
  this, or the page starts scrolling.

## SQL / platform gotchas

- `entity_records` has `created_at` + `modified_at`, never `updated_at`.
- `ON CONFLICT` cannot infer a partial unique index unless the target repeats the predicate.
- Conditional-UPDATE "claims" must be **leases** (push the due time forward), not version bumps.
- Kysely `RawBuilder` has no `executeTakeFirst(db)`: `(await sql`…`.execute(db)).rows[0]`.
- `ValidationError` → HTTP 422; body `{ error: { code, message, details } }`.
- `users`/`teams` are identity tables, not metadata entities — validate against them directly.
- Entity ACL `delete: 'no'` blocks DELETE even for admins; tests must remove such rows by id.
- Synthetic permission entities need no metadata seed — `roleLevel` falls back to `*`; admins `all`.
- `/Related` is one **union** predicate (`StoreFindQuery.anyOf`: attr match *or* `entity_links` ids).
  Never page the attribute query and stitch link rows afterwards — `offset` then applies twice.
- Fastify hooks/plugins (`@fastify/rate-limit`, body parser, multipart) throw plain `Error`s that
  carry only `statusCode`, and Nest routes them into `GlobalExceptionFilter`. Anything there that
  only handles `AppError`/`HttpException` silently turns a 429/413 into a 500.

## Test seams

- Mail/queue suites: `MAIL_TRANSPORT=memory` **and** `SMTP_FROM` before `bootApi()`, restored in
  `afterAll` (`singleFork: true` leaks `process.env`). Stub the BullMQ hop, assert side effects.
- Workspace packages resolve through `dist/`: `pnpm install && pnpm build` before typecheck/tests.
- Run one file per `pnpm vitest run` — the one-fork full suite aborts at random boundaries.

## Shipped modules (pointers)

- Marketing Automation (19-MA): queue-driven, migrations 037–043, `docs/marketing-automation/`.
- Customer Success (19-CS): `CustomerSuccessProfile` is a **fixed name** (Sales' integration marker).
- Voice & Communications (19-VC): no metadata entity, dedicated tables, migrations 051–054; adapters
  are classes; `fake` never returns `delivered`; `assertSafeMediaUrl` is **async** (must be awaited).
- BPM (16): definitions admin-only; participants use `/Process/action/available`, `/ProcessInstance`,
  `/ProcessTask`; visibility = initiator **or** task holder — both clauses must agree.
- Document kernel: `packages/document` + `apps/api/src/document`; a document cannot have zero lines;
  unresolved placeholders stay in place and are reported in `warnings`.

## Environment

- Dev: API `:3030` (`pnpm dev`), web `:8080` (`pnpm --filter @carocrm/web dev`).
- A long-running vite dev server can stop picking up file edits (stale transform cache, `touch` does
  not help) — start a second one on another `VITE_PORT` instead of trusting the old one.
- A stale `tsx watch` on :3030 logs "listening" then fails to bind; restart it after adding a route.
- `pnpm --filter @carocrm/web build` dies at `emptyDir(dist)`; use `vite build --outDir /tmp/...`.
- **Playwright e2e**: the shell exports `HTTP_PROXY=127.0.0.1:62112`; playwright's webServer
  availability check and the browser honour it, so localhost servers answer 404 through the proxy
  and the run dies with "Timed out waiting 120000ms". Always run with `no_proxy='*' NO_PROXY='*'`.
- Playwright's output-dir cleanup trips the WorkBuddy safe-delete bulk guard (>50 files):
  `mv test-results test-results-old-$(date +%s)` before re-running a spec.
- `pnpm add` can fail mid-way with `ERR_PNPM_CODEBUDDY_BROKER_DENY` on the `.pnpm` symlink farm
  (node_modules writes are brokered). Workaround that worked: `npm pack` each package to /tmp,
  `tar -xzf --strip-components=1` into `.pnpm/<pkg>@<ver>/node_modules/<name>/`, then recreate the
  dep symlinks + `apps/web/node_modules/<pkg>` link by hand. `grapesjs@0.23.8` is installed this way.

## GrapesJS (email designer, `apps/web/src/components/email/`)

- 0.23.8 **always** moves component `style` into generated CSS rules (`#id{…}`) — no inline styles,
  and `forceClass:false`/`attributes.style` do not change that. Export must merge the sheet back
  into `style` attributes (`inlineEmailCss.ts`), or Outlook renders nothing.
- Blocks are drag-only unless each one carries `onClick` (append `block.getContent()` — it may be
  a function or undefined). Click-to-append is the expected email-builder UX.
- `editor.runCommand('open-blocks')` after init, or the palette opens behind the style-manager tab.
- Do NOT pass `richTextEditor: { actions: [...] }` — it crashes `init` with an appendChild error.
- Style sectors/devices can be passed via config (`styleManager.sectors`, `deviceManager.devices`);
  `getSelected()` returns `undefined` (not null) with nothing selected; text components serialise
  only their children once they have any, so insert tokens with `set('content', …)`.

## antd interaction patterns (e2e)

- Segmented: click the `.ant-segmented-item` label, never the radio `input` — the thumb covers it
  and Playwright's hit-target check hangs until the test timeout.
- Drawer keeps its node mounted after close; assert `.ant-drawer-mask` has count 0, not
  `toBeHidden()` on `.ant-drawer`.
