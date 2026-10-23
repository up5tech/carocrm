---
title: Configuring CRM Chat
summary: How the crmChat document is saved, how the assistant is chosen, what each feature switch exposes, and what to check when Chat cannot answer.
audience: admin
order: 145
tags: [crm-chat, chat, assistant, feature-flags, settings]
related: [admin/settings-overview, admin/module-settings, user/chat-and-voice, user/ai-agents]
updated: 2026-10-23
---

One validated settings document named `crmChat` decides whether [CRM Chat](/crm-chat) opens, which
published AI Agent answers, where a turn executes, and what the page offers.
[CRM Chat and the voice inbox](user/chat-and-voice) describes what a user sees.

## Where the settings live

The document is one row in the platform settings store (`app_settings`, name `crmChat`). It is not a
second provider or model store: Chat keeps only the **key** of the agent that answers, and every model
call, tool invocation and approval stays with AI Agents. [Module settings](admin/module-settings) places
it beside the other module documents. Its groups are `features`, `assistant`, `execution`, `limits`,
`retention` and `safety`; the dialog edits only `assistant` and `execution`.

Open [CRM Chat](/crm-chat) and press **Settings**. The button appears only for a role holding the Chat
`admin` capability (`CRMChatAdmin`, edit); the page itself needs `use` (`CRMChatConversation`, read).
[Users, teams and roles](admin/users-teams-roles) grants both.

The dialog is not a draft tab: no Discard, no Reload, no version number and no unsaved-change dot.
**OK** sends one patch and closes; **Cancel** drops the local edit. It edits only
`assistant.agentKey` and `execution.mode`; the feature, limit, retention and safety groups have no
control there. Current warnings appear in the dialog; the version and the last editor do not.

The module endpoint is the authority. `GET /api/v1/CRMChat/action/settings` returns the document, its
`version`, `updatedAt`, `updatedBy`, `defaults`, `warnings` and effective features. `POST` to the same
path takes a partial document: the service merges it, validates the whole result against a strict
schema, and refuses an unknown key or out-of-range number, naming the issue. A refused write leaves
the stored version untouched. An accepted write increments `version`, records who wrote it, and
invalidates the menu cache; an absent or invalid row falls back to defaults.

To change a group the dialog does not expose, post only the leaves you change. Turning
`features.workspace` off hides the menu entry and the turned-off page has no Settings button; re-enable
it by posting `{"features":{"workspace":true}}` to the module endpoint.

## Choosing the assistant

`assistant.agentKey` is the stable key, up to 120 characters, of a published AI Agent profile; empty
means not configured. Chat never chooses a profile itself. The dialog lists published profiles and
stores the key; if the list cannot be read it becomes free text, and a key no longer in the list stays
selectable so saving another field does not clear it.

Readiness is evaluated in order. The first unmet condition is the tag beside the title and the reason
above the composer; a turn can start only in `ready`.

| State | What it means | What you do |
| --- | --- | --- |
| `not-configured` | `assistant.agentKey` is empty. | Select a published agent and save. |
| `unresolvable` | The key could not be resolved; the reason is the error, for example a missing AI Agents read right or an unavailable owning module. | Read the reason, grant AI Agents access or fix the module. |
| `not-found` | No agent has that key. | Correct or clear the key. |
| `not-published` | The agent's status is not `published`, or it has no current version. | Publish a version in AI Agents. |
| `execution-disabled` | AI Agents `features.execution` is off. | Enable execution on the Settings tab of [AI agents](/ai-agents). |
| `execution-paused` | AI Agents `safety.globalExecutionPaused` is on. | Lift the kill switch; its reason is shown. |
| `memory-disabled` | AI Agents `features.memory` is off. | Enable conversation memory. |
| `agent-memory-off` | The published version's `memory.mode` is `none` or `checkpoint`; Chat needs `conversation`. | Republish the agent with conversation memory. |

## Giving the assistant the handbook

An agent answers a "how do I use this" question only when its published version grants the two
documentation tools: `docs_search` finds handbook pages, `docs_read_page` reads one. Create the profile
from the **Product help assistant** starter on the AI Agents tab, or add both tools to an existing
profile and publish a new version.

Both are read-only and see exactly what the asking user sees on the handbook: a page hidden from that
reader by its audience or by its screen permission is not searched, not read, and never cited. The page
an answer actually read appears under it as a numbered source that opens the handbook. If the handbook
has nothing for the question, the assistant says so — an answer with no source is the designed outcome,
not a failure.

The same pages are reachable by the reader at any time from [Documentation](/docs), and
[Configuring AI agents](admin/ai-agents) covers the tool grants themselves.

## Execution mode

`execution.mode` accepts `queue` or `inline`, labelled Queue (worker) and Direct (API process). Both
create the same durable run row, lease, quota accounting and audit trail, and report progress through
the same turn event stream.

- `queue` is the default. The API writes the run and enqueues a BullMQ job; the worker app consumes it
  and calls the API's worker endpoint to execute. An operator needs the worker process, Redis, a
  reachable `REPORT_WORKER_API_URL`, and the same non-empty `REPORT_WORKER_SECRET` on the API and the
  worker. With no worker the job waits and the turn stays `queued`; with an empty secret the worker
  treats the job as inert and the run also stays `queued`.
- `inline` creates the same run and starts it inside the API process. No worker is required, so a
  single-process installation works. The API must stay up for the turn to finish; the lease makes a
  second dispatch harmless. The run is still enqueued, so an unreachable queue is recorded as a
  dispatch-pending event rather than losing the turn.

