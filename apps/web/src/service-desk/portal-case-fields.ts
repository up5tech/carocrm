/**
 * Fields a portal customer's Case screens must not render. Security is enforced server-side by the
 * portal field ACL; this list only keeps the generated list/detail/edit screens honest about what a
 * customer may see (§9.6 "the internal CRM UI and customer portal must not share an unfiltered
 * data serializer").
 */
export const PORTAL_HIDDEN_CASE_FIELDS: ReadonlySet<string> = new Set([
  'status', 'priority', 'severity', 'type', 'source', 'assignedUserId', 'teams', 'teamId',
  'queueId', 'routingRuleId', 'leadId', 'slaPolicyId', 'slaState', 'isEscalated',
  'escalationLevel', 'escalatedAt', 'resolvedById', 'isHiddenFromPortal', 'mergedIntoCaseId',
  'accountId', 'contactId', 'caseNumber', 'lastActivityAt', 'firstResponseAt',
  'lastCustomerResponseAt', 'lastAgentResponseAt', 'resolvedAt', 'closedAt', 'reopenedAt',
  'resolutionCode', 'resolutionSummary',
]);
