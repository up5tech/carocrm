# API endpoint registry (PLAN §58)

> **Started:** 2026-11-13
> **Plan:** `plans/PLAN.md` §58 — “Create a machine-readable endpoint registry.”
> **Status:** in progress. Two groups are documented (`authentication`, `metadata`); the remaining
> groups are listed in §4 and are added one file at a time. `pnpm ci:api-spec` already fails on a
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

## 3. Validation

```bash
pnpm ci:api-spec            # documented endpoints must exist; schema must be valid
pnpm ci:api-spec --strict   # additionally require every /api route to be documented (registry-wide)
pnpm ci:api-spec --print    # dump the parsed registry (debugging the parser)
```

pnpm forwards arguments after the script name to the command, so no `--` separator is needed;
`pnpm ci:api-spec -- --strict` behaves the same. Verified on 2026-11-13 with pnpm 10: `--print` reached the
script and `--strict` reached it too (exiting 1 while 891 routes were undocumented). If a future package-manager
change swallows the flag, the checker silently loses `--strict`, so the CI gate invokes the script through
`pnpm ci:api-spec` without flags and the strict run is a documented manual command, not the gate.

The checker fails when:

- a file has no `group`, `basePath` or `endpoints`;
- an endpoint is missing a required field, has an unknown `method`/`auth`, a path not starting with `/`,
  or a path that does not start with the file's `basePath`;
- a documented `method + path` does not exist in `apps/api/src/**/*.controller.ts` (path parameters are
  compared by position, so `:id` and `:sessionId` match);
- the same endpoint is documented twice.

It is part of `pnpm ci:gate` (so the nightly lane runs it). `--strict` is **not** part of the gate yet:
coverage is incomplete by design while the groups below are still being written, and a gate that fails on
known-missing documentation would be turned off.

## 4. Coverage

| Group | File | State |
|---|---|---|
| Authentication, sessions, MFA, password reset | `authentication.yaml` | documented (2026-11-13) |
| OIDC sign-in (`/Oidc/*`) | `authentication.yaml` | documented (2026-11-13) |
| Metadata | `metadata.yaml` | documented (2026-11-13) |
| Users, roles, teams | `users.yaml` | not started |
| Generic entity CRUD, relations, mass actions | `entities.yaml` | not started |
| Relationships | `relationships.yaml` | not started |
| Attachments and chunked upload | `attachments.yaml` | not started |
| Activities, calendar, stream | `activities.yaml`, `stream.yaml` | not started |
| Search, saved filters, import/export, dashboards | `search.yaml` | not started |
| Reports | `reports.yaml` | not started |
| Workflows, BPM processes | `workflows.yaml` | not started |
| Jobs and schedules | `jobs.yaml` | not started |
| Administration (`AdminPanel`, `Settings`, `AdminInternal`, `StorageUsage`, `Navigation`) | `admin.yaml` | not started |
| i18n | `i18n.yaml` | not started |
| Phase 19 modules (AI agents, chat, sales, service desk, …) | one file per module | not started |

`pnpm ci:api-spec` prints the current counts (documented, matched, missing, undocumented) on every run, so
the coverage row above can be checked instead of trusted.

## 5. Adding a group

1. Copy the shape from §2; keep one file per area and one endpoint per route.
2. Read the controller (route + guards + `@Public()`), the DTO/Zod schema and the service's side effects —
   do not infer permissions from the SPA.
3. Run `pnpm ci:api-spec`; a phantom path means the controller and the file disagree.
4. Run `pnpm ci:api-spec` until the file is green. `--strict` is **registry-wide**, not per group: it fails
   while *any* `/api` route is undocumented, so it is the completion gate for the whole directory, not a
   check you can turn on for one finished group.
5. Update the coverage table above and `docs/quality/ci-gates.md` if the gate contract changed.
