/**
 * Phase 19-INT.25 — the protected field policy
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2; `19-INT.25`).
 *
 * The plan says: *"Do not allow imported payload fields to assign owners, teams, permissions,
 * roles, payment status, consent, or other protected values unless an explicit reviewed mapping and
 * owning-service policy permits it."*
 *
 * Two halves of that sentence, and the policy implements both:
 *
 *  - **The default is a refusal.** A field in the list below is *never* written by an imported
 *    payload, whatever the provider sent. The list is deliberately conservative: it holds the
 *    fields that decide **who** may act on a record and **what a record means financially or for
 *    consent** — not the fields that merely hold data.
 *  - **The escape hatch is a recorded review.** A mapping may set `allowProtected` on a field.
 *    That is the "explicit reviewed mapping" the plan asks for: the decision is a property of the
 *    mapping, it is visible in the mapping builder, and it is refused unless the target really is
 *    a protected field. It is **not** a global switch, so one reviewed field does not unlock the
 *    rest.
 *
 * The point is that an imported payload can never *become* an authorization. A provider that
 * returns `"assignedUserId": "someone-else"` in a record body cannot hand the record to that
 * person, and a provider cannot write a payment status or a consent state.
 */

/**
 * The CRM fields an imported payload may not write.
 *
 * The list is by field *name*, because the platform's records are attribute maps and the names are
 * the contract. It is intentionally short: a list of every sensitive field would be a list that
 * is wrong the moment a module adds one, and a false sense of completeness. These are the fields
 * that grant access or decide meaning.
 */
export const PROTECTED_CRM_FIELDS: readonly string[] = [
  // Who may act on the record.
  'assignedUserId',
  'teams',
  'roles',
  'roleIds',
  'permissions',
  'isAdmin',
  // What the record means financially.
  'paymentStatus',
  'amountDue',
  'amountPaid',
  'balance',
  'allocationStatus',
  // What the record means for consent.
  'consentStatus',
  'consentChannel',
  'consentSource',
  'emailVerified',
  'phoneVerified',
];

/** Whether a CRM field is protected. */
export function isProtectedField(fieldName: string): boolean {
  return PROTECTED_CRM_FIELDS.includes(fieldName);
}

/** The protected fields a set of targets touches. */
export function protectedTargetsAmong(targets: readonly string[]): readonly string[] {
  return targets.filter((target) => isProtectedField(target));
}
