# Marketing Automation — send definitions, dry runs and approvals

> **Delivered in Phase 19-MA.8.** A send definition is one message within a campaign, and it is the record of
> a decision: *this* content revision, *this* frozen audience, validated against *this* hash, approved by
> *this* person (plan §5.5, §5.6, §6.1, §6.2, §15 `19-MA.8`).
> **Related:** [campaign-lifecycle.md](campaign-lifecycle.md), [email-templates.md](email-templates.md),
> [provider-adapters.md](provider-adapters.md), [consent-and-suppression.md](consent-and-suppression.md),
> [the operations runbook](../runbooks/marketing-send-operations.md).
>
> **MA.8 does not send mail.** The transitions it owns are `schedule`, `queue`, `pause`, `resume` and
> `cancel`; handing recipients to a provider is MA.9's queue worker. Everything below is provable without a
> socket, which is exactly how the test suite exercises the whole lifecycle (§15 acceptance).

## 1. Why a send is its own record

§5.5 asks for a send definition instead of more campaign fields, and §6.1 asks for a snapshot "that remains
stable even if the segment changes". A campaign keeps being editable — that is its job — while a send is a
decision that must stop being true the moment its inputs move. Overloading campaign fields with `status`,
`validationHash` and an approval timestamp would make every later edit of the campaign silently rewrite a
decision somebody already accepted.

| Concern | Record | Owner |
| --- | --- | --- |
| The campaign, its schedule, audience composition, template and sender | `Campaign` | MA.3 |
| One message within a campaign, its validation and approval | `MarketingSend` | MA.8 |
| Why the send moved where it moved (command, actor, reason, hashes) | `MarketingSendTransition` | MA.8 |
| Who the send is for, and what the gate decided about each of them | `marketing_recipient_deliveries` (migration 041) | MA.8, advanced by MA.9 |
| The audience the send was validated against | `MarketingAudienceSnapshot` with `sendId` set (MA.4's table) | MA.4 + MA.8 |
| The content the send was validated against | `MarketingTemplateRevision` (MA.6), pinned on the send | MA.6 + MA.8 |

A send is module-written: `POST /api/v1/MarketingSend` is refused by the module write guard, exactly like a
snapshot or a history row. A send a client could author would be a campaign send nobody validated.

## 2. Slots — one message, one intended recipient set

§5.6's acceptance line is *"one recipient has one delivery record per intended send slot"*. A send therefore
belongs to a numbered **slot** of its campaign (default `1`), and migration 041 enforces the two halves of
that rule physically:

- `uq_entity_records_marketing_send_slot` — at most one live send per (campaign, slot);
- `uq_marketing_recipient_deliveries_address` — at most one **message** per (send, slot, address), excluding
  rows the forecast marked `Skipped`, because a skipped row deliberately names every record resolved (a Lead
  and a Contact with one address are two skipped rows and zero messages).

A follow-up message to the same people is slot `2`, not a rewrite of slot `1`. Its ledger rows are separate,
so "who received which message, and why was the rest excluded" stays answerable.

## 3. The dry run (`POST …/action/send/{id}/dryRun`)

Read-only by construction: it seals nothing, snapshots nothing, writes nothing. It returns `SendDryRunReport`:

| Part | What it answers |
| --- | --- |
| `campaign` | The campaign's own MA.3 send-readiness report, findings and all — a send inherits them (`SEND_CAMPAIGN_INVALID` when any campaign blocker stands) |
| `audience.resolved/eligible/blocked/skipped` | How the audience resolves, and how many people in each outcome |
| `audience.categories[]` | One headline category per recipient with **the reason codes behind it** — `optedOut` carries `OPTED_OUT`, `excludedBySegment` carries `EXCLUDED_BY_TARGET_LIST` (§15 acceptance: "preview shows the reasons each recipient category is excluded") |
| `audience.sample[]` | A few named recipients *the caller may read*, with their own reasons |
| `blockers` / `warnings` | The send's own findings (§7.4 codes) |
| `approval` | Whether an approval exists and whether it is still `current` |
| `materialHash` | The fingerprint an approval would be bound to |

The categories are `AUDIENCE_CATEGORY_CODES` (MA.4), and each maps to exactly one ledger state
(`DELIVERY_STATE_FOR_CATEGORY`): `eligible` → `Eligible`, a gate's verdict (`optedOut`, `suppressed*`,
`excludedBySegment`, `consent*`, `frequencyCapped`) → `Blocked`, and a structural non-message (`noEmailAddress`,
`invalidAddress`, `duplicateAddress`, `duplicateRecord`, `recordUnreadable`) → `Skipped`. The dry run's
explanation and the ledger MA.9 acts on are therefore the same decision, in two vocabularies nobody has to
reconcile later.

## 4. Validation (`POST …/action/send/{id}/validate`)

One transaction, four writes, no partial decision:

1. **Seal the content.** `MarketingTemplateService.sealRevision` copies the template's raw parts into an
   immutable `MarketingTemplateRevision` (idempotent: identical content reuses the revision). The send stores
   `templateRevisionId` + `contentHash`, so "which content was this send validated against?" never depends on
   re-reading a template that is still editable (§6.2).
