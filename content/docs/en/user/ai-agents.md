---
title: AI agents
summary: What a run records, how conversation memory works, when an agent must ask a human, and what usage does not tell you.
audience: user
order: 140
tags: [ai-agents, agents, runs, approvals, usage]
aliases: ["trợ lý AI", "tác nhân AI", "chạy trợ lý", "hỏi AI về dữ liệu"]
related: [user/record-page, admin/module-settings, admin/users-teams-roles]
updated: 2026-10-21
---

The AI Agents module is one page with tabs, opened from the sidebar or with [Open the AI agents screen](/ai-agents).
A tab appears only when your role holds the right it needs; the server enforces each request, so a hidden tab is orientation, not the lock.

## Overview and Agents

**Overview** is diagnostics: module health, providers and adapters, the settings version, feature switches,
the module's checks and your own permissions. It describes the deployment, not your activity.

**Agents** lists definitions you may see: name and key, status, version with an "Unpublished changes" tag,
tools, visibility and last update. Search and the status filter narrow it. Open a row for its configuration,
versions and validation report. **Run** appears only on a published agent you may run, and is refused while
execution is unavailable. Drafting, publishing and lifecycle commands are separate rights.

## Starting a conversation

1. Open the **Agents** tab and click an agent whose status is **published**.
2. Click **Run**.
3. Describe the task, up to 4,000 characters.
4. If the agent uses conversation memory, choose an earlier thread or leave the field empty for a new one.
5. Press **Start run**. The **Runs** tab opens on the new run.

A run is one execution of one task by one captured agent version, not a chat message. The agent can only use
tools from a fixed catalogue: search, read, list related and summarize records, create an internal task, and
propose a field update. Tools run under your access, and the field update always waits for a human.

> [!NOTE]
> Execution ships switched off. If the top of the page says execution is off or paused, no new run can start;
> an administrator changes that in **Settings**. Existing runs and conversations stay readable.

## Runs and conversations

### Runs

A run records the agent name and captured version, trigger, task text, timestamps, step, tool-call and
model-call counts, tokens, the result or failure message, each tool call and an append-only timeline. The
statuses are queued, running, waiting for approval, waiting for input, retry wait, cancel requested,
succeeded, partly succeeded, failed, canceled, expired, blocked by policy and unknown outcome. A terminal
state never changes again.

Live progress is polling, not streaming: while the list or open run is active, the page refreshes every four
seconds and stops at a terminal state. The timeline is the server's event list, not an inference from
counters. **Cancel run** stops the current step and keeps recorded effects. **Retry** starts a new run and is
offered only for failed, canceled, expired or blocked runs; an unknown outcome is not retryable.

The list starts on **My runs**; **All runs** needs the audit right, and another person's run is otherwise not found.

### Conversations

The **Conversations** tab exists when module memory is on and you have the use right. It shows threads you
own: title, agent, status, message count, last activity and expiry. Open one to read its turns and any
system-generated rolling summary.

- **Archive** stops a thread from accepting new turns.
- **Delete** removes the thread and all its messages, permanently.
- **Stored memory** lists summary and curated memory items, each with its own delete control.

Only you can read your threads, they expire under the retention window, and a memory reference is re-checked
against your access before reuse. Policy administrators see a **Retention** card that previews the sweep.

## Approvals

An agent pauses when it proposes a tool call whose effect class is in the approval policy — material and
high-impact writes by default — or a tool that always needs approval, such as the field update. The run waits
at **waiting for approval** until a reviewer decides or the proposal expires (60 minutes by default).

The **Approvals** tab needs the approval right and lists every pending proposal, not only those from your
runs. Open one to see the summary, agent and version, risk, tool, target records, before and after values,
arguments and expiry.

- **Approve** records your name and optional note, re-checks the tool, grant, arguments, target and policy,
  then queues the run again. If anything changed, the approval is invalidated and the run ends blocked by
  policy instead of executing.
