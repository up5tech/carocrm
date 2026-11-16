# API endpoint registry (PLAN §58)

> **Started:** 2026-11-13
> **Completed:** 2026-11-16 — every `/api` route is documented (920 endpoints across 29 files) and
> `pnpm ci:api-spec` runs the checker in `--strict` mode inside `pnpm ci:gate`: a newly added
> undocumented route now fails the nightly gate.
> **Plan:** `plans/PLAN.md` §58 — “Create a machine-readable endpoint registry.”
> **Status:** complete for Phase 24.4 registry coverage. `pnpm ci:api-spec` already fails on a
> phantom or malformed entry, so every documented endpoint is guaranteed to exist in the source.

## 1. Why this exists

The generated OpenAPI document (`GET /api/v1/OpenApi`) is a **route inventory**: it lists 772 paths with a
bare default response, no DTO schemas and no security scheme (G1). The prose catalog
`docs/architecture/contract-catalog.md` explains conventions but is not machine-readable. This directory is
the middle layer: one reviewed file per API area, each endpoint stating its authentication, permissions,
request/response shape, error codes, pagination, sorting, filtering, side effects and idempotency.

The registry is not generated. A generated document cannot state permissions or side effects that only the
handler knows, and this plan explicitly asks for those. What **is** automated is the guarantee that a
documented route really exists: `scripts/check-api-spec.mjs` extracts the live route table from the Nest
controllers and compares it with these files.

## 2. File format

One YAML file per group (`api-spec/<group>.yaml`). The checker parses a deliberately small YAML subset —
top-level scalars, an `endpoints` list, and flat `key: value` fields under each list item. Comments (`#`),
quoted strings and inline arrays (`[A, B]`) are supported. Multi-line strings and nested maps are not;
use a short comma-separated value instead. The same convention as the documented Markdown subset in
`packages/docs`: a small, explicit grammar beats a dependency this repository does not need.

```yaml
group: authentication
basePath: /api/v1
endpoints:
  - method: POST
    path: /api/v1/Authentication
    auth: public
    permissions: none
    request: LoginRequest { userName, password, rememberMe? }
    response: "200/201 LoginResult { accessToken, expiresIn, csrfToken, userId, portalId, role[], type }"
    errors: [VALIDATION_FAILED, AUTHENTICATION_FAILED, RATE_LIMITED]
    pagination: none
    sorting: none
    filtering: none
    sideEffects: [session row, refresh cookie, csrf cookie, security event]
    idempotency: none
```

### Fields (all required)

| Field | Meaning | Allowed values |
|---|---|---|
| `method` | HTTP verb | `GET` · `POST` · `PUT` · `PATCH` · `DELETE` |
| `path` | Path **including** the `basePath`, with `:param` placeholders | any string starting with `/` |
| `auth` | Who may call it | `public` (no principal, verified by a signature/state/secret) · `authenticated` · `cookie+csrf` (cookie-driven public route that still needs the double-submit token) |
| `permissions` | Server-side authority beyond authentication | `none` · `authenticated` · `administrator` · `record ACL (<entity>)` · a capability name |
| `request` | Body/query shape, or `none` | free text, quoting the DTO/schema name |
| `response` | Success shape and status, or `no content` | free text |
| `errors` | Stable `error.code` values this route can answer with | inline array |
| `pagination` | `none`, or the parameters and default/max | free text |
| `sorting` | `none`, or the accepted keys | free text |
| `filtering` | `none`, or the accepted query grammar | free text |
| `sideEffects` | What changes beyond the response: rows, cookies, events, files, provider calls | inline array, `none` |
| `idempotency` | `none`, or how a repeat is made safe | free text |

`request`/`response`/`pagination`/`sorting`/`filtering`/`idempotency` values may be quoted because they
often contain `:` and `{}`.

### 2.1 Schema-backed operations (Phase 24.4, 2026-11-16)

An endpoint may additionally carry three fields for the bounded typed-client surface:

- `operationId` — a stable dotted identifier (`authentication.login`), unique across the registry;
- `requestSchema` / `responseSchema` — paths to versioned JSON Schema documents under
  `api-spec/schemas/` (draft 2020-12 subset: `type`, `properties`, `required`, `items`, `enum`,
  `anyOf`/`oneOf`, `$ref`/`$defs`, string/number bounds; see the files themselves for the exact shape).

`scripts/generate-api-client.mjs` consumes these fields and emits
`packages/api-client/src/generated.ts` — TypeScript types plus a typed `createApiClient` transport.
The generator **fails** on a missing schema file, an unresolvable `$ref`, an unsupported keyword, a
path parameter, or an `operationId` collision; it never falls back to `any` or to the prose fields.
`pnpm ci:api-client` (`--check`) runs inside `pnpm ci:gate` and fails when the committed
`generated.ts` is stale. `apps/api/test/api-spec-client-contract.test.ts` proves the JSON Schemas and
the controller Zod schemas agree on a fixture corpus. Registry coverage (all 920 routes) and
typed-client coverage (the operations carrying schemas — currently the five session operations) are
reported separately on purpose.

## 3. Validation

```bash
pnpm ci:api-spec            # strict: documented endpoints must exist AND every /api route must be documented
node scripts/check-api-spec.mjs          # lenient form: validates documented entries only
node scripts/check-api-spec.mjs --strict # same as pnpm ci:api-spec
node scripts/check-api-spec.mjs --print  # dump the parsed registry (debugging the parser)
```

