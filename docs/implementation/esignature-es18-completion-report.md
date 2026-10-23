# Phase 19-ES.18 — CRM Domain Entry Points and Events

> `PLAN_Phase_19_ESignature.md` §2.3, §15, §18 `Phase 19-ES.18`.
> Acceptance: ESignature works if optional modules are not installed; a signed file does not
> automatically mark invoices paid or opportunities won; event replay does not duplicate downstream
> actions.
>
> Prerequisites read: `esignature-es13-completion-report.md` (the request detail and record links),
> `esignature-es17-completion-report.md` (the approval events this phase also announces), and the
> platform's `events/event-bus.ts` + `common/outbox.service.ts`.

ES.18 gives the module two outward edges: a record page can start a request from the record, and every
lifecycle fact is announced through the transactional outbox. Both edges are **optional by
construction** — the record page imports one generic component, and ESignature imports no optional
module — so an installation without Sales, Projects or Customer Success still runs the module.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-events.ts` | The event contract: the eight narrative facts plus approval, recipient, reconciliation and artifact events; schema version; safe payload; semantic dedupe key. |
| `esignature-request.service.ts` | Dispatches `requestCreated`, `requestPrepared`, `requestApprovalRequested`, `requestApproved`, `requestRejected`, `requestSent`, `requestVoided`, `requestNeedsReconciliation`, `completedArtifactAvailable` inside the transaction (or immediately after the provider-confirmed state change, with a stable key). |
| `esignature-webhook.service.ts` | Dispatches `recipientCompleted` and the envelope status event from the projection transaction. A replayed delivery never reaches the projection twice, so it never emits twice. |
| `esignature-record-entry.service.ts` | The capability registry and availability answer for a record detail page: core vs optional entities, record ACL, caller rights, recent linked requests. |
| `esignature.controller.ts` + DTO | `GET /api/v1/ESignature/action/record-entry?entityType=…&recordId=…` — a 200 availability answer, never a 403 for a normal "not available". |
| `apps/web/src/components/ESignatureRecordActions.tsx` | The generic record card: recent linked requests, *Start a signature request* (navigates to a pre-filled create drawer) and *Open* (opens the request). Renders nothing on `available:false`. |
| `EntityDetailPage.tsx`, `ESignaturePage.tsx`, `ESignatureRequestsPanel.tsx` | Mount the card outside the portal; read `sourceEntityType`/`sourceRecordId`/`request` query parameters and open the create/detail drawer once. |
| `apps/api/test/esignature-events.test.ts` | The event, replay, linked-record and entry-point acceptance suite. |

**No migration.** The outbox table already exists; the entry point reads metadata/ACL and the request
repository only.

---

## 2. How each acceptance criterion is held

**ESignature works without optional modules.** The record entry service checks a static registry of
*candidate* entities and then the live metadata registry. `Account` and `Contact` are core;
`Opportunity`, `Quote`, `SalesOrder`, `Invoice`, `Project`, `ProjectTask`, `Case`, `Campaign` and
`CustomerSuccessProfile` are present only when their module is installed. ESignature imports none of
those modules, so an absent one is simply not a candidate. The unit/API test asks for an unsupported
entity (`User`) and receives `{ available: false, reason: 'unsupported_entity' }`.

**A signed file does not mark records paid or won.** No consumer was added to Sales, and the module
does not write any source record. The suite completes a request linked to an `Opportunity` whose stage
is `Proposal` and then reads it back: the stage is still `Proposal`. The plan's §15.1 rule — each
downstream module decides its own business state — is therefore a property of the code, not a
convention.

**Event replay does not duplicate downstream actions.** Three layers work together:

1. The projection is monotonic and idempotent (ES.12), so the same provider delivery never reaches the
   event builder twice; the outbox event itself is written in the same transaction as the projection.
2. The payload carries `dedupeKey` derived from the **meaning** of the fact, not from a random row id:
   `esignature.requestSent:<requestId>:sent`, `…:requestCompleted:<requestId>:completed`,
   `…:recipientCompleted:<requestId>:<recipientId>`, `…:completedArtifactAvailable:<requestId>:<artifactIds>`.
   The send path and a Connect `sent` event for the same request produce the same key.
3. The test runs an example consumer twice with the same key and counts one downstream action. A
   consumer can use the key as its own idempotency key or persist it in its own processed table; this
   module cannot mark another module's rows on its behalf.

**The payload is safe.** It carries the local request id, provider key, connection id, source
entity/id, normalized status, occurrence time, correlation id, schema version, dedupe key and — only
for recipient/artifact events — a local recipient id or artifact kinds/count. It never carries document
bytes, provider tokens, signing URLs, recipient emails or message text; the test asserts the serialized
event does not contain the signer email, access token, a URL or the PDF fixture.

---

## 3. Consumer contract (example)

Sales does not expose a documented "accept signed commercial document" service in this repository, so
**no Sales consumer is wired** (plan §18 explicitly conditions that example on such a contract). A
future consumer should be shaped like this, and must own its own business rule:

```ts
async function onESignatureEvent(event: OutboxEvent): Promise<void> {
  // 1. Idempotency first: the semantic key is the same across replays and across source paths.
  if (await consumerStore.hasProcessed(event.payload.dedupeKey)) return;

  // 2. Read the CRM record through the caller's own ACL; do not trust fields outside the event.
  const quote = await quoteService.read(event.payload.sourceRecordId);

  // 3. Decide the module's own transition. "Signed" is not "accepted", "paid" or "won".
  if (quote.status === 'presented' && quote.acceptancePolicy === 'signed') {
    await quoteService.accept(quote.id, { reason: 'signature-completed', requestId: event.payload.requestId });
  }

  // 4. Record the key in the same transaction as the downstream action.
  await consumerStore.markProcessed(event.payload.dedupeKey);
}
```

The example is deliberately not registered as a handler: an installation that wants this must enable
the integration and review the business rule.

---

## 4. Verification

- `apps/api/test/esignature-events.test.ts` — 8 cases: create/prepare/request-approval/approve
  outbox rows and safe payload; sent → recipient-completed → completed with a replayed delivery; one
  artifact event; replaying consumer; linked Opportunity unchanged; supported/unsupported record
  entry; no-permission and record-restricted entry answers; module closed cleanly.
- `npx vitest run apps/api/test/esignature-*.test.ts` — **17 files, 277 tests passing**.
- Both-project typecheck, ESLint on every touched file, and `pnpm --filter @carocrm/web build` are clean.
- Browser pass on the dev stack: an `Opportunity` detail page showed the E-Signature card with the
  linked request; *Start a signature request* navigated to
  `/esignature?sourceEntityType=Opportunity&sourceRecordId=…`, opened the create drawer and pre-filled
  the source fields. The outbox row for `esignature.requestCreated` was present with the expected
  dedupe key. Fixture rows/settings were removed afterwards.

## 5. Still open

- No Sales/Projects/Customer Success consumer is registered; the event contract and example are
  ready, but the plan conditions a Sales consumer on a documented Sales service contract that does
  not exist here.
- The API process only writes the outbox; the worker owns delivery to subscribed consumers (ES.20
  surfaces failures/dead letters).
- The record entry hard-codes the candidate registry in one file. Installing a new optional module
  requires adding its entity there; there is no dynamic capability-registration API yet.
- A source-record change does not proactively re-open a prepared/approved request; ES.17's digest
  detects it on the next preview/send, and ES.18 does not add a source-record subscriber.
