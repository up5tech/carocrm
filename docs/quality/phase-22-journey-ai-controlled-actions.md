# Phase 22.13 — Journey: a controlled action through CRMChat and AI Agents

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.6 (steps 1–10) and its acceptance assertions
> **Test:** `apps/api/test/phase22-journey-ai-controlled-actions.test.ts` (12 ordered steps)
> **Depends on:** `docs/quality/phase-22-journey-marketing-consent-attribution.md` (22.12), `docs/quality/phase-22-contract-tests.md` (22.6)
> **Status:** Implemented and verified — the focused journey and the full `pnpm verify` gate both pass.

---

## 1. The journey in one sentence

A person who can see **their own** records asks the assistant about one of them and the answer is built from a tool result that could only ever have contained records they may read; then they ask for a write, and nothing is written — the runtime **proposes**, a *different* person decides, and the decision is honoured only if the world still matches what was shown, so a record that has since become unreadable, or a tool an administrator has switched off, is refused rather than executed on trust. A sentence planted inside a CRM note can make the model ask for that same write and it is refused the same way. Every failure — a provider that is rate-limiting, an argument that does not match a schema, a tool name nobody registered, a run its owner stops — settles into a state that says which, and the trace keeps them apart. No door in this journey reaches SQL, a shell, or an identity above the caller.

## 2. Preconditions and required capabilities

| Precondition | How the journey gets it | Required? |
|---|---|---|
| A model with no network | a `kind: 'fake'` provider connection (`POST action/providers`), registered only because `NODE_ENV` is not `production` | **Required** |
| Execution switched on | `aiAgents` settings `features: { definitions, execution, memory }` and `safety.globalExecutionPaused: false` — both off by default | **Required** |
| An assistant the chat may use | a published agent whose version declares `memory.mode: 'conversation'`, `provider.key` = the fake, and the four tools the journey uses | **Required** — `readTools`/`memory`/published-version gates are each refused by name |
| Chat pointed at it | `crmChat` settings `assistant.agentKey`, `features: { workspace, readTools, actionProposals, helpRetrieval }`, `safety.allowWrites: true`, `execution.mode: 'inline'` | **Required** |
| The knowledge corpus being searched | `serviceDesk` `features: { caseManagement, knowledgeBase }`, because help retrieval reads that module's articles | Required for step 4 |
| Three principals | a **starter** (AIAgent read, CRM Chat use, own Account/Contact/Task, all Cases, **no** KnowledgeArticle), a **reviewer** (adds `AIAgentApproval: edit` and `AIAgentAudit: read`), an **outsider** (nothing in either module) | **Required** |

Slots matter: the instance allows a bounded number of active runs and active turns per user, so every run is driven to a terminal state inside the step that made it and `afterEach` cancels anything left open.

## 3. The steps, and what each one asserts

| Step | What happens | What the journey asserts |
|---|---|---|
| 1 | The assistant is configured in stages | each unmet requirement answers with **its own** state — `not-configured`, then `execution-paused` when the kill switch is on — and a caller with no right in either module gets `403 AUTHORIZATION_DENIED` before any of that is consulted |
| 2 | The starter asks about an Account they own, and the model reads it through `crm_read_record` | the run succeeds with one tool call whose `resultRef` is `Account:<that id>`; the assistant's citation carries the record's **own** label and the route `/entity/Account/<id>`; an Account belonging to somebody else appears nowhere in the transcript |
| 3 | The same question, aimed at a record the starter may not read | the tool call is recorded as `failed`, no record content reaches the answer, a `query/execute` list returns only their own Accounts, and a citation re-authorization answers `accessible: false` for the other one — silently, as designed, because a forbidden record would be a disclosure |
| 4 | Help retrieval reads across into Service Desk | a caller entitled to the published article gets it; a caller who cannot read `KnowledgeArticle` at all gets no knowledge source, only handbook pages (this is the F1 fix) |
| 5 | A write is asked for | the run stops at `waiting_for_approval`; the Chat façade shows the typed proposal — target `Case:<id>`, the `after` value, `actionClass: material_write`, `actionable: true`, an expiry — and the Case's description is **untouched**; the person who asked is refused the decision (`403`), because asking and approving are different rights |
| 6 | The world changes before the decision is honoured | *target removed*: the reviewer may still say yes — and then execution refuses, the approval is `invalidated` and the run ends `failed` / `approval_invalidated`. *Tool switched off by an administrator*: the decision itself is refused (`422 … no longer be executed`), the run settles `blocked_by_policy`, and the record is unchanged |
| 7 | A confirmed action executes | the reviewer decides through AIAgents (Chat refuses the same decision from a caller who does not own the conversation — `404`, deliberately indistinguishable from "does not exist"); after the decision the run is `queued`, **not** executed — a second dispatch carries it to `succeeded`; the Case now carries the approved sentence, the ledger row is `succeeded` with `resultRef: Case:<id>`, the timeline holds `approval.requested → approval.approved → approval.executed → tool.succeeded → run.completed`, the record's `modified_by_id` is the person who asked, and no run this journey created carries a service principal |
| 8 | A proposal is rejected | the run ends `canceled` with the rejection as its reason, the record is untouched, the timeline says `approval.rejected`, and a second decision on the same proposal is refused |
| 9 | A CRM note contains an instruction and a provider marker | the read tool returns it as **bounded, untrusted evidence**; the marker did reach the model and did ask for a material write, and that call is refused by name — denied, never executed, no `resultRef`, and the case is still `New` with its planted sentence only in the description it was written into |
| 10 | Unknown, ungranted and malformed tool calls | an invented name and a real-but-ungranted name produce a `tool.denied` event with `not_granted` and **no ledger row at all** (nothing reached a handler), and no `Task` exists with the name they asked for; arguments carrying an extra field are refused by the schema and the stored row keeps `arguments: null`, so a rejected payload is never persisted |
| 11 | Provider failure, replay, cancellation | a `rate_limit` delivery ends the run `failed` with `failure_category = 'rate_limit'` and never a second send; the same turn submitted twice with one idempotency key is **one** run; a canceled turn stops taking further steps and the task committed by an earlier step is still there and still named in the trace |
| 12 | The doors a model cannot open | the catalogue holds the registered CRM/docs tools and no `sql`/`shell`/`http`/`exec`/`fetch` one, those four routes are `404`, a direct MCP-shaped tool call reads only what its caller may read, a **material write through that door is refused** because it carries no run for a decision to attach to (F2), and an invented tool name is refused by name |