- **Reject** cancels the run, invalidates its other pending approvals and records your note.
- A proposal past its deadline closes as expired and its run ends as expired; opening the inbox performs that
  sweep and reports the count.

> [!WARNING]
> An approval covers one proposal against the facts at the moment you decide. Self-approval is allowed: if
> you approve a proposal you started, it is recorded and tagged "Self-approved", not refused.

## Evaluations and usage

### Evaluations

The **Evaluations** tab is shown to roles with the evaluation right. It lists suites with their key, publish
requirement and enabled state; someone with the evaluation right can create the standard **Publication gate**
suite. Choose an agent and suite, press **Run**, and the run shows the draft's checksum and each case's outcome.

The deterministic cases inspect the draft offline: configuration and limits, tool grants, approval coverage,
budgets, provider allowlist, memory policy and ownership. The suite does not call the model to grade answers.
A model-review case is advisory and never runs automatically; a human-review case stays pending until a
person decides. This screen cannot record that decision, so such a suite cannot reach "passed" from here.

The gate is real: while evaluations and a required suite are enabled, publishing an exact draft needs a
passing run of that suite at the same checksum.

### Usage

The **Usage** tab needs the usage right. Its totals — runs, model calls, tool calls and tokens — cover the
whole instance, not only your runs, and are broken down by agent and by provider and model.

The cost figure is labelled. It is an estimate from the administrator's price cards per million tokens, or
"no price data" when none matches; never the provider's billed amount. With no card the total is zero because
nothing was priced, not because the runs were free.

Budgets show **OK**, **Near limit** or **Exhausted**. The warning percentage is only a warning; a hard limit
refuses new work. Pricing and quota changes need policy administration. Usage is a counter ledger, not an
invoice and not a per-person split.

## Providers and Settings

**Providers** and **Settings** are administration surfaces inside this page. Providers manages model
connections, allowlisted models, write-only credentials and a connection check. Settings holds features,
ceilings, approval classes and lifetime, retention, data policy, default connection, disabled tools and the
emergency stop. This is the module side of [Module settings](admin/module-settings).

If either tab is absent, your role lacks that right and nothing here changes it; ask an administrator to grant
it on [Users, teams and roles](admin/users-teams-roles). Ordinary use needs only the right to use agents;
reviewing approvals, reading usage and managing evaluations are separate rights.

## What can go wrong

| Symptom | What it means | What to do |
| --- | --- | --- |
| Execution is off or paused at the top of the page | The feature is disabled, or the operator kill switch is active; history stays readable | An administrator enables it or lifts the pause in Settings |
| A published agent has no Run button | You lack the use right, or the agent is no longer published | Check its status; ask for the right |
| A run stays at waiting for approval | A proposal needs a reviewer and expires if nobody decides | Open Approvals with the approval right |
| Approving is refused as no longer executable | The tool, grant, target or policy changed after the proposal | Start a new run; the approval is invalidated |
| A run is missing from Runs | The list shows only your runs without the audit right | Use My runs or ask for audit access |
| There is no Conversations tab | Module memory is off, or you lack the use right | Memory must be enabled and the agent configured for it |
| There is no Approvals, Usage or Evaluations tab | Each is a separate right | Ask for the specific right you need |
| Cost is zero and tagged no price data | No provider request has been priced; a price card may be missing | A policy administrator adds a price card |
| Publishing says a suite has not passed this draft | The gate has no passing run at this draft's checksum | Run the required suite; a human-review case needs a decision |

## Where to go next

- [Configuring AI agents](admin/ai-agents) — providers, execution, approvals and budgets, from the administrator's side.
- [Module settings](admin/module-settings) — the AI agents document and what starts switched off.
- [Users, teams and roles](admin/users-teams-roles) — who receives the use, review, usage and admin rights.
- [Reading and editing a record](user/record-page) — the records and fields a tool can touch.
