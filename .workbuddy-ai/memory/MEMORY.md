# Project memory — carocrmv2

Curated long-term notes. Daily logs: `YYYY-MM-DD.md`; per-module detail in `docs/modules/`,
`docs/implementation/`, `plans/` — do not duplicate it here.

## Owner decisions (standing, do not reopen)
- **Single-tenant by design**: one deployment = one org. No tenant id/queries/per-tenant schema/
  cross-tenant tests/SCIM-multi-org/hosted SaaS. Isolation is deployment-owned
  (`docs/security/tenancy-decision.md` §2). `tenant_ref` (migration 056) / `tenantRef` are
  provider-account labels (19 files, keep). Dead `tenantId`/`getTenantId` surface removed in 24.1.
  Charter: `docs/reference/product-charter.md`; guarded by rule 8 of `scripts/check-ui-conventions.mjs`
  (5 boundary docs allowlisted; a new doc claiming multi-tenancy fails `pnpm lint`).
- CI nightly-only (G78/D3); SAML/SCIM deferred; generic OIDC shipped 23.3. Differentiator = module
  breadth, not platform DX. REST + `api-spec/` only, no GraphQL.
- Phase-19 module ids are plain (`sales`, `projects`, …), never `Ua*`.

## Repo conventions
- Domain module = `apps/api/src/<domain>` + barrel exporting `<DOMAIN>_CONTROLLERS` / `_PROVIDERS`,
  spread into `AppModule` **before** the generic `:entity` wildcard controller.
- Records = metadata entities in `entity_records` (`database/seed-metadata.ts`); cross-record rules
  on `beforeValidate`. Migrations `database/migrations/<NNN>_phase<NN>_<slug>.sql`, additive.
  Money = canonical decimal string (`sales/money/decimal.ts`).
- Web conversation screens share one CSS kit in `carocrm.css` (workspace/rail/convo prefixes);
  module prefixes only for module-only pieces. Shell height `calc(100vh - 235px)` (70+48+46+14+56).
- `pnpm lint:ui` enforces i18n keys, no `.slice(0,19)` timestamps, no raw `<Empty>`, no internal
  `<a href="/…">`. `EmptyState` only (key `core.empty*`). Time via `formatDateTime`/`formatClock`/
  `formatRelative`. `AppErrorBoundary` mounted twice (root + per-route); `OfflineBanner` uses React
  Query `onlineManager`. Sanctioned lint: `npx eslint apps packages e2e database scripts modules`.

## AI tool contributions (19-CHAT.21–24)
- Registry `AIToolRegistry` (`apps/api/src/ai-agents/ai-agent-tools.ts`); model picks a key only.
  Contribution = `@Injectable() OnModuleInit` class in the domain dir calling `tools.register(...)`
  **and** listed in that module's `*_PROVIDERS` barrel. Never import the `ai-agents` barrel from
  inside it (circular → `UndefinedDependencyException`); import `./ai-agent-tools.js`.
- Raw-SQL tools must translate record ACL themselves (`recordPredicate()` returns a predicate; SQL
  translation is private in `entity-record.store.ts`). No grant/`*` → denyAll.
- `stream_items` uses `entity_type`/`entity_id`/`is_deleted`. Catalogue after 19-CHAT.23 = 20 keys;
  19-CHAT.24 owns chip `requiresTool` data, eval cases, `docs/architecture/crm-chat-contract.md`.

## SQL / platform gotchas
- `entity_records`: `created_at` + `modified_at` (no `updated_at`). `ON CONFLICT` needs the partial
  index predicate repeated. Conditional-UPDATE claims are leases, not version bumps. Kysely
  `RawBuilder`: `(await sql`…`.execute(db)).rows[0]`.
- `ValidationError` → 422 `{error:{code,message,details}}`. `users`/`teams` are identity tables.
  ACL `delete:'no'` blocks even admins. Synthetic permission entities need no seed. `/Related` is one
  union predicate (`anyOf`), never page+stitch. Fastify hook `Error`s carry only `statusCode`;
  `GlobalExceptionFilter` must not turn 429/413 into 500.

## Tests / environment
- Mail/queue suites: `MAIL_TRANSPORT=memory` + `SMTP_FROM` before `bootApi()`, restore in `afterAll`;
  stub BullMQ. `pnpm install && pnpm build` before typecheck/tests (packages resolve via `dist/`).
  One file per `pnpm vitest run`. A test repointing the default AIAgents provider must restore the
  `aiAgents` `app_settings` row.
- Dev: API :3030, web :8080. Stale vite/tsx watchers → start a second vite on another `VITE_PORT`;
  restart tsx after adding a route. Web build: `vite build --outDir /tmp/...` (`emptyDir(dist)` fails).
- Playwright: always `no_proxy='*' NO_PROXY='*'`; move `test-results` aside before re-running
  (>50-file delete guard). `pnpm add` may hit `ERR_PNPM_CODEBUDDY_BROKER_DENY` → `npm pack` to /tmp
  + untar into `.pnpm/...` + recreate symlinks (grapesjs@0.23.8 installed this way).
- antd e2e: click `.ant-segmented-item` label (not the radio input); drawer stays mounted — assert
  `.ant-drawer-mask` count 0.

## Module pointers
- 19-MA queue-driven (037–043); 19-CS `CustomerSuccessProfile` is a fixed name; 19-VC has no
  metadata entity (051–054, class adapters, `fake` never `delivered`, `assertSafeMediaUrl` is async);
  BPM 16 definitions admin-only, visibility = initiator OR task holder; document kernel =
  `packages/document` + `apps/api/src/document`.
- GrapesJS 0.23.8 (email designer): CSS always emitted as rules → merge back inline on export
  (`inlineEmailCss.ts`); blocks need `onClick` for click-to-append; `runCommand('open-blocks')` after
  init; never pass `richTextEditor.actions`; `getSelected()` returns `undefined`.