## 4. Findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | **Help retrieval crossed a module boundary without the caller's rights.** `action/help/search` read Service Desk's `portalArticles()` — published, non-internal, in-date — straight from `entity_records` with no ACL, then returned titles, summaries and record ids to anyone with `use` + `helpRetrieval`. Its own documentation calls that corpus portal-safe, and it is; but "safe to publish" and "readable by you" are different questions, and `GET /api/v1/KnowledgeArticle/<id>` really would have refused the same caller. Fixed by re-reading each hit under the caller's record ACL and dropping it silently — the rule the citation builder already followed for CRM records | Medium | Fixed (22.13) · G34 |
| F2 | **The MCP-shaped door could commit an approval-class write with no decision.** `action/mcp/call` checked only that the tool was enabled and the arguments fitted its schema. Its ACL is the caller's, so it was never a privilege escalation — but it *was* a segregation-of-duties bypass: the run pipeline needs one person to propose and a **different** right to decide, while this door let one caller do at a desk what an agent must ask permission for. Refused now by effect class and instance policy, with a message that names the run pipeline as the path | Medium | Fixed (22.13) · G35 |
| F3 | **Three declared states are unreachable.** `partially_succeeded`, `waiting_for_input` and the `changes_requested` decision exist in the schema and the route filters, and nothing in the runtime ever writes them. A run that stopped after committing one effect is reported as `canceled` — accurate about the stopping, but indistinguishable from "stopped before anything happened" unless the reader also opens the tool ledger | Low | Open · G36. The journey asserts the ledger-based reading instead, because that *is* inspectable |
| F4 | **A record can be `own`-scoped for reading and still be uncreatable.** For a user whose Case scope is `own`, the platform's own-scope assignment stamps `assignedUserId` into the create, and Service Desk's write guard refuses that field by name — a `422` for a user who was never trying to set it. Reproduced here; recorded rather than changed, because the fix belongs to the guard's own rule and needs the routing semantics thought through | Medium | Open · G37 |
| F5 | **`readTools` does not gate what its contract says it gates.** The route table declares it for `action/turns` and `action/query/execute`; the only thing the turn path consults is assistant readiness, so an administrator who switches read tools off still gets live CRM answers. The journey therefore treats it as a display flag and proves the real boundary, which is the record ACL — asserted in step 3 | Low | Open · G38 |
| F6 | **A turn's own `sources` list is not re-authorized.** `result.sources` are the raw `entity:id` references the run recorded, and `action/turns/:id` hands them back as they are, while the citation path re-reads each one. Only the initiator or an audit holder ever sees the list, and what it can name is a record that was readable when it was cited | Info | Open · G39 |
| F7 | **The write's author is the asker, not the decider, and approval is not execution.** The reviewer's decision re-queues a run that then executes under the *initiator's* restored principal (`modified_by_id` proves it), and the deciding call returns before any write happens. Both properties are asserted rather than assumed | Info | Design, confirmed |
| F8 | **The injection defence is structural, not a prompt nicety.** The planted marker did reach the model and did ask for a material write; it died at the same gates as any other call. The fake provider reading the last message is what lets this be simulated at all, so the honest claim is that a model *asked* and the platform *refused* — not that a real model would have obeyed | Info | Recorded; see step 9 |

