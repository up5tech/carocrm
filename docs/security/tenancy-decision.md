# Single-tenant product boundary — deployment separation

> **Owner:** owner / architecture
> **Decision:** D2 in `docs/security/phase-23-security-baseline.md` §6; ratified as the **permanent
> product boundary** by the owner on 2026-11-13 (D1 in `plans/PLAN_Phase_24_Product_Completion.md` §0.3).
> **Recorded:** Phase 23.9 (2026-11-12); reconciled in Phase 24.1 (2026-11-14).
> **Status:** **decided product boundary**. Isolation between customers is deployment-owned. No
> tenant-isolation implementation is planned, deferred or scheduled. The product statement is
> `docs/reference/product-charter.md`.

## 1. The decision

This repository is a **single-tenant product**. One deployment serves one customer organisation.
There is no tenant id on records, no tenant-scoped session or API key, no per-tenant schema, and no
tenant-aware query layer. The administrator surface (`sysAdmin`) is global to the installation.

Consequences that follow from that boundary:

- Every authenticated principal belongs to the same organisation.
- The ACL/role/team model separates users and records **inside** that organisation; it is not a
  tenant boundary.
- The worker, outbox, job queue, Redis, file storage and backups are shared by the whole installation.
- An installation-wide administrator can see every record in that installation. That is expected in a
  single-tenant product and is not a cross-customer leak *by itself*.
- `tenant_ref` / `tenantRef` (migration `056_phase19_advanced_integrations.sql`,
  `apps/api/src/advanced-integrations/*`) are **provider-account labels**, not isolation fields. They
  name an account at an external provider and are deliberately preserved.

## 2. Does deployment separation satisfy PLAN §48 "Tenant isolation"?

**Only conditionally, and not by the code in this repository.** If each customer gets a separate
deployment with its own database, Redis, storage root, encryption key, JWT secret, extensions and
backup set, then the isolation is an infrastructure property. It is acceptable only when all of the
following hold:

1. No API, worker, queue, database, bucket or Redis instance is shared between customers.
2. No shared administrator account spans installations.
3. No shared extension package executes with another customer's data.
4. Backups, logs and exports are stored per installation and are not co-mingled.
5. The deployment operator can evidence the separation (inventory + access review), not merely intend
   it.

The repository does **not** enforce those conditions. A deployment that puts two customers in one
database, or shares a worker/queue while claiming "logical separation", is outside this decision and
has no tenant-isolation control.

Therefore the §48 control is recorded in the matrix as **Not applicable by decision** for the
single-tenant product, not as "verified tenant isolation". Deployment separation, when the five
conditions above hold, is the compensating boundary; it is deployment-owned and must be stated in the
deployment's own security record. This is the permanent design for this release line, not an interim
measure awaiting an application control.

## 3. Why this is a boundary, not a backlog item

- A tenant column on every table is not a schema change; it is a change to every query, ACL predicate,
  unique key, background job, export, webhook dedup key and audit path. A partial version is worse than
  none: one unscoped query is a cross-customer leak.
- The product target is a self-hosted installation for one organisation. There is no approved customer
  requirement, commercial date or hosting model for shared tenancy.
- The original Phase 23 wording ("deferred to a separate phase") made a product decision look like an
  unfinished implementation task. Phase 24.1 removes that framing: no tenant-isolation phase is on the
  roadmap, and `docs/reference/product-charter.md` §6 rejects any feature that assumes a tenant id.

## 4. Change-control guard (formerly the trigger list)

The conditions below are **review triggers**, not a scheduled phase. If any becomes true, the boundary
is in question and work must stop at the product level before any code, migration or test is started:

- One deployment must serve more than one customer organisation.
- A customer requires per-tenant administration, data residency, or a separate encryption key.
- A shared worker/queue or extension runtime must process more than one customer's data.
- Reporting, search, AI context or exports must span customers (which is itself a product decision).
- A contract, regulation or security review requires provable logical isolation rather than deployment
  separation.

**Guard procedure.** A trigger requires a **new explicit owner decision and its own separate plan** that
states the revised product boundary, the security model, the migration/backfill strategy and the release
gate. Until that decision is recorded, §48 stays **Not applicable by decision**, the five conditions in
§2 remain the only accepted boundary, and no repository change may introduce a tenant id, a tenant
predicate or a cross-tenant test. A trigger is not approval; an agent must not treat it as one. This
guard is change control, not a roadmap or a list of deferred work.

## 5. Residual risk and review

| Risk | Mitigation today | Owner |
|---|---|---|
| An operator puts two customers in one installation | Contract/deployment review; this decision and the product charter state the boundary; no code can detect it | owner / deployment |
| A future feature assumes a tenant id that does not exist | This record, the controls matrix row and `docs/reference/product-charter.md` §6; the change-control guard in §4 and the automated documentation rule | architecture |
| Deployment separation is claimed but not evidenced | Deployment checklist in `docs/security/deployment-baseline.md` §1/§9 | platform / operations |

Review this decision when a trigger in §4 occurs, or at the next release review, whichever is first.
Changing it is an owner/architecture decision, not an implementation detail.
