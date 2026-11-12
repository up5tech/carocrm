# Secure deployment baseline

> **Owner:** platform / operations
> **Introduced:** Phase 23.9 (2026-11-12), `plans/PLAN_Phase_23_Security_Hardening.md` §15 task 4.
> **Status:** the baseline and the configuration review are written; **no production topology is
> deployed by this repository**. The dev-oriented `docker-compose.yml` is not a production artifact.
> Deployment-owned items that could not be evidenced are listed in §9.

This document is the minimum a deployment must satisfy before it serves real users. It is a review
checklist, not a hosting platform and not a substitute for the owner's infrastructure decisions.

## 1. Topology and trust boundary

```
Internet ──TLS──► reverse proxy / load balancer ──private network──► API (and worker)
                                                             ├──► PostgreSQL
                                                             ├──► Redis
                                                             └──► object storage / local files
```

- Terminate TLS at the proxy, with a certificate the clients validate. Do not expose the API's HTTP
  listener to the Internet "because the proxy is optional".
- The API and worker listen on a private interface. `APP_HOST` defaults to `127.0.0.1`; a container
  deployment may need `0.0.0.0`, but only on a network where the proxy is the sole reachable peer.
- PostgreSQL and Redis are **not** published to the Internet. The development compose publishes
  `5432`/`6379`; that is a development convenience, not a production layout.
- Object storage is private. Pre-signed URLs are short-lived (`SIGNED_URL_TTL_SECONDS`, default 900 s)
  and are not a substitute for bucket policy.
- Egress is restricted to the providers the installation actually uses. The application already
  refuses private/link-local/metadata addresses for AI and voice URLs and pins redirects, but network
  egress policy is the deployment's second layer.

## 2. TLS and trusted proxy

| Setting | Requirement | Why |
|---|---|---|
| TLS | Terminated at the proxy; TLS 1.2+; redirect HTTP→HTTPS; HSTS at the proxy. | Session cookies are marked `Secure` from `request.protocol`; over plain HTTP the browser will not send them. |
| `TRUST_PROXY` | An exact proxy IP/CIDR list or an exact hop count. `false` when the API is directly reachable. `true` only when **every** peer is a trusted proxy. | With `TRUST_PROXY=true` and a reachable API, a client can forge `X-Forwarded-For`/`X-Forwarded-Proto`, poisoning the rate-limit bucket and the cookie `Secure` decision. |
| Forwarded headers | The proxy sets `X-Forwarded-For` and `X-Forwarded-Proto`; it overwrites, not appends, client-supplied values. | The API believes the header only from a trusted peer. |
| CORS | `CORS_ORIGINS` is an explicit comma-separated list of the real HTTPS origins. | Since Phase 23.1 an unset list fails closed rather than reflecting any origin. |
| Cookie scope | The SPA and API share the deployment's site as intended; do not widen `SameSite`/domain to unrelated hosts. | The session cookie and the CSRF double-submit cookie are a pair. |

The API's helmet configuration sends CSP, HSTS and `nosniff`. The SPA is served by the frontend host;
its document CSP and HSTS are the frontend deployment's responsibility (recorded as a separate
exception), not the API's.

## 3. Secrets and configuration injection

- Inject secrets from the platform secret manager or a root-owned environment file (mode 600). Do not
  bake them into an image, a repository file, a build argument or a client bundle.
- `.env` is for local development. A production deployment sets variables in its own environment; a
  copied developer `.env` is a finding, not a shortcut.
- Provider credentials (SMTP password, AI keys, connector/eSignature/voice credentials) belong in the
  credential vault through the application, encrypted with `ENCRYPTION_KEY`. They do not belong in
  `OIDC_PROFILES`, `INTEGRATION_OAUTH_CLIENT_IDS` (client ids only) or a compose file.
- Secret rotation is an incident/change procedure, not an edit-and-restart: JWT
  (`docs/security/jwt-secret-rotation.md`) and encryption keys
  (`docs/security/encryption-key-rotation.md`) have different blast radii.
- A secret value is never printed in a ticket, a log line, a screenshot or a chat. Record the store and
  the row id instead.

## 4. Production configuration — required values

`NODE_ENV=production` is what activates the boot guards. The table below is the review that Phase 23.9
performed against `apps/api/src/config.ts`.

