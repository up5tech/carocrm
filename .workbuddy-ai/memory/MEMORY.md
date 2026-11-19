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
- `stream_items` uses `entity_type`/`entity_id`/`is_deleted`. 19-CHAT.24 owns chip `requiresTool`
  data, eval cases, `docs/architecture/crm-chat-contract.md`. Catalogue was 20 keys after
  19-CHAT.23; **25 now** (15 built-in + 10 domain contributions), authoritative enumeration in
  `apps/api/test/ai-agent-runs.test.ts`; docs saying 20/21 are stale. Per-agent `MAX_TOOLS` = **32**
  (`ai-agent-config.ts:50`, confirmed 25.1).
- Runtime: `runs/executor.ts` was at the 1,500-line ceiling after 25.5; workflow resume lives in `runs/workflow-resume.ts`, 25.4 skill prompt composition in `runs/skill-prompt.ts`, and 25.7 transcript construction in `runs/transcript.ts` (executor now ~1,383 lines) to avoid growing the step loop. Bounded JSON output via `ai-agent-config.ts`; Anthropic now supports `json_schema`
  through a bounded extraction tool inside the adapter (25.3), not native response format. Only
  OpenAI-compatible + Anthropic adapters are registered; the other presets are configuration, not
  adapters. Capability rows are derived in `ai-provider-capabilities.ts` and published in the health
  view's `providers.capabilityTable`; native web search is false and context is `null`. Since 25.7 the test-only fake declares `imageInput: true` (metadata only); the real adapters stay false.
- AI parity boundary (Phase 25, **in progress; 25.0/25.1/25.2/25.3/25.4 delivered 2026-11-18;
  25.5 and 25.6 implemented 2026-11-19; 25.7 implemented 2026-11-20**):
  single-tenant only — no workspace/credits/billing/personal AI allowance; Twenty's alpha skills/agents
  and beta MCP are not parity gates. CaroCRM already ships MCP-compatible tools and stronger
  fail-closed ACL/injection evals. Canonical claim source: `docs/architecture/ai-capability-matrix.md`;
  plan: `plans/PLAN_Phase_25_AI_Capability_Parity.md`; G99 doc drift Fixed in 25.1. Published versions
  pin `config.principal.mode` (`requesting_user` default; `publisher` automated doors only,
  owner-only); service principals are refused and `service_principal` remains NULL. Every run event
  carries effective principal + pinned version. Skills (25.4) are text-only versioned records in
  `ai_agent_skills` (migration 098): stable key/version, draft→published frozen, `skillAdmin` ACL,
  exact agent bindings, subordinate prompt block, `skill.applied` event, no code execution. 25.5 adds one
  bounded `runAgent` catalog action: DB-free parking via `WorkflowActionPendingError`, worker→API
  shared-secret door, published-version/skill/approval/25.2-principal re-checks, bounded JSON→field
  mapping, `trigger = 'workflow'` (migration 099) and deterministic `workflow.resume` from
  `runs/workflow-resume.ts`; no service principal, code execution, new SDK or MCP surface. 25.6 adds
  bounded `triggers.watchedFields` and one sandboxed `triggers.condition` using `@carocrm/formula`
  (`field('name')` current, `field('__previous_name')` previous); the committed entity event carries a
  bounded before/after snapshot of changed scalars and `runs/trigger-filters.ts` filters before
  fan-out without changing the five-start cap, recursion guard or `evt:<eventId>:<agentId>` key.
  25.7 accepts ≤10 already-uploaded `fileId`s (PNG/JPEG/PDF, 10MB/file) in chat/run input; ACL is
  rechecked at creation and before the model call, metadata (never bytes) crosses
  `AIProviderRequest.attachments`, unsupported adapters fail closed, and metadata is untrusted via
  `boundRecord`. No migration/OCR/vision call; AIAgents module is v1.8.0. 25.1 is `c7b27db`, 25.2 is `0be449b`, 25.3 is `455db1c`;
  25.4 is `952a547`, 25.5 is `f063a60`, 25.6 is `ee3c73b`, and 25.7 is `e8c1699`. Per `AGENTS.MD` §4 the agent did not run automated checks for 25.6/25.7.

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