## 5. Evidence

| Check | Result |
|---|---|
| `pnpm exec vitest run apps/api/test/phase22-journey-ai-controlled-actions.test.ts` | **12 passed** (the 12 ordered steps) |
| `pnpm exec vitest run …/phase22-journey-ai-controlled-actions.test.ts apps/api/test/ai-agents.test.ts` | **22 passed** — the journey leaves the AI module's own health suite green |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| `pnpm exec tsc --noEmit -p tsconfig.json` | no diagnostics |
| Leftover scan for this run's provider key, agent key, users, roles, records, runs, ledger rows and settings documents | 0 rows |
| Settings scan after the full run: `app_settings` rows whose document names a `agent-test…` key | 0 rows; `aiAgents.provider.defaultKey` = empty, `crmChat.assistant.agentKey` = the instance's own `chat` |
| `pnpm verify` | Passed — lint 0/0, typecheck clean, `pnpm test` 243 files / 3,264 tests, `pnpm test:web` 5 files / 21 tests |

**Database discipline.** The configured primary database only (AGENTS.md §3.1). No schema change, no migration, no database, schema or container created; nothing truncated, dropped or reset. Every row is removed by exact id or by this run's marker, and `afterAll` asserts it — including the settings documents, which are scanned for this run's key so a pointer left behind fails *this* suite rather than the next one to read the row. The three settings documents this journey touches — `aiAgents`, `crmChat` and Service Desk's — are snapshotted as raw columns and restored, with each service's cache invalidated afterwards: a settings row written straight to the table does not disturb a running process's cache, and a suite that snapshots a row under the wrong name restores nothing (both lessons came from the Phase 22.12 suite's own leak, found and fixed the same day).

**The leak this sub-phase found in itself.** An early iteration of this journey crashed after it had written `aiAgents.provider.defaultKey` for its own fake provider but before cleanup, and every later run then *snapshotted that pollution as its baseline* and restored it. The provider row was deleted, so the shared instance was left naming a default connection that no longer exists, and `apps/api/test/ai-agents.test.ts` went red on `action/health` → `default-provider` — a module's health reading a fact about the running platform, exactly as designed, and correctly reporting the dangling pointer. The cleanup now clears a pointer that names a key this run created (such a key can never be the instance's own answer) and the leftover scan covers `app_settings`, so the failure lands on this file. The row in the configured database was repaired the same way, and the scan confirms no settings document names a test key.

**External effects.** None. The model is an in-process deterministic adapter; no credential is stored or sent, no network call is made, and every address, record and agent key carries this run's marker.

## 6. Known limitations

1. API journey, not a browser journey; the SSE stream is deliberately not opened (it is `hijack()`ed and would hang an injected request), so the proposal's arrival is proven through `action/turns/:id`, `action/actions/:id` and the timeline rather than through `action.proposed` on the wire.
2. The model is the fake adapter: it proves what the platform does with a call it is handed, not what a real model would choose.
3. Steps are ordered and share fixture records; a later step depends on an earlier one's state.
4. A canceled run's committed effects are proven for the *record* path (a Task made in an earlier step). A write whose outcome genuinely could not be known — `outcome_unknown` — is a reconcile path owned by the worker suites, not this one.
5. The `AIAgentApproval: edit` right is module-wide; the platform has no narrower "who may decide" rule than a role, and the journey records the self-approval flag without asserting that it blocks anything, because it does not.

## 7. Acceptance criteria (plan §13.6)

- [x] **An AI action never bypasses the authenticated user's authorization.** Steps 2, 3 and 12: the answer, the citation, the list and the direct door all stop at the caller's own record rights, and the write that executed was attributed to the human who asked, with no service principal on any run.
- [x] **Proposed, approved, executed, failed and partially completed states are distinct and inspectable.** Steps 5–8 and 11 hold a proposal, an approval, an executed action, an invalidated one, a rejection, a policy block, a provider failure and a cancellation apart by name — with F3/G36 recorded where the vocabulary promises a state the runtime never produces.
- [x] **Preview, then server-side revalidation.** Steps 5, 6 and 9: nothing is written on a promise, and both ways the world can change before a decision are refused.
- [x] **No direct SQL, no elevated identity.** Step 12, with the MCP door's approval bypass (F2) closed as part of this sub-phase.
