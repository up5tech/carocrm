---
title: "Service Desk SD.4/SD.5: state machine, queues, routing"
author: Jacky
date: 2026-10-17
branch: master
touches:
  - database/seed-metadata.ts
  - apps/api/src/service-desk/service-desk-records.ts
  - apps/api/src/service-desk/case-lifecycle.service.ts
  - apps/api/src/service-desk/case-assignment.service.ts
---

Building Service Desk SD.4/SD.5 (case state machine + assignment/queues/routing) surfaced four non-obvious repo facts.

1) Every entity entry in database/seed-metadata.ts MUST include a relations key, even relations: {}. EntityDefinitionSchema marks it required. Omitting it does not fail at seed time; it fails at app bootstrap as `ValidationError: Invalid metadata for entity "X"` from MetadataStoreService.load, which reads like a DB problem. Fast local check without booting the app: a tsx script under apps/api (so tsconfig paths resolve @carocrm/metadata) that runs EntityDefinitionSchema.safeParse on coreMetadata entries.

2) entity_records ids are random UUIDs (entity-record.store.ts), so `order by id asc` is NOT insertion order. Service Desk history (CaseTransition/CaseAssignment) was silently non-deterministic on same-millisecond rows. Fix: ServiceDeskRecords.find orders by `created_at asc, id asc`; created_at defaults to now() (transaction start), which differs per command transaction.

3) Physical vs attrs on Case: assignedUserId/userId/createdById map to physical columns (assigned_user_id, created_by_id, team_ids); teamId (singular), queueId, routingRuleId, status, occurredAt all live in JSONB attrs. So migration indexes for the new fields use (attrs ->> field), and ServiceDeskRecords.toRow merges physical columns back under API names so ACL sees one shape.

4) assignedUserId is NOT server-owned: a client can already set it via the generic edit. SD.5 adds queueId/teamId/routingRuleId to SERVER_OWNED_CASE_FIELDS and routes all ownership through the assign/route commands.

Test policy held: apps/api/test/service-desk-workflow.test.ts uses AGENT_TEST_<runId> markers, deletes only its own rows by exact id (including module-written history/notification/outbox rows by caseId), and restores features.queues/notifications in afterAll — vitest runs pool for singleFork so cross-file settings changes would otherwise leak.