pnpm forwards arguments after the script name to the command, so no `--` separator is needed;
`pnpm ci:api-spec -- --strict` behaves the same. Verified on 2026-11-13 with pnpm 10: `--print` reached the
script and `--strict` reached it too (exiting 1 while most `/api` routes were still undocumented). If a future package-manager
change swallows the flag, the checker silently loses `--strict`, so the CI gate invokes the script through
`pnpm ci:api-spec` (which carries `--strict` in `package.json`) and the strict behaviour is pinned by
`apps/api/test/api-spec-registry.test.ts`, a DB-free regression that proves an undocumented probe route
fails the gate.

The checker fails when:

- a file has no `group`, `basePath` or `endpoints`;
- an endpoint is missing a required field, has an unknown `method`/`auth`, a path not starting with `/`,
  or a path that does not start with the file's `basePath`;
- a documented `method + path` does not exist in `apps/api/src/**/*.controller.ts` (path parameters are
  compared by position, so `:id` and `:sessionId` match);
- the same endpoint is documented twice.

It is part of `pnpm ci:gate` (so the nightly lane runs it) **in `--strict` mode since 2026-11-16**:
coverage is complete, so an undocumented `/api` route is now a gate failure. The DB-free regression
`apps/api/test/api-spec-registry.test.ts` proves both directions — a probe route fails strict and the
committed registry passes it.

## 4. Coverage

| Group | File | State |
|---|---|---|
| Authentication, sessions, MFA, password reset | `authentication.yaml` | documented (2026-11-13) |
| OIDC sign-in (`/Oidc/*`) | `authentication.yaml` | documented (2026-11-13) |
| Metadata | `metadata.yaml` | documented (2026-11-13) |
| Users, roles, teams, API users and API keys | `users.yaml` | documented (2026-11-13) — 26 routes; every route except `GET /User/assignable` is administrator-only |
| Generic entity CRUD, relations, mass actions | `entities.yaml` | documented (2026-11-13) — 13 route shapes under the `:entity` wildcard, with ACL level and record-predicate rules |
| Email (transport probes, inbound poll, delivery ledger, mailbox + inbound-connection admin) | `email.yaml` | documented (2026-11-16) — 17 routes |
| Administration (`AdminPanel`, `AdminInternal`, `Settings`, `StorageUsage`, `Navigation`, preferences, docs) | `admin.yaml` | documented (2026-11-16) — 21 routes |
| Jobs and schedules | `jobs.yaml` | documented (2026-11-16) — 13 routes, all administrator |
| Attachments and chunked upload | `attachments.yaml` | documented (2026-11-16) — 11 routes |
| Document templates and preview | `documents.yaml` | documented (2026-11-16) — 5 routes |
| Stream, notes, notifications, calendar | `stream.yaml` | documented (2026-11-16) — 12 routes |
| Search, saved filters, import/export, dashboards | `search.yaml` | documented (2026-11-16) — 25 routes |
| Reports | `reports.yaml` | documented (2026-11-16) — 14 routes |
| Workflows and runs | `workflows.yaml` | documented (2026-11-16) — 13 routes, all administrator |
| BPM processes, instances, tasks | `processes.yaml` | documented (2026-11-16) — 18 routes |
| Extensions and domain events | `extensions.yaml` | documented (2026-11-16) — 8 routes |
| Portal administration and portal-user surface | `portal.yaml` | documented (2026-11-16) — 32 routes |
| Service desk | `service-desk.yaml` | documented (2026-11-16) — 39 routes |
| Projects and project tasks | `projects.yaml` | documented (2026-11-16) — 30 routes |
| Lead scoring | `lead-score.yaml` | documented (2026-11-16) — 32 routes |
| Omnichannel inbox, web chat, provider webhook | `omnichannel.yaml` | documented (2026-11-16) — 45 routes |
| CRM chat (AI assistant surface) | `crm-chat.yaml` | documented (2026-11-16) — 27 routes |
| E-signature | `esignature.yaml` | documented (2026-11-16) — 61 routes |
| Sales (documents, payments, pricing, inventory, subscriptions) | `sales.yaml` | documented (2026-11-16) — 86 routes |
| Marketing automation | `marketing-automation.yaml` | documented (2026-11-16) — 81 routes |
| AI agents | `ai-agents.yaml` | documented (2026-11-16) — 74 routes |
| Advanced integrations | `advanced-integrations.yaml` | documented (2026-11-16) — 68 routes |
| Voice communications | `voice-communications.yaml` | documented (2026-11-16) — 66 routes |
| Customer success | `customer-success.yaml` | documented (2026-11-16) — 54 routes |
| Platform misc (i18n, audit log, formula, hooks, setup checklist) | `platform.yaml` | documented (2026-11-16) — 7 routes |

`pnpm ci:api-spec` prints the current counts (documented, matched, missing, undocumented) on every run, so
the coverage row above can be checked instead of trusted. Since 2026-11-16 it reports **29 files, 920
documented endpoints, 920 matched, 0 problems, 0 undocumented** — strict coverage is complete.

## 5. Adding a group

1. Copy the shape from §2; keep one file per area and one endpoint per route.
2. Read the controller (route + guards + `@Public()`), the DTO/Zod schema and the service's side effects —
   do not infer permissions from the SPA.
3. Run `pnpm ci:api-spec`; a phantom path means the controller and the file disagree.
4. Run `pnpm ci:api-spec` until the file is green. `--strict` is **registry-wide** and is now the gate:
   coverage is complete, so it fails on any undocumented `/api` route anywhere in the tree — including
   routes added by a later change. That is intentional: document the new route in the same change.
5. Update the coverage table above and `docs/quality/ci-gates.md` if the gate contract changed.