| Variable | Production requirement | If wrong |
|---|---|---|
| `NODE_ENV` | `production` | Dev defaults and permissive trust settings remain available; the guards below do not run. |
| `JWT_SECRET` | A unique random secret (`openssl rand -hex 32`). The development default and the compose placeholder `change-me-in-production` are refused at boot. | Forged session tokens (full authentication bypass). |
| `ENCRYPTION_KEY` | 64 hex characters (32 bytes). Empty is refused at boot. | Provider credentials cannot be stored; a lost/wrong key makes existing vault rows undecryptable. |
| `EXTENSION_TRUST_MODE` | `enforce` (also the production default). `off`/`warn` are refused at boot. | An unsigned or altered extension package could execute backend code. |
| `EXTENSION_TRUSTED_KEYS` | A JSON map of the keys the deployment trusts, if extensions are used. Empty under `enforce` refuses every package. | Extensions do not load (fail closed) — expected until keys are provisioned. |
| `CORS_ORIGINS` | Explicit HTTPS origins. Empty fails closed. | No browser origin is allowed (safe) or a wrong origin breaks the SPA. |
| `TRUST_PROXY` | Exact proxy CIDR/hop count; not `true` on a reachable API. | Rate-limit bypass, spoofed client IP, wrong cookie `Secure` decision. |
| `DATABASE_URL` | Explicit least-privilege runtime URL. The built-in local `postgres:postgres` default is refused in production. | The API would try a known-credential local database instead of the deployment's. |
| `DATABASE_ADMIN_URL` | Do not provide it to the API/worker unless a maintenance path needs it; if provided, a separate restricted maintenance role, never a superuser. | A compromised API process gets DDL/role privileges it does not need. |
| `REDIS_URL` | Private network; authentication/ACL enabled; no public port. | Queue/job data and worker capability paths are exposed. |
| `APP_HOST` / `APP_PORT` | Private bind behind the proxy (or loopback with a sidecar proxy). | The API is directly reachable, bypassing TLS and proxy controls. |
| `MAIL_TRANSPORT` | `none` unless SMTP is configured and tested. | Accidental mail from an unconfigured installation; `smtp` with missing settings fails at boot. |
| `MARKETING_WEBHOOK_SECRET` | Set only when marketing ingestion is used; blank means **every** marketing delivery is rejected. | Blank is safe (fail closed); a shared/guessable value is a forgery risk. |
| `REPORT_WORKER_SECRET` | Set to a strong random value if scheduled report delivery is used; blank disables it. | Blank is safe; a weak value lets a caller impersonate the worker capability. |
| `OIDC_PROFILES` | `[]` unless external identity is configured. Malformed JSON refuses boot. | A half-configured IdP fails at first sign-in or links the wrong account. |
| `STORAGE_DRIVER` + S3 settings | `local` with a private `STORAGE_ROOT`, or `s3`/`minio` with bucket/region and **both** access keys or neither (instance role). | A public bucket or a half-configured credential chain. |
| `MALWARE_SCAN_MODE` | `signature` (default). | `none` disables the malware hook; only acceptable with an external scanner. |
| `LOG_LEVEL` | `info` (or stricter). | Debug logs can carry request/provider detail that redaction was not designed for. |
| `UPLOAD_MAX_MB` / `UPLOAD_CHUNK_MAX_MB` | Keep the defaults unless the proxy's body limits are raised to match. | A proxy limit below the API limit produces confusing 413s; above it, the API refuses late. |

### 4.1 Verified defaults and unsafe optional providers

Phase 23.9 reviewed the defaults rather than assuming them:

| Default | State | Consequence |
|---|---|---|
| `mailTransport: 'none'` | Safe | An installation that has not configured SMTP cannot send mail by accident. |
| `marketingWebhookSecret: ''` | Safe (fail closed) | No marketing event is accepted until the deployment sets a secret. |
| `oidcProfiles: '[]'` | Safe | No external identity provider until one is configured. |
| `extensionTrustMode` | `warn` in dev, `enforce` in production | Dev fixtures load with a warning; production refuses unsigned packages. |
| `storageDriver: 'local'` | Safe by default | Local files under `STORAGE_ROOT`; a deployment choosing S3 must configure it explicitly. |
| `malwareScanMode: 'signature'` | Safe by default | The built-in scanner runs; turning it off is a deliberate deployment decision. |
| `docker-compose.yml` | **Development only** | It publishes Postgres/Redis, uses `postgres:postgres`, mounts the source tree, seeds the database and runs the dev server with `JWT_SECRET: change-me-in-production`. It is not a production topology and must not be deployed as one. |

The compose placeholder is now refused by the production boot guard, so a compose file copied into a
production environment fails fast rather than starting with a known signing key. The compose file
itself is unchanged: it remains a development convenience, and a production compose/Helm/Terraform
artifact is deployment-owned (not created in Phase 23.9).

## 5. Least-privilege database roles

Use two roles, not one:

| Role | Used by | Privileges |
|---|---|---|
| `carocrm_app` | `DATABASE_URL` for the API and worker | `CONNECT` on the database, `USAGE` on the application schema, `SELECT/INSERT/UPDATE/DELETE` on its tables, `USAGE/SELECT` on its sequences. **No** `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, no schema `CREATE`, no `TRUNCATE`, no ownership of tables. |
| `carocrm_migrator` | migrations/release job only | Schema DDL and ownership needed to apply migrations. Not present in the API/worker environment. |

- `DATABASE_ADMIN_URL` is a maintenance connection; it must not be a superuser and must not be handed
  to the running API/worker unless a maintenance path actually needs it. The current API does not read
  it outside configuration, so a production deployment should omit it.
- Revoke `CREATE` on `public` from `PUBLIC` where the PostgreSQL version still grants it, and keep the
  application schema out of `public` if the deployment's migration path supports it.
- The runtime role must not be able to read `pg_authid`, alter roles or install extensions.
- Test the role by connecting with it and running a normal read/write plus a failing `CREATE TABLE`;
  the second must be refused. Record the result in the deployment's change record.

## 6. Filesystem, backup and retention

- `STORAGE_ROOT` is owned by the service account, mode 700; files are 600. No attachment, export,
  backup or log directory is world-readable.
- The backup root is separate from the application tree, mode 700, encrypted with a provisioned
  recipient key. The backup job, freshness alert, off-host destination and the person who reads the
  alert are **deployment-owned** and are still outstanding (G81).
- Do not put the backup passphrase/private key on the same host as the archive. Keep the old
  encryption key offline until a restore drill has succeeded.
- Retention jobs run in the worker on the seeded schedules (`docs/security/data-retention.md`); an
  installation that disables the worker silently stops retention and freshness work. `audit_log` is
  excluded from automated deletion.
- A restore is not proven until `scripts/restore-drill.mjs` has run against an approved isolated
  target and the evidence is recorded. That approval is outstanding (G80); do not create a database to
  manufacture a drill.

## 7. Logging and monitoring

- The API/worker log structured lines with `x-request-id`/`requestId` and module correlation ids. Ship
  them to a collector the deployment controls; the repository has no exporter (G77).
- Never log `Authorization`, cookies, provider payloads or environment values. The existing redaction
  is a backstop, not permission to log request bodies.
- Alert on: readiness failure, `backup:freshness` non-zero, a sustained rise in `loginFailures24h`,
  signature rejections or dead letters, and certificate expiry. There is no paging integration in the
  repository; the deployment owns the alert route (G77/G81).
- The operations snapshot is point-in-time and its security counters are process-local; a restart
  resets them. Use the collector for history.

## 8. Pre-production review checklist

- [ ] `NODE_ENV=production` and the six boot-guarded values from §4 are set and reviewed.
- [ ] No development `.env`, compose credential, demo secret or sample extension is present.
- [ ] TLS terminates at the proxy; the API is not directly reachable; `TRUST_PROXY` matches the proxy.
- [ ] `CORS_ORIGINS` is the real SPA origin, not a wildcard or `localhost`.
- [ ] Database runtime role is not a superuser and cannot run DDL; migration role is separate.
- [ ] Redis and object storage are private; bucket policy is not public.
- [ ] `STORAGE_ROOT`, backup root and artifact permissions are 700/600.
- [ ] Backup timer, off-host copy, gpg recipient and freshness alert are installed and observed.
- [ ] An approved restore drill has evidence (or the release is explicitly blocked — G80).
- [ ] Incident contacts, severity authority and the runbook in
      `docs/runbooks/security-incident-response.md` are known to the on-call.
- [ ] `LICENSE` and the clean-room/AGPL review are resolved before distribution
      (`docs/security/distribution-compliance.md`).

## 9. Deployment-owned items not evidenced here

| Item | Why it is not in the repository | Owner |
|---|---|---|
| Production compose/Helm/Terraform, TLS certificates, DNS | The project ships no hosting platform; `docker-compose.yml` is dev-only. | deployment owner |
| Secret manager, key custody, backup recipient key | Platform-specific; must not be committed. | deployment owner / security |
| Backup timer, off-host destination, alert recipient | Templates exist (`scripts/deploy/backup.*.example`); installation is an operations action. **G81 Blocked.** | platform / operations |
| Approved isolated recovery environment, RPO/RTO | Owner approval outstanding; no database may be created as a workaround. **G80 Blocked.** | owner / platform |
| WAF/edge rate limiting, DDoS controls | Not part of the application; the in-process limiter is not an edge control. | deployment owner |
| On-call rotation and paging | No integration exists. | deployment owner |

## 10. Change record

| Date | Change | By |
|---|---|---|
| 2026-11-12 | Baseline written; production defaults and dev-compose separation reviewed; JWT placeholder guard added. | Phase 23.9 |
