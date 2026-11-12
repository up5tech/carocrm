# Extension SDK (PLAN §38 — Phase 14)

An extension is a directory with a `manifest.json`. It can contribute metadata, Nest providers and
controllers, entity-manager hooks, background jobs, domain-event subscribers, SQL migrations and
SPA navigation entries — without a single line changing in the core application.

The three sample packages under [`modules/`](../modules) are exactly that: a field package, an
integration and a custom CRM domain module, none of which the kernel knows about.

---

## 1. Package layout

```text
modules/webhook-integration/
├── manifest.json          # identity, version window, dependencies, priority, pointers
├── metadata/*.json        # entity/field/layout/ACL contributions (validated on load)
├── migrations/*.sql       # applied in file-name order, tracked separately from kernel migrations
├── src/index.ts           # the backend module: default export (the SDK contract)
├── package.json           # an ordinary workspace package, type-checked by the root tsconfig
└── README.md
```

The repository keeps sources in `src/` so `tsconfig.json` type-checks them (`modules/*/src/**/*.ts`).
The manifest's `backend.entry` is resolved exactly as written:

- **development / tests** (`tsx`, vitest) load `src/index.ts` directly;
- **a compiled deployment** (`node dist/main.js`) needs JavaScript, so build the package
  (`pnpm --filter <pkg> build`, emitting `dist/index.js`) and point `backend.entry` at it.

## 2. Manifest

```jsonc
{
  "id": "webhook-integration",          // lowercase kebab-case, unique per installation
  "name": "Webhook Integration",
  "version": "1.0.0",                   // semver-ish: MAJOR.MINOR[.PATCH][-prerelease]
  "minPlatformVersion": "1.0.0",        // refused when the platform is older
  "maxPlatformVersion": "1.9.0",        // optional upper bound
  "dependencies": [{ "id": "other-ext", "version": "1.0.0" }],
  "permissions": ["entity.read", "admin"],
  "order": 250,                         // metadata precedence: lower loads first, higher overrides
  "backend": { "entry": "src/index.ts", "worker": true },
  "metadata": "metadata",
  "migrations": "migrations",
  "frontend": {
    "nav": [{ "route": "/Project", "label": "Projects", "icon": "ProjectOutlined", "order": 10 }]
  }
}
```

The schema is **strict**: `dependancies` fails the install with a pointed error instead of silently
disabling the dependency (PLAN §12.4). `backend` also accepts the shorthand `"src/index.ts"`.
`backend.worker: false` marks an API-only package — the worker then never imports it.

## 3. Loading, ordering and installation

```text
EXTENSIONS_DIR
   └── scan                every child directory with a manifest.json is a *package*
       └── filter          only packages with a row in installed_extensions AND enabled = true
           └── resolve     dependencies first, then ascending `order` (PLAN §39)
               └── load    metadata documents + backend module  →  ExtensionHost
```

`ExtensionHost` (`packages/extension-sdk/src/host`) is a plain value assembled **before** Nest
exists, because providers, controllers and metadata precedence are fixed when the container is
built. Both processes share it:

| Process | Uses |
|---|---|
| API | `providers`, `controllers`, `metadata`, `hooks`, `setup`, `frontend.nav` |
| Worker | `jobs`, `domainEvents`, `setup` |

Failing fast is deliberate:

| Situation | Result |
|---|---|
| Package on disk, not installed | ignored (installing is an explicit act) |
| Installed but disabled | skipped; a dependent is refused with "not enabled" |
| `min/maxPlatformVersion` excludes the platform | skipped with a logged reason |
| Missing dependency, unsatisfied version, cycle, duplicate id | **boot fails** |
| Backend import or metadata error | reported in `host.errors`; other packages still load |
| Manifest path escaping the package directory | **boot fails** |

### Merge order

```text
core metadata_entries  →  extension packages (load order)  →  admin overrides (app_settings)
```