2. **Freeze the audience.** A `final` `MarketingAudienceSnapshot` is taken with the send's `sendId`; an
   earlier snapshot for the same send is stamped `Invalidated` (never edited or removed), so the previous
   decision stays readable as history.
3. **Materialise the ledger.** Every resolved recipient becomes one `marketing_recipient_deliveries` row in
   the state its category maps to, carrying the category and the reason codes. Rows MA.9 has already advanced
   are never rewritten; re-validating rebuilds the forecast instead of duplicating it.
4. **Record the decision and clear the approval.** `validationHash` (the material hash), `lastValidatedAt`,
   `validatedById`, the counts and a stored copy of the report; and any earlier approval is cleared, because
   an approval belongs to the validation it was given for.

A validation that cannot pass refuses, records `lastErrorCode`, and leaves the previous state alone.

## 5. Approval and invalidation (§5.5)

`approve` records `approvedById` / `approvedAt` / `approvalHash` (and a note) against the **current** material
hash. The material hash covers exactly what a message's recipient set depends on — `type`, `purpose`,
`serviceNoticeAcknowledged`, the schedule window, tracking choices, the template id and its content hash, the
sending account, the audience composition (included and excluded ids), the provider key and the slot — and
deliberately not the name, description or budget, so a typo fix cannot invalidate a real approval.

Two moments, one rule:

- **on read**, `GET …/action/send/{id}` reports `stale: true` and `approval.current: false` the moment the
  facts differ from what was approved;
- **on write**, every command re-checks the hash first: a stale send is returned to `Draft` with
  `lastErrorCode = SEND_APPROVAL_STALE` and an `invalidate` history row, and the command that asked for it is
  refused with the same code — never with a vaguer transition error.

Nothing is ever sent on a stale approval, and nothing is silently re-approved.

## 6. The lifecycle

`SEND_TRANSITIONS` (declared in the domain, unit-tested) and the commands that own each move:

| Command | From | To | Gate |
| --- | --- | --- | --- |
| `validate` | Draft, Validated, Scheduled, Queued, Paused, Failed | Validated | campaign `edit`; the report must be valid |
| `approve` | Validated | Validated | the stored validation hash must equal the current material hash |
| `schedule` | Validated | Scheduled | approval current; the validate-phase report (configuration readiness) |
| `queue` | Scheduled | Queued | approval current **and** the queue-phase report: live provider, lifted global stop, campaign Scheduled or Running |
| `pause` | Scheduled, Queued, Sending | Paused | — |
| `resume` | Paused | Queued | the same gate as `queue` |
| `cancel` | any pre-send state | Cancelled | a reason is required (§10.2); the send's open ledger rows become `Skipped` with `SEND_CANCELLED` |
| `complete` | Sent | Completed | MA.9's outcome |
| `fail` | Sending | Failed | **system-only**: the delivery runtime produces it, and no route runs it |

`Draft` is reachable from every pre-send state on purpose: a send whose content or audience changed while it
sat queued has no approval left, and Draft is the only honest place for it.

## 7. Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/MarketingAutomation/action/campaign/{id}/sends` | Define a send in a numbered slot |
| `GET /api/v1/MarketingAutomation/action/campaign/{id}/sends` | The campaign's sends with their decision state |
| `GET /api/v1/MarketingAutomation/action/send/{id}` | One send: approval, validation, ledger totals, allowed commands |
| `GET /api/v1/MarketingAutomation/action/send/{id}/history` | `MarketingSendTransition` rows, oldest first |
| `POST /api/v1/MarketingAutomation/action/send/{id}/dryRun` | The §5.5 dry run (writes nothing) |
| `POST /api/v1/MarketingAutomation/action/send/{id}/validate` | Freeze the decision |
| `POST /api/v1/MarketingAutomation/action/send/{id}/approve` … `/revokeApproval` | Approval metadata |
| `POST /api/v1/MarketingAutomation/action/send/{id}/{schedule,queue,pause,resume,cancel,complete}` | Named transitions |
| `POST /api/v1/MarketingAutomation/action/send/{id}/transition` | The whole state machine in one body (command required) |
| `GET /api/v1/MarketingAutomation/action/send/{id}/recipients` | The recipient ledger, ACL-filtered |

## 8. Permissions and disclosure (§9.2)

Access is the **campaign's**: a caller who cannot read the campaign cannot learn its audience or its content
hash through a send, and every write on a send needs campaign `edit`. The recipient ledger names a record
(`entity_type` + `entity_id`) and stores the address only as a keyed digest — never a plaintext address, a
name or a rendered body (§6.1 "minimized recipient-address snapshot fields", §9.3). Each referenced record is
loaded through the engine before it is listed, so a caller who cannot read it sees it counted under `hidden`
rather than named.

## 9. What MA.9 still owns

- Claiming `Eligible` rows in bounded chunks, with rate limiting, retry/backoff and dead letters.
- Advancing the ledger states (`Queued` → `Sending` → `Sent` / `Failed`) and stamping each row with the
  provider's message id and the content hash that was submitted.
- The final consent/suppression re-check at submission time, so an unsubscribe between validation and
  submission still blocks the message.
- Crash recovery, `unknown_submission` reconciliation and restart-safe idempotency.

The ledger columns for all of that exist today (`provider_message_id`, `content_hash`, `error_code`,
`attempts`, `claimed_at`, `sent_at`); MA.8 simply does not write them.