Choose `queue` for production, multiple API instances or frequent deploys, where a queued job can be
retried after a restart. Choose `inline` for a single-process installation where running a worker is
not worth it. If queue-mode turns stay queued, fix the worker and secret first.

## The feature switches

| Setting | Default | What turning it on exposes |
| --- | --- | --- |
| `features.workspace` | on | The menu entry, the page and every workspace read. Off hides the entry, refuses the reads and makes every other flag ineffective. |
| `features.readTools` | off | The "Grounded CRM answers" entry as active. No Chat gate reads this flag; the tools an answer can use are the enabled tools on the published agent version, so the switch alone adds none. |
| `features.helpRetrieval` | off | The "Help answers" entry as active. No Chat gate reads it: help search is gated by the workspace, and it searches the product handbook and the published knowledge articles. What an answer may read comes from the agent's published tools, not from this switch. |
| `features.actionProposals` | off | Confirmation of a proposed write. A proposal executes only when `safety.allowWrites` is on as well; the switch does not remove write tools from the agent. |
| `features.feedback` | off | Rating buttons and the feedback endpoint. A rating also needs the caller's `feedback` capability. |
| `features.conversationSearch` | off | The search box and the `q` filter over the caller's own threads. The server refuses a term while the flag is off. |

A flag is effective only when it and every prerequisite are on. `readTools`, `helpRetrieval`,
`feedback` and `conversationSearch` require `workspace`; `actionProposals` requires `workspace` and
`readTools`. The server uses the effective value; a switch that is on but ineffective shows as
Inactive and produces a `featurePrerequisiteOff` warning.

`safety.allowWrites` is independent and starts off. With it off, confirming a proposal is refused
even when `actionProposals` is on and effective; that combination also carries a `writesDisabled`
warning. Rejecting a proposal needs only the workspace. Other codes are `workspaceDisabled` and
`assistantNotConfigured`; the endpoint returns all four.

## Limits and retention

The schema enforces these ranges on every write:

| Field | Default | Accepted |
| --- | --- | --- |
| `limits.maxMessageChars` | 8,000 | 1 to 20,000 |
| `limits.maxContextRefs` | 5 | 0 to 20 |
| `limits.maxActiveTurnsPerUser` | 1 | 1 to 5 |
| `limits.maxConversationsPerUser` | 200 | 1 to 2,000 |
| `limits.turnTimeoutSeconds` | 180 | 10 to 600 |
| `limits.heartbeatSeconds` | 15 | 5 to 60 |
| `limits.maxConcurrentQueries` | 3 | 1 to 10 |
| `limits.maxTurnsPerMinute` | 10 | 1 to 60 |
| `limits.maxQueryResults` | 100 | 1 to 1,000 |
| `retention.conversationsDays` | 30 | 1 to 3,650 |

The schema validates the numbers; it does not make every one of them effective in this build.

- `maxMessageChars` drives the composer counter and its client-side refusal, but the turn endpoint
  accepts at most 4,000 characters, so a larger setting does not raise the server ceiling.
- `turnTimeoutSeconds` appears in the composer hint and does not time out a run. AI Agents'
  `limits.maxElapsedSeconds` (default 120) is the real run ceiling.
- `maxConversationsPerUser` is shown in the list footer and not enforced; `heartbeatSeconds` is not
  read at all, because the event stream sends a heartbeat every 15 seconds.
- `maxActiveTurnsPerUser`, `maxContextRefs`, `maxConcurrentQueries`, `maxTurnsPerMinute` and
  `maxQueryResults` are stored and returned but no Chat code reads them. A turn accepts up to 10
  context references regardless of the setting.
- `retention.conversationsDays` is not read by a sweeper. Conversation expiry and deletion are executed
  by the AI Agents retention settings, and an agent's own retention is capped by that instance ceiling.
  The Chat value is stored and returned but changes nothing.

## What the user page shows

- [CRM Chat and the voice inbox](user/chat-and-voice) — the surfaces this document enables.
- [AI agents](user/ai-agents) — the published profile that answers.
- [Module settings](admin/module-settings) — the document map and defaults.

## Troubleshooting

| Symptom in the workspace | What is wrong |
| --- | --- |
| The Chat entry is missing from the menu | `features.workspace` is off, or the role lacks `CRMChatConversation` read. The settings endpoint still answers. |
| The page says Chat is turned off and offers no Settings button | `features.workspace` is false; post `{"features":{"workspace":true}}` to the module endpoint. |
| Tag `not-configured`, `not-found` or `unresolvable` | Empty, unknown or unreadable `assistant.agentKey`; see the table above and the reason in the banner. |
| Tag `not-published` | The agent is not published or has no current version. |
| Tag `execution-disabled`, `execution-paused` or `memory-disabled` | The matching AI Agents switch or kill switch is off. |
| Tag `agent-memory-off` | The published version's `memory.mode` is not `conversation`. |
| A turn stays `queued` and never answers | `execution.mode` is `queue` and the worker, Redis, `REPORT_WORKER_SECRET` or `REPORT_WORKER_API_URL` is missing or wrong. |
| Confirm is refused while the proposal is visible | `safety.allowWrites` is off, or `actionProposals` is off or ineffective because `readTools` or `workspace` is off. |
| The search box is missing or a search is refused | `features.conversationSearch` is off or ineffective. |
| No rating buttons | `features.feedback` is off, or the caller lacks the `feedback` capability. |
| A long prompt is refused below the shown limit | The turn endpoint's own 4,000-character cap. |
| History disappears on a different schedule | The AI Agents retention window is the executor, not `retention.conversationsDays`. |
| A feature shows On but nothing changes | Check assistant readiness and the agent's own tools; `readTools` and `helpRetrieval` gate nothing here. |
