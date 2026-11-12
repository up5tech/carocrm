# Multi-tenancy decision — single-tenant boundary

> **Owner:** owner / architecture
> **Decision:** D2 in `docs/security/phase-23-security-baseline.md` §6.
> **Recorded:** Phase 23.9 (2026-11-12), `plans/PLAN_Phase_23_Security_Hardening.md` §15 task 5.
> **Status:** decided for the current release; implementation of tenant isolation is **deferred** to a
> separate phase. No tenant migration is started in Phase 23.

## 1. The decision

This repository is a **single-tenant installation**. One deployment serves one customer
organisation. There is no tenant id on records, no tenant-scoped session or API key, no per-tenant
schema, and no tenant-aware query layer. The administrator surface (`sysAdmin`) is global to the
installation.

Consequences that follow from that boundary:

- Every authenticated principal belongs to the same organisation.
- The ACL/role/team model separates users and records **inside** that organisation; it is not a
  tenant boundary.
- The worker, outbox, job queue, Redis, file storage and backups are shared by the whole installation.
- An installation-wide administrator can see every record in that installation. That is expected in a
  single-tenant product and is not a cross-customer leak *by itself*.

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
deployment's own security record.

## 3. Why not implement tenancy now

- A tenant column on every table is not a schema change; it is a change to every query, ACL predicate,
  unique key, background job, export, webhook dedup key and audit path. A partial version is worse than
  none: one unscoped query is a cross-tenant leak.
- Phase 23 is a security-hardening phase with a fixed scope (§1.3 explicitly excludes a full
  multi-tenant architecture). Starting a tenant migration would invalidate the verified ACL evidence
  and the release gate.
- The current product/release target is an Alpha single-tenant installation. There is no approved
  customer requirement or commercial date for shared tenancy.

## 4. Triggers for a separate tenant-isolation phase

Open a dedicated phase (with its own schema/queries/tests/release gate) when **any** of these becomes
true:

- One deployment must serve more than one customer organisation.
- A customer requires per-tenant administration, data residency, or a separate encryption key.
- A shared worker/queue or extension runtime must process more than one customer's data.
- Reporting, search, AI context or exports must span customers (which is itself a product decision).
- A contract, regulation or security review requires provable logical isolation rather than deployment
  separation.

That phase must include, at minimum: tenant id on every owned row, tenant-scoped sessions/API keys,
tenant predicates compiled into the ACL SQL (not added by callers), tenant-aware unique constraints and
dedup keys, per-tenant storage prefixes and encryption context, worker/job tenant context, migration
and backfill, cross-tenant negative tests for every surface in
`docs/quality/authorization-matrix.md`, and a restore drill that proves one tenant's data cannot appear
in another's restore.

## 5. Residual risk and review

| Risk | Mitigation today | Owner |
|---|---|---|
| An operator puts two customers in one installation | Contract/deployment review; this decision states the boundary; no code can detect it | owner / deployment |
| A future feature assumes a tenant id that does not exist | This record and matrix row; the trigger list above | architecture |
| Deployment separation is claimed but not evidenced | Deployment checklist in `docs/security/deployment-baseline.md` §1/§9 | platform / operations |

Review this decision when a trigger in §4 occurs, or at the next release review, whichever is first.
Changing it is an owner/architecture decision, not an implementation detail.
