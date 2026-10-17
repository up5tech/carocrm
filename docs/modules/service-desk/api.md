# Service Desk API

All routes are under `/api/v1/ServiceDesk`. Entity CRUD stays on the generic `/api/v1/:entity` API
(`Case`, `CaseQueue`, `QueueMember`, `RoutingRule`, `BusinessCalendar`, `SLAPolicy`,
`KnowledgeArticle`, `KnowledgeCategory`); the routes below express commands that a single record
write cannot.

Authentication is the normal bearer session unless marked **public**. Shape errors are
`400 INVALID_QUERY`; domain-rule failures are `422 VALIDATION_FAILED`; missing permissions are `403`;
missing records are `404`.

## Diagnostics and configuration

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/action/health` | administrator | module descriptor, dependencies, optional integrations, feature state, warnings |
| GET | `/action/settings` | authenticated | validated settings + defaults + warnings |
| POST | `/action/settings` | administrator | validated partial patch; bumps the version |
| GET | `/action/caseNumberPreview` | administrator | next case number without consuming it |
| GET | `/action/metrics?from&to` | `Case` read | ACL-scoped volume/backlog/SLA/reopen/CSAT metrics |

## Case commands

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/action/case/:id/capabilities` | `Case` read | allowed commands and conversation/assignment capabilities |
| POST | `/action/case/:id/transition` | record `edit` | `{command}` or `{to}`; validates the state machine |
| POST | `/action/case/:id/{start,resolve,close,reopen,cancel,escalate,deEscalate}` | record `edit` | named transition verbs |
| GET | `/action/case/:id/history` | `Case` read | `CaseTransition` rows, oldest first |
| POST | `/action/case/:id/reply` | staff + stream permission | customer-visible reply; stamps response clocks |
| POST | `/action/case/:id/note` | staff + stream permission | internal note; never customer-visible |
| GET | `/action/case/:id/conversation` | `Case` read | visibility-filtered stream, oldest first |
| POST | `/action/case/:id/assign` | record `edit` + assignment scope | manual/team/queue assignment |
| POST | `/action/case/:id/route` | record `edit` | evaluate routing rules |
| GET | `/action/case/:id/assignments` | `Case` read | assignment history |
| GET | `/action/queues` | admin/read-all | queues with member/unassigned counts |
| GET | `/action/queues/:id/workload` | read-all or queue/team member | per-member active counts |
| GET | `/action/case/:id/duplicateCandidates` | `Case` read | up to ten readable duplicate candidates |
| POST | `/action/case/:id/merge` | record `edit` | `{intoCaseId}`; atomic, audited merge |

## Channels

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/action/emailToCase` | `emailToCase` feature | process one stored inbound email |
| POST | `/action/emailToCase/processInbound` | `emailToCase` feature | poll then process stored inbound mail |
| POST | `/action/case/:id/emailReply` | `emailToCase` feature + case read | threaded outbound reply |
| POST | `/action/webToCase` | **public** | strict allowlist, honeypot, per-IP rate limit, idempotency key |
| POST | `/action/csat/submit` | **public, token** | one-time survey submission |
| POST | `/action/case/:id/csat/invite` | record `edit` + resolved case | create a hashed expiry token |
| GET | `/action/case/:id/csat` | staff `Case` read | rating count/average |

## Knowledge Base

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/action/knowledge/:id/publish` | administrator | publish with audit |
| POST | `/action/knowledge/:id/archive` | administrator | archive with audit |
| GET | `/action/knowledge/portal` | authenticated | published, non-internal, in-date articles |
| GET | `/action/case/:id/knowledgeSuggestions` | `Case` read | advisory suggestions |

## SLA

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/action/sla/checkBreaches` | administrator | idempotent warning/breach pass |
| POST | `/action/sla/runScheduledCheck` | administrator | full scan incl. notifications and KB expiry |
| POST | `/action/sla/run-scheduled-check` | **worker**, `x-worker-secret` | the scheduled twin |

## Settings shape

```json
{
  "features": {
    "caseManagement": true, "queues": false, "sla": false, "notifications": false,
    "emailToCase": false, "portal": false, "knowledgeBase": false, "csat": false
  },
  "numbering": { "prefix": "C", "padding": 6 },
  "defaults": { "status": "New", "priority": "Normal", "type": "Question", "source": "Web" },
  "resolution": { "requireCode": true, "requireSummary": false, "codes": ["Solved"], "reopenWindowDays": 0 },
  "assignment": { "defaultQueueId": null },
  "sla": { "lastScanAt": null },
  "email": { "replyFromAddress": "" }
}
```

`lastScanAt` is operational metadata written by the scheduler without bumping the settings version.
