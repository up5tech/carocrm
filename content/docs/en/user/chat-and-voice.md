---
title: CRM Chat and the voice inbox
summary: The CRM Chat workspace and its quick-chat panel, then the voice inbox, the call log and what the composer can and cannot do.
audience: user
order: 130
tags: [chat, crm-chat, voice, calls, sms, assistant]
related: [user/stream-and-notifications, user/record-page, admin/settings-overview]
updated: 2026-10-23
---

There are two surfaces here and they do not talk to each other. [CRM Chat](/crm-chat) is a thread
between you and an assistant model. [The voice inbox](/voice-inbox) is a workspace for calls, SMS, MMS
and WhatsApp — the conversation a person has with a customer, not with a model.

## The Chat workspace

Open [CRM Chat](/crm-chat). The page only answers once an administrator has picked an **assistant** —
a published AI Agent profile chosen by key — and the AI Agent runtime has execution and conversation
memory on. Otherwise the header carries a status tag (`not-configured`, `not-published`,
`execution-disabled`, `memory-disabled`, and so on) and the composer is disabled; the rest of the page
still works.

Three regions:

- Your own conversations on the left, most recent activity first. A search box appears only when the
  deployment enables `conversationSearch`. A thread is private to you: an owner predicate is part of
  every query, so no other caller — including an administrator — sees it in their list.
- The selected thread: role-labelled messages in order, an orange badge if any content was redacted,
  and a citation chip under each answer. Citations are reauthorized when the thread renders, so a
  source you can no longer read shows as locked instead of opening something you should not see. A
  **Load older** button pages back through history.
- The composer at the bottom, plus capability and feature cards, and a diagnostics panel you can
  toggle.

**New** is client-side. It clears the draft and focuses the box; the thread itself is only created on
the server when the first message is accepted.

You can also ask the assistant how to *use* the CRM — "where do I enable two-factor sign-in?", "how do
I schedule a report?" — and it answers from this handbook, in your own language, with a numbered source
chip that opens the page it read. It only reaches pages you could open yourself, and when the handbook
has nothing for your question it says so instead of guessing.

## Quick chat from the header

The header carries an **Ask AI** button on every screen — a small panel, not a second workspace. It
appears only when the server put Chat on your menu, so an instance without the module never shows it.

Type a question and press **Enter**; the answer arrives in the panel, role-labelled, with a **Stop
generation** button while the turn runs. Asking again from the same panel continues the same
conversation, and **New conversation** starts a fresh one. **Open full chat** opens `/crm-chat`, where
your conversations are listed. The panel shows answers only: no citations, no attachments and no record
previews.

If the assistant wants to change a record, the turn asks for a decision — and a decision is taken on the
full page, where the proposal card is, not in the panel. The panel says so and links there.

## The composer

Plain text, up to the limit shown under the box — 8,000 characters by default. **Enter** sends,
**Shift + Enter** adds a newline, **Escape** cancels a running turn.

While a turn runs, the composer shows a phase (`queued`, `thinking`, the current tool's label,
`finishing`) and a wall clock, with a **Stop generation** button. The phase is lifecycle only; the
model's internal chain of thought is never streamed.

Two things sit alongside the box:

- **Saved prompts.** A template is a named piece of text; picking one inserts that text as if you had
  typed it. It is not a macro and not a script — the server stores it in a text column and never
  evaluates it. Managing templates needs the `prompts` capability.
- **An action proposal card.** If the assistant wants to change a record, the turn pauses and a card
  appears with the action class, the risk level, a plain-text preview of the proposal and an expiry.
  **Confirm** and **Reject** are the only outcomes; both call the server, which rechecks your ACL, the
  record's current state, the proposal hash and the expiry before anything is written. Once it expires,
  or someone else has decided it, the buttons disappear.

Under an assistant answer there are **thumbs up** and **thumbs down** when the deployment turns on
`feedback` and you hold the `feedback` capability. A rating is audited and inert: it does not change
the model, the tools or anyone's permissions, and a down vote may carry an optional comment.

There is no file picker, no image paste and no attachment path in the composer. It also cannot pick an
agent, a model or a tool, and the contract blocks bulk destructive operations, ACL or role changes,
credential handling, payments, invoice issue or void, campaign sends, external messaging, provider
configuration, tool registration, and raw SQL. These are refused on the server, not merely hidden.

## The voice inbox

[The voice inbox](/voice-inbox) is one screen with two surfaces, chosen by a segmented control.

**Inbox** lists conversations on the left and the selected thread on the right. Filter by status
(`open`, `pending_customer`, `pending_internal`, `resolved`, `closed`, `spam`), by channel (`sms`,
`mms`, `whatsapp`), and by *Only mine*. Each row shows the unread count and last activity time.

A thread shows:

- Message bubbles: inbound in grey, outbound in blue, and internal notes in yellow with a dashed
  border — a note is visibly never customer text.
- Event rows in the middle of the timeline for status changes, assignment, unassignment and case links.
- Header controls to assign the thread to a user, change its status, mark it read, and **Handoff to
  Case**. Handing off creates a Service Desk case linked to the thread; pressing it twice on the same
  thread returns the existing case rather than making a second one.
- A composer: up to 4,000 characters, a **snippet** picker whose placeholders you fill in yourself
  (the server does not resolve them from CRM data), a live segment and encoding hint for the channel,
  and an **Internal note** switch that saves the text instead of sending it. Each send carries a
  client-generated idempotency key, so a double click or a retry is one message.

**Calls** is the call log — the last 50 sessions, newest first, each with direction, state, duration
and failure category. Open a session for its detail: direction, from and to numbers, when it started,
how long, the outcome, and the linked CRM activity. Two panels below:

- **Recordings**, if any exist. Playback goes through the API and returns bytes from private storage;
  the browser never sees a provider URL or token.
- **Transcript**, if the deployment enables it. You can request one and refresh its state. When AI
  enrichment is on, **Enrich** adds a draft summary, topics, actions and a suggested reply. The draft
  stays a draft: **Approve** and **Dismiss** only record your review, and nothing the model produced is
  sent on its own.

An incoming-call banner appears in the corner of every screen while a call is ringing for you. It
shows the number, the CRM records you are permitted to match to that caller, and exactly the controls
the provider account supports — answer and hang up. Save a note or associate the call from the banner
without navigating away.

## What has to be switched on

> [!WARNING]
> There is no autonomous "voice agent". Nothing answers a call for you and no bot replies to a
> customer on its own. The AI on the voice side is the draft enrichment on a transcript, and a human
> still has to send the message.

Everything else on these two surfaces is behind a switch. On Chat, `features.workspace` is on by
default so the shell opens, but `readTools`, `helpRetrieval`, `actionProposals`, `feedback` and
`conversationSearch` all start off, and a proposal only executes when the administrator has also
turned on `safety.allowWrites`. On the voice side, `voice`, `sms`, `mms`, `whatsapp`, `recordings`,
`transcripts` and `aiEnrichment` all start off, and a call or message has to name a configured
provider account; this build ships only a simulator and a disabled adapter, so no live call reaches a
real phone until a production adapter is registered.

## Where to go next

- [Configuring CRM Chat](admin/crm-chat) — the switches, the assistant and the safety gate an administrator controls.
- [Stream and notifications](user/stream-and-notifications) — where case handoffs and call notes land.
- [Record page](user/record-page) — how a call or a case sits on the CRM record itself.
- [Settings overview](admin/settings-overview) — the switches this page mentions.
