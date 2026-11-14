# Product charter — CaroCRM

> **Status:** Ratified product boundary (owner decision, 2026-11-13; reconciled in Phase 24.1, 2026-11-14)
> **Owner:** product / architecture
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §1.1 and §7
> **Security record:** `docs/security/tenancy-decision.md` (deployment-separation conditions and residual risk)
> **Applies to:** this release line and every module, extension, API, test and runbook in this repository

This is the product document. The security decision, its five deployment conditions and its residual
risks stay in `docs/security/tenancy-decision.md`; this charter states what the product is and what it
refuses to become.

## 1. The boundary

**CaroCRM is single-tenant by design. One deployment serves one customer organisation.**

Every authenticated principal — user, portal user, API key, worker job and system principal — belongs to
that one organisation. The database, Redis, worker, queues, file storage, encryption key, JWT secret,
installed extensions, backups, OAuth connections, mailboxes and calendars belong to that installation.
`sysAdmin` is installation-wide, not customer-wide.

Isolation between customers is a **deployment property**, not an application control. It holds only while
all five conditions in `docs/security/tenancy-decision.md` §2 are true. The repository does not enforce
them, and putting two customers into one installation is unsupported.

## 2. Target operator

The operator is the administrator of a self-hosted, or singly-managed, installation for one
organisation. That operator owns installation, upgrade, backup, restore, secret rotation, extension
trust, provider credentials and the separation evidence for the deployment. There is no hosted control
plane, no customer onboarding service and no shared administrator that spans installations. The product
optimises for that operator being able to install, run, integrate and support **one** installation
well, not for a platform team serving many customers from one application.

## 3. What the boundary means in code and contracts

- There is no `tenant_id` column, tenant-scoped session, API key, query predicate, unique key, storage
  prefix, encryption context or worker/job context. A feature that needs one is rejected at review (§6).
- `tenant_ref` / `tenantRef` (migration `056_phase19_advanced_integrations.sql` and
  `apps/api/src/advanced-integrations/*`) are **provider-account labels** — a Microsoft 365 directory,
  a QuickBooks realm, a Shopify shop, a Mailchimp data centre. They name an account at an external
  provider, never a customer of this CRM. They are not tenant residue; do not remove or reinterpret them.
- ACL, roles and teams separate users and records **inside** one organisation. They are not a customer
  boundary. An installation-wide administrator can see every record in that installation; that is
  expected and is not a cross-customer leak by itself.
- Installation-level administration covers mailbox/calendar/OAuth connections, API keys, OIDC profiles,
  outbound webhooks, exports, reports, dashboards, search and AI context. None of these span customers.
- One organisation may have many personal and shared mailboxes, calendars and OAuth connections. Each
  has an explicit owner, credential scope and ACL: single-tenant does **not** mean one mailbox or
  shared visibility between colleagues.
- Upgrade, backup and restore are per-installation procedures. Scaling is per installation — more data,
  more jobs, more replicas for one organisation — never shared capacity across customers.
- REST under `/api/v1` with the reviewed `api-spec/` registry is the one public API paradigm. There is
  no GraphQL surface and no second contract registry.

## 4. Non-goals (permanent for this release line)

| Non-goal | Reason |
|---|---|
| Hosted multi-tenant SaaS, shared tenancy, workspace/tenant administration | One installation belongs to one organisation; isolation is deployment-owned |
| Tenant ids, tenant-aware queries, per-tenant schemas, per-tenant rate limits or billing | They change every query, key, job, export and audit path; a partial version is worse than none |
| SCIM for multiple organisations, cross-tenant negative tests | SAML/SCIM remain deferred by standing owner decision; there is no second organisation to test against |
| Cross-customer reporting, search, exports, dashboards or AI context | No surface may combine data from two deployments |
| A "tenant isolation phase" or any roadmap item that treats shared tenancy as deferred work | The boundary is a decision, not a backlog item (§6) |
| A second API paradigm, ORM, validation framework, package manager or CI provider | The repository keeps one of each; see `AGENTS.MD` §2 |

## 5. Differentiator

CaroCRM competes on the **breadth of built-in business modules** — sales, projects, customer success,
service desk, marketing automation, BPM, voice, e-signature, advanced integrations and AI agents —
available to one organisation in one installation. It does not compete with platform-DX-first CRMs on
extensibility tooling, a public GraphQL API or a hosted multi-tenant developer platform. Chasing that
surface would trade the shipped module breadth for a second architecture. This restates the owner
strategy recorded in `plans/PLAN_Phase_24_Product_Completion.md` §2 and decision D6.

## 6. Feature decision rules

1. **Reject at review** any design, migration, endpoint, DTO, job, report, extension or test that
   assumes a tenant id, a tenant predicate or a shared administrator spanning installations. It is not
   "future-proofing" and it is not accepted as technical debt.
2. **Reject at review** any document, README section, release note, compatibility row or plan passage
   that claims multi-tenancy support, tenant-ready APIs, shared tenancy, or an upcoming tenant-isolation
   phase. Rule 8 of `scripts/check-ui-conventions.mjs` fails `pnpm lint` on the promise phrases; only the
   boundary documents that quote them in order to prohibit them are allowlisted there.
3. **Change control, not a roadmap.** The list in `docs/security/tenancy-decision.md` §4 is a guard: if a
   condition becomes true, work stops at the boundary until the owner ratifies a **new explicit decision
   and a separate plan**. A trigger is not approval, and no agent may treat it as one.
4. Keep the modular monolith, the metadata-driven Entity Engine, the existing ACL and the REST contract.
   No new capability may introduce a second implementation of any of them.
5. Provider-account labels (`tenantRef`) stay distinct from customer identity. Renaming or removing them
   as "tenant cleanup" is a defect, not a simplification.

## 7. Where the boundary is recorded

| Document | Role |
|---|---|
| `docs/reference/product-charter.md` (this file) | Product boundary, operator, non-goals, review rules |
| `docs/security/tenancy-decision.md` | Security decision, five deployment conditions, change-control guard, residual risks |
| `docs/security/security-controls-matrix.md` §48 row | `Not applicable by decision` for tenant isolation |
| `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `README.md` | Truthful product status; no tenant-readiness promise |
| `plans/PLAN.md` §43, §48, §57, §60 | Architecture and roadmap text reconciled with the boundary |
| `scripts/check-ui-conventions.mjs` rule 8 | Automated guard against a new document claiming multi-tenancy support |
| `docs/quality/phase-24-test-evidence.md` | Phase 24.1 commands and results |

## 8. Change log

| Date | Change |
|---|---|
| 2026-11-13 | Owner ratified single-tenant by design as the permanent product boundary (`plans/PLAN_Phase_24_Product_Completion.md` header, §0.3 D1) |
| 2026-11-14 | Phase 24.1 wrote this charter, converted the security trigger list into a change-control guard, reconciled documents, removed the unused tenant fields and added the documentation guard |
