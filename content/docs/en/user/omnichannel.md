---
title: Omnichannel inbox
summary: The shared inbox for SMS, WhatsApp and website chat — filters, replies, notes, routing, identity and Cases.
audience: user
order: 135
tags: [omnichannel, inbox, sms, whatsapp, web-chat, conversations]
aliases: ["hộp thư đa kênh", "đa kênh", "omnichannel là gì", "trả lời tin nhắn khách hàng", "hộp thư chat website"]
related: [user/chat-and-voice, user/service-desk-cases, user/ai-agents, admin/omnichannel]
updated: 2026-10-30
---

Open [Omnichannel](/omnichannel). It is one workspace over the customer conversations that Voice &
Communications already stores: SMS, WhatsApp and the website chat. It is not a second chat product and
keeps no copy of a conversation; the records stay with the channel that received them.

The page has four tabs: **Inbox**, **Reports**, **Operations** and **Diagnostics**. Your role decides
which of them open. If the workspace switch is off, the page says so and only an administrator can turn
it back on — [Configuring Omnichannel](admin/omnichannel) describes that side.

## The Inbox tab

The left column is the conversation list, newest activity first. Above it, every filter is a server-side
query, so the list only contains what you are allowed to see:

- **View** — All conversations, My conversations, Unassigned, Waiting on customer, Waiting on agent,
  Snoozed or Closed.
- **Channel**, **Priority**, **Language**, **Queue** and **Tag** narrow the same list further.
- **Unread only** hides conversations you have already opened.
- **Refresh** re-asks the server. The list also refreshes on its own every ten seconds, and the open
  conversation's timeline every eight seconds.

Each row shows the customer name or address, the channel, a non-normal priority, a snoozed marker, the
status, the last activity time, tags and an unread count. Selecting a row marks it read and opens it on
the right.

## Reading and replying

The right pane is the conversation. The timeline is plain text — no HTML from a customer is rendered —
and internal notes are marked and visually distinct. They are never sent to the customer and never
appear in a Case description.

The composer has three ways to work:

- **Write a reply…** and **Send** sends a customer-visible message through the channel. **Internal note**
  turns the same box into a note, and **Add note** files it without sending.
- **Insert a snippet…** puts a saved canned reply into the draft. A snippet is text, not a macro, and the
  server still applies the channel's policy when the message is sent.
- **AI suggest** asks the configured agent for a suggested reply. It only fills the editable draft;
  nothing is sent by the suggestion.

Your draft is stored per conversation and restored when you come back to it. Sending removes the draft.

The compact status control changes the conversation between Open, Waiting on customer, Waiting on
agent, Resolved, Closed and Spam. **Assign to me** takes it with a version check, so two agents clicking
at the same time do not silently overwrite each other; **Unassign** releases it. **Route** hands the
conversation to the Service Desk routing rules and tells you which rule matched, or why it fell back to
unassigned.

## Identity, Cases and calls

Three panels sit around the reply box:

- **Customer identity** compares the participant's normalized phone number or email against readable
  Contact and Lead records. An exact single match is evidence, not a decision; two readable matches
  become a review conflict. When the automatic answer is wrong, **Link** and **Unlink** let you correct
  it, each with a reason that is audited. Linking does not rename the customer's messages.
- **Case** shows the support Case already linked to this conversation. **Create case** opens a new one
  with the customer-visible context, **Link case** attaches an existing Case by id, and **Open case**
  leaves the inbox for the Case record. Only the Service Desk hand-off command writes the link.
- **Recent calls** lists calls from the same channel owner as context. A call is never turned into a
  message; **Open conversation** jumps to the conversation that belongs to that number, when one exists.

## The Reports tab

Reports answers for the last 30 days with numbers computed by the server, not by the browser:

- **Inbound** and **Outbound** message counts, **Unassigned** conversations and **Handed off** Cases.
- **Message volume by channel**, the **Backlog** by status, and **Assignment** by agent.
- **Timing** — first response, reply delay and reopen rate.
- **Delivery outcomes** — failed, undelivered and unknown, kept apart. An unknown outcome is a provider
  timeout, not a success and not a failure.
- **Provider health** and the webhook receipt backlog.

A metric with no sample shows **—** and the server's reason instead of a zero. Reports contain no
message content or addresses.

## Operations and Diagnostics

**Operations** is for the people who run the channels. With the operations-read capability you see the
connections, whether a credential and webhook secret are present (never their values), the last health
probe, the receipt backlog and the top failure codes. **Test connection** probes a provider, **Inspect**
shows the redacted stored receipt, **Replay** queues a receipt again, and the connection switch is a
kill switch for that account.

**Diagnostics** answers "why is this not working": the platform pieces the workspace depends on, the
channel catalog, your capabilities and the module version. An administrator also sees the **Workspace**
switch there and can close or reopen the whole module.

## What this workspace does not do

- It is not live. The inbox and timeline poll on a timer; there is no streaming connection in this build.
- SMS and WhatsApp are the supported messaging channels through the Twilio adapter. MMS, Messenger,
  Instagram, email and Telegram are not channels here.
- A voice call is context, not a conversation channel: you can open the call's conversation, but the
  inbox does not ring, answer or transcribe.
- An AI suggestion never sends. A proposal that would write a record pauses for a human approval in
  [AI agents](user/ai-agents).
- Conversation access is the module's capability, not per-record ownership in this build. Anyone who
  holds the inbox capability can see the conversations the module exposes, so grant it deliberately.

## Where to go next

- [CRM Chat and the voice inbox](user/chat-and-voice) — the assistant chat and the single-channel inbox,
  which are separate from this workspace.
- [Cases, queues and SLAs](user/service-desk-cases) — what happens after **Create case**.
- [AI agents](user/ai-agents) — approvals and what a run records.
- [Configuring Omnichannel](admin/omnichannel) — switches, provider accounts, web chat and roles.
