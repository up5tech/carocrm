# Voice & Communications — 19-VC.12 … 19-VC.17 completion report

> Scope: unified inbox domain, assignment and Service Desk handoff, service snippets and composer
> validation, recordings and secure media, transcription and AI enrichment, CRM panels and Customer
> Success touchpoints. Migrations `053` and `054` applied; 100 Voice & Communications tests pass.

## What was delivered

| Sub-phase | Deliverable | File |
| --- | --- | --- |
| 19-VC.12 | Inbox list with indexed filters, merged message/history timeline, read state, status changes, append-only history | `apps/api/src/voice-communications/voice-inbox.service.ts` |
| 19-VC.13 | User/team assignment with history, Case link, idempotent Case handoff | same service, plus `voice_conversation_events` |
| 19-VC.14 | Local service snippets, strict `{{name}}` placeholders, render with caller-supplied values, SMS segment arithmetic, composer validation | `voice-message-template.service.ts` |
| 19-VC.15 | Recording reference from a signed callback, SSRF-checked fetch into private storage, ACL playback, retention sweep | `voice-media.service.ts`, `media-url.ts` |
| 19-VC.16 | Provider transcript retrieval with segments, opt-in AI enrichment through the AI gateway, draft-only review state | `voice-transcription.service.ts` |
| 19-VC.17 | Record-ACL-aware panel (conversations + calls), touchpoint counts, link a conversation to a record | `voice-panel.service.ts` |

Supporting changes: `recording` added to `PROVIDER_EVENT_KINDS` and to the
`voice_communication_events.kind` check (migration 054); `media` and `ai` settings sections;
`media-events` webhook kind; `fetchTranscript` on the adapter contract (optional) and on the
simulator; three worker endpoints (process receipt, fetch media, retention sweep).

## Decisions worth remembering

1. **History is rows, not columns.** `voice_conversations` keeps the current assignee and status; every
   change is an immutable `voice_conversation_events` row with actor and time. Overwriting the
   column would have made "who moved this and when" unanswerable, which §9.1 explicitly requires.
2. **The conversation's `case_id` is the handoff idempotency key.** A repeated click returns the same
   Case with `duplicate: true`. The Case is created through `EntityCrudService`, so Service Desk's own
   write guard runs — which is why the handoff supplies `requesterName` (Service Desk refuses a Case
   with no requester). Conversation status and Case status never write to each other.
3. **Snippets never resolve CRM fields.** `render` substitutes only the literal strings the caller
   passes, so a snippet cannot pull a field the caller could not read, and no markup can be injected
   into a text channel. Local snippets and provider-approved WhatsApp templates live in different
   tables and share no id space.
4. **Recording bytes are fetched by the module, never by an adapter.** The adapter reports a URL; the
   module validates it (https, host allowlist, no private/metadata destination) and fetches with a
   timeout and a size ceiling. That keeps one SSRF rule instead of one per adapter.
5. **A refused media URL is a permanent verdict.** The receipt is processed with the reason recorded,
   not retried — otherwise a bad URL becomes a retry storm. `assertSafeMediaUrl` is async (DNS) and
   must be awaited; a missing `await` silently skipped the check during development, which the SSRF
   test now pins.
6. **AI output is inert.** `ai_review_status` starts `pending`; the service has no tools, writes only
   its own transcript row, and sends only redacted transcript text to the platform gateway. A
   suggested reply with no content cannot be approved (there is nothing to approve).
7. **Panels read; they never create.** The single Call Activity per session is created by the calls
   service, and Customer Success receives event ids/verbs and touchpoint counts — so no consumer can
   duplicate an Activity.

## Verification

```
pnpm typecheck                      # API project clean (web is mid-refactor in another change)
npx eslint apps/api/src/voice-communications apps/api/test/voice-communications-*.test.ts
pnpm vitest run apps/api/test/voice-communications-domain.test.ts        # 35
pnpm vitest run apps/api/test/voice-communications.test.ts               # 24
pnpm vitest run apps/api/test/voice-communications-calls.test.ts         #  9
pnpm vitest run apps/api/test/voice-communications-messaging.test.ts     # 10
pnpm vitest run apps/api/test/voice-communications-inbox.test.ts         # 22
```

The new suite covers: inbox materialization and listing, timeline merge, read state, status history,
assignment + history, invalid assignee, handoff idempotency (one Case for two clicks), conversation/Case
status independence, snippet placeholders and rendering, missing-variable refusal, UCS-2 and length
warnings, recording reference + SSRF refusal, private fetch + authorized playback, playback denial for
an outsider, transcript retrieval (idempotent), enrichment refusal while disabled, enrichment with
provenance, review state, panel ACL/refusals, and panel + touchpoint output.

## Deliberately not built

- SPA screens (inbox, composer, call popup, media player, CRM panel widget). The APIs and tests exist;
  a dedicated UI phase is a separate deliverable.
- Portal conversation surface — no product requirement, and a second ACL surface would need its own
  proof that internal notes cannot leak.
- A live telephony or speech vendor. The simulator and the fake AI adapter are the only providers, by
  design (§15.4).
- MMS send, round-robin assignment (no reliable capacity signal yet), and recording consent capture
  beyond the configured `media.noticeRequired` flag.
