# Portal case security

The portal never reuses the internal ACL. `PortalPolicyService` resolves authority only from
`portal_roles`, then narrows record visibility to the signed-in contact/account neighbourhood.

`features.portal` is the module-level switch: while it is off, `PortalPolicyService` returns `no` for
every `Case` ACL decision even though the portal role grants it, so no portal session can read or
write a case. The role permissions and field projection below apply once the flag is on.

## Seeded access

The `Portal Customer` role created by `database/seed.ts` carries:

- `Case`: read `all`, create `yes`, edit `no`, delete `no`, stream `yes`;
- field permissions that hide assignment (`assignedUserId`, `teams`, `teamId`, `queueId`,
  `routingRuleId`), SLA/escalation (`slaPolicyId`, `slaState`, `isEscalated`, `escalationLevel`,
  `escalatedAt`, response timestamps), merge/hidden state (`mergedIntoCaseId`, `isHiddenFromPortal`),
  `leadId`, resolver and creator/modifier identities;
- read-only customer-safe fields (`caseNumber`, status, priority, severity, type, source, resolution,
  dates, Account/Contact) and editable subject/description/requester fields.

Existing installations keep non-empty custom `field_permissions`; the seed only fills an empty
configuration and merges the `Case` permission into the existing entity map.

## Read scope

`recordPredicate('Case')` allows a case when it **is** the portal contact/account, carries
`contactId`/`accountId` for them, or is linked to them through `entity_links`. Without a contact or
account the predicate is `denyAll`. A case with `isHiddenFromPortal = true` is excluded even inside
the neighbourhood. The same predicate is compiled into list SQL and evaluated for by-id reads, so a
list and a detail read cannot disagree.

Field ACL removes hidden fields from every serialized response (`EntityCrudService.serialize` →
`AclApiService.stripRestricted`). The SPA additionally does not render those fields, but that is
presentation only.

## Writes

- The `beforeValidate` guard strips privileged fields from a portal payload and derives
  `contactId` from the portal identity; `source` is forced to `Portal`.
- Field ACL rejects a portal write to a read-only field; sending `status`, `assignedUserId`, `source`
  or `caseNumber` therefore fails with `4xx` rather than being silently accepted.
- A portal principal may only create `public` Stream entries. The generic `Note` endpoint forces
  `public`; asking for `internal` or `system` is refused.
- Internal notes, system updates and internally-classified attachments are filtered from the record
  stream and the attachment download gate.
- Portal users cannot run lifecycle commands, assign, merge or read CSAT aggregates; those require
  internal edit/read scope.

## Customer UI

- `PortalCaseConversation` reads `GET /Case/:id/stream` (server-filtered to public) and posts through
  `POST /Note`; it never calls the staff reply/note commands.
- The portal list/detail/edit screens use the generated entity pages with hidden Case fields removed.
- `/csat?token=…` is token-only and works without a CRM session; the token is hashed at rest,
  expires after seven days and is single-use.
- Published Knowledge Base suggestions are shown through
  `GET /ServiceDesk/action/case/:id/knowledgeSuggestions`, which uses the same portal visibility
  filter.

## Tests

`apps/api/test/service-desk-portal.test.ts` proves cross-account IDOR refusal, field projection,
public-only conversation, forced-public replies, server-derived source/requester and privileged-field
refusal. `service-desk-conversation.test.ts` covers forged visibility and attachment inheritance.
