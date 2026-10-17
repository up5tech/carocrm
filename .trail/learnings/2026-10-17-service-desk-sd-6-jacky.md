---
title: "Service Desk SD.6: conversation visibility, public replies, internal notes"
author: Jacky
date: 2026-10-17
branch: master
touches:
  - database/migrations/035_phase19_service_desk_conversation.sql
  - apps/api/src/stream/stream-visibility.ts
  - apps/api/src/stream/stream.service.ts
  - apps/api/src/attachment/attachment.service.ts
  - apps/api/src/service-desk/case-conversation.service.ts
  - apps/web/src/components/CaseConversation.tsx
---

Building Service Desk SD.6 (conversation timeline, public replies, internal notes) surfaced four non-obvious repo facts.

1) Visibility must be explicit, never inferred. A new `visibility` column on `stream_items` (default `internal`) and `attachments` (default `public`) classifies every row. Existing `Update` items backfill to `system`; everything else stays `internal`, so enabling a portal cannot retroactively expose historical staff chatter. Portal principals see only `public` entries; the single decision lives in `canViewStreamVisibility` (`stream-visibility.ts`), imported by both the Stream and Attachment services so the download gate and the list filter cannot drift apart. Attachments inherit the message visibility at link time (`StreamService.linkAttachments`), which is what makes an internal-note file disappear from the portal even though the case is readable.

2) Stream writes are not transaction-aware by default. `StreamService` used `this.database.db` (the raw pool) while `ServiceDeskRecords` uses `currentTx() ?? this.database.db`. SD.6's `CaseConversationService.post` runs the stream item, the Case response stamps and the domain event inside one `runInTransaction`. Without making `StreamService.db` join the ambient tx (added in this sub-phase), the stream item would commit even when the later Case update failed. The same change makes generic `/Note` posts safer when a domain command is the caller.

3) `StreamService.create` resolved mentions only from `input.post`. An internal note carries its text in `input.notes`, so `@mentions` inside a note were silently dropped. Fixed to `input.post ?? input.notes ?? ''` so both fields support mentions; the `data.notes` convenience is still set for `Note`-type items.

4) The portal boundary is tested end-to-end without a portal route guard: a portal user with `Case: { read: 'all', stream: 'yes' }` and a case linked through `accountId` can read the timeline and post, but the timeline filters to `public` and a forged `visibility: 'internal'` is refused by `resolveCreateVisibility`. The internal-note attachment test confirms `AttachmentService.assertRowReadable` denies `internal` visibility before the parent-ACL and creator shortcuts, so the file is 403 to the portal even though the case is in their neighbourhood.

Test policy held: `apps/api/test/service-desk-conversation.test.ts` uses `AGENT_TEST_<runId>` markers, deletes only its own rows by exact id (including module-written stream items, mentions, attachments, history, notifications and outbox rows keyed by caseId), restores `features.notifications` in `afterAll`, and never creates a database. 9 tests, all passing; the pre-existing SD suites (70 tests) remain green.