Extension contributions merge `fields`/`relations`/`record`/`client` key by key, merge `layouts`
per view and **concatenate** `indexes`, so two packages can extend the same entity without erasing
each other. Index declarations are metadata only — creating a physical index stays a reviewed
migration (AGENTS.md §3.4).

## 4. Installing

```bash
# 1. put the package directory under EXTENSIONS_DIR (a deployment step, not an upload endpoint)
# 2. install it — dependencies are checked first, then its SQL migrations run
curl -X POST /api/v1/Extension/action/install \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"id":"webhook-integration"}'
# 3. restart the API *and* the worker — that is when the package is loaded
```

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/v1/Extension` | admin | packages, state (`available` / `installed` / `running`), contributions |
| `GET /api/v1/Extension/:id` | admin | one package |
| `POST /api/v1/Extension/action/install` | admin | validate → migrate → activate |
| `POST /api/v1/Extension/:id/action/enable\|disable` | admin | toggle without uninstalling |
| `POST /api/v1/Extension/:id/action/uninstall` | admin | drop the activation row |
| `GET /api/v1/Extension/frontend` | any user | navigation contributions (admin-only entries filtered server-side) |

Uninstalling refuses while another installed package depends on the target, naming the dependents.
It removes the activation record only: SQL already applied is never rolled back (AGENTS.md §3.5).
Every lifecycle action is written to the admin audit log with `entity_type = 'Extension'`.

## 5. The backend contract

```ts
import type { ExtensionBackend } from '@carocrm/extension-sdk';

export default {
  providers: [MyService],
  controllers: [MyController],
  metadata: { entities: { /* … */ } },          // optional; documents also ship as JSON
  hooks: [{ name: 'stamp-source', phase: 'beforeSave', entity: 'Account', handler: async (ctx) => {} }],
  jobs: [{ name: 'my-ext.sync', handler: async (context) => ({ status: 'completed', result: {} }) }],
  domainEvents: [{ eventType: 'entity.created', name: 'notify', handler: async (event) => {} }],
  setup(api) { /* once per process, after metadata is loaded */ },
} satisfies ExtensionBackend;
```

`setup()` receives an `ExtensionApi` facade — `log`, `db`, `enqueue`, `getConfig`/`setConfig`,
`metadata` — and nothing else. A failing `setup()` aborts the boot.

## 6. Injection tokens for controllers and services

An extension never imports the application; it injects SDK tokens, which the host binds to kernel
services:

| Token | Value |
|---|---|
| `EXTENSION_DATABASE` | `ExtensionDb` — `query(sql, params)` for extension-owned tables |
| `EXTENSION_ACL` | `canAccess(entity, action)` / `canAccessRecord(entity, action, id)` |
| `EXTENSION_METADATA` | the merged metadata snapshot |
| `EXTENSION_JOB_ENQUEUER` | `(job, data) => Promise<jobRowId>` |
| `EXTENSION_PRINCIPAL` | the signed-in user (live getters, not a boot-time snapshot) |
| `EXTENSION_HOST` | the loaded host (ids, versions, frontend nav) |

```ts
@Controller('api/v1/Project')
export class ProjectSummaryController {
  constructor(
    @Inject(EXTENSION_ACL) private readonly acl: ExtensionAcl,
    @Inject(EXTENSION_DATABASE) private readonly db: ExtensionDb,
  ) {}
}
```

An extension endpoint is an API surface like any other: it asks `EXTENSION_ACL` before it reads a
record, and anything touching CRM data goes through the generic entity API so validation, audit and
hooks stay in force. `EXTENSION_DATABASE` is documented as extension-owned tables only.

## 7. Frontend contributions

`manifest.frontend.nav` adds sidebar entries. The SPA renders them from
`GET /api/v1/Extension/frontend`; the icon must be one the SPA already ships
(`ApiOutlined`, `DatabaseOutlined`, `ProjectOutlined`, `ThunderboltOutlined`) — a package ships
data, never remote code.

Everything else a screen needs is metadata: fields, layouts, `client` flags and record actions all
drive the generic list/detail/edit components, so a new entity gets a working UI with no React code.
Shipping an actual React component would require a build-time Vite plugin and is **not** supported
in this phase.

## 8. Security

Extension packages are **untrusted code until a trusted key signs them** (PLAN §38.4, Phase 23.6):

- a package is loaded from a deployment-owned directory, so there is no upload endpoint and no
  runtime path an attacker can choose;
- installs run as an administrator, are audited, and require a restart — nothing is loaded or
  evicted while the process is live;
- paths in a manifest are resolved inside the package directory (`resolveInside` refuses `..`);
- extension SQL is plain, reviewable `.sql` files applied transactionally and ledgered separately
  from the kernel's `schema_migrations`;
- secrets a package stores are its own responsibility; the sample integration encrypts its signing
  secrets with `ENCRYPTION_KEY` and refuses private-network webhook destinations (PLAN §48).

### Package signatures and trust modes

`packages/extension-sdk/src/trust/` verifies an Ed25519 signature over a canonical digest of **every**
regular file in the package, excluding `extension.sig` itself. The digest is, for files sorted by
POSIX-relative path:

```
<path>\n<size>\n<sha256 hex>\n
```

The signature file sits at the package root:

```json
{ "keyId": "caro-release-2026", "algorithm": "ed25519", "signature": "<base64 64-byte signature>" }
```

Configuration (shared by the API and the worker):

| Variable | Meaning |
|---|---|
| `EXTENSION_TRUSTED_KEYS` | JSON object `keyId -> public key` (PEM or base64 SPKI DER). Malformed JSON/key fails the boot. |
| `EXTENSION_TRUST_MODE` | `enforce` (refuse untrusted), `warn` (load + log), `off` (no check). Production defaults to `enforce` and **rejects** the other values. |

`enforce` is applied before the manifest is parsed or any backend module is imported, in both the API
and the worker. The admin installer uses the same policy, so it cannot install a package the next boot
would refuse. A package that contains a symbolic link is refused, because the digest and the backend
importer would otherwise read outside the package.

Signing a package (the private key never leaves the release host):

```js
import { createHash, sign } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const privateKey = readFileSync(process.argv[3], 'utf8');
const keyId = process.argv[4];
const files = [];
(function walk(prefix = '') {
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`symlink: ${path}`);
    if (entry.isDirectory()) walk(path);
    else if (entry.name !== 'extension.sig') files.push(path);
  }
})();
const canonical = files.sort().map((path) => {
  const bytes = readFileSync(join(dir, path));
  return `${path}\n${bytes.length}\n${createHash('sha256').update(bytes).digest('hex')}\n`;
}).join('');
writeFileSync(join(dir, 'extension.sig'), JSON.stringify({
  keyId, algorithm: 'ed25519',
  signature: sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64'),
}));
```

`warn` exists for development and for a staged migration; it is not a production posture. The sample
packages in `modules/` are unsigned development fixtures, so a production `enforce` installation will
refuse them until they are signed.

## 9. Tests

| Suite | What it covers |
|---|---|
| `packages/extension-sdk/src/{semver,manifest,resolver,metadata,loader}/index.test.ts` | version parsing, strict manifest schema, dependency/priority resolution and cycles, partial-metadata validation, package scanning and path safety |
| `apps/api/test/extensions.test.ts` | the full lifecycle against the configured database: listing, guards, install + migration ledger, restart, metadata merge, contributed CRUD, frontend contributions, extension routes, uninstall refusal and cleanup |
| `apps/worker/src/extensions.test.ts` | worker-side extension config and failure reporting |
| `e2e/extensions.spec.ts` | the admin screen renders in a browser |

Extension data follows AGENTS.md §3: records carry a run marker, only rows the run created are
removed, and extension migrations are additive (`CREATE TABLE IF NOT EXISTS`).