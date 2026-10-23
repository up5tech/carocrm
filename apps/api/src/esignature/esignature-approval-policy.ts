import type { ApprovalRule, ESignatureSettings } from './esignature-settings.service.js';

/**
 * Phase 19-ES.17 — the approval policy engine, as a pure function
 * (`PLAN_Phase_19_ESignature.md` §11.1, §18 `19-ES.17`).
 *
 * The policy answers one question for a prepared request: **does this set of bytes need a second
 * person's decision before it can leave the CRM?** It is evaluated from the linked source record's
 * values, so a rule can cover a source type, a contract type, a risk level or a monetary threshold
 * without any code change. Three choices are deliberate:
 *
 *  - **Rules are data, never expressions.** Each rule names one metadata field, one closed operator
 *    and a literal; nothing is evaluated as code or interpolated into SQL (AGENTS.md §5.2).
 *  - **Unreadable evidence fails closed.** If the policy names a field the caller cannot read, or the
 *    linked record is gone, the request requires approval rather than silently skipping the rule.
 *    Missing values also fail closed: a policy must not be bypassed by leaving a field blank.
 *  - **The feature switch gates policy.** With the `approvals` feature off, only a request whose
 *    draft explicitly set `approvalRequired` still needs a decision. Turning the workflow off is an
 *    administrator's deliberate choice, not an accident of an empty rule list.
 */

export type ApprovalPolicyReasonCode =
  | 'explicit'
  | 'source_entity'
  | 'rule'
  | 'source_unavailable'
  | 'field_missing'
  | 'field_not_numeric'
  | 'rule_invalid';

export interface ApprovalPolicyReason {
  readonly code: ApprovalPolicyReasonCode;
  readonly label: string;
  /** The rule that produced the reason, when one did. */
  readonly ruleLabel: string | null;
}

export interface ApprovalPolicyDecision {
  readonly required: boolean;
  readonly reasons: readonly ApprovalPolicyReason[];
  /** The labels of every rule that matched, in policy order. */
  readonly matchedRules: readonly string[];
  /**
   * The exact policy evidence the decision was made from: the reasons and the source values the
   * matched rules read. The preview hashes this into the outgoing snapshot, so a change to the
   * reviewed source terms makes a stored approval stale even when the document bytes did not change.
   */
  readonly basis: Readonly<Record<string, unknown>>;
}

export interface ApprovalPolicyInput {
  readonly settings: ESignatureSettings;
  readonly sourceEntityType: string | null;
  /** The source record's values, or `null` when it is missing or unreadable. */
  readonly sourceValues: Readonly<Record<string, unknown>> | null;
  /** The draft's own `approvalRequired` flag (a sender can ask for review voluntarily). */
  readonly explicitRequired: boolean;
}

export function evaluateApprovalPolicy(input: ApprovalPolicyInput): ApprovalPolicyDecision {
  const reasons: ApprovalPolicyReason[] = [];
  const matchedRules: string[] = [];
  const matchedValues: Record<string, unknown> = {};
  const decision = (): ApprovalPolicyDecision => ({
    required: reasons.length > 0,
    reasons,
    matchedRules,
    basis: {
      sourceEntityType: input.sourceEntityType,
      // The explicit draft flag is deliberately excluded: preparation persists it as the effective
      // requirement, so including it would make the first re-preview after preparation a different
      // digest. The boolean `policy.approvalRequired` still covers the decision itself.
      reasons: reasons.filter((reason) => reason.code !== 'explicit').map((reason) => `${reason.code}:${reason.label}`),
      rules: matchedRules,
      values: matchedValues,
    },
  });

  if (input.explicitRequired) {
    reasons.push({ code: 'explicit', label: 'The sender requested an approval for this request.', ruleLabel: null });
  }

  const policyActive = input.settings.enabled === true && input.settings.features.approvals === true;
  if (!policyActive) {
    return decision();
  }

  if (input.sourceEntityType !== null && input.settings.approval.requiredForSourceEntities.includes(input.sourceEntityType)) {
    reasons.push({
      code: 'source_entity',
      label: `Source entity "${input.sourceEntityType}" always requires an approval.`,
      ruleLabel: null,
    });
  }

  if (input.sourceEntityType !== null) {
    for (const rule of input.settings.approval.rules) {
      if (rule.sourceEntityType !== input.sourceEntityType) continue;
      const result = evaluateRule(rule, input.sourceValues);
      if (result.matched) {
        reasons.push(result.reason);
        matchedRules.push(rule.label);
        matchedValues[`${rule.sourceEntityType}.${rule.field}`] = input.sourceValues?.[rule.field] ?? null;
      }
    }
  }

  return decision();
}

function evaluateRule(
  rule: ApprovalRule,
  sourceValues: Readonly<Record<string, unknown>> | null,
): { matched: boolean; reason: ApprovalPolicyReason } {
  const reason = (code: ApprovalPolicyReasonCode, message: string): { matched: true; reason: ApprovalPolicyReason } => ({
    matched: true,
    reason: { code, label: `${rule.label}: ${message}`, ruleLabel: rule.label },
  });

  if (sourceValues === null) {
    return reason('source_unavailable', 'the linked source record is missing or not readable, so the rule is applied.');
  }
  const raw = sourceValues[rule.field];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return reason('field_missing', `the source field "${rule.field}" is empty, so the rule is applied.`);
  }
  const text = String(raw).trim().toLowerCase();

  if (rule.operator === 'equals') {
    return text === rule.value.trim().toLowerCase()
      ? reason('rule', `"${rule.field}" is "${rule.value}".`)
      : { matched: false, reason: { code: 'rule', label: rule.label, ruleLabel: rule.label } };
  }
  if (rule.operator === 'not_equals') {
    return text !== rule.value.trim().toLowerCase()
      ? reason('rule', `"${rule.field}" is not "${rule.value}".`)
      : { matched: false, reason: { code: 'rule', label: rule.label, ruleLabel: rule.label } };
  }
  if (rule.operator === 'contains') {
    return text.includes(rule.value.trim().toLowerCase())
      ? reason('rule', `"${rule.field}" contains "${rule.value}".`)
      : { matched: false, reason: { code: 'rule', label: rule.label, ruleLabel: rule.label } };
  }

  const sourceNumber = Number(raw);
  const policyNumber = Number(rule.value);
  if (!Number.isFinite(sourceNumber)) {
    return reason('field_not_numeric', `"${rule.field}" is not a number, so the rule is applied.`);
  }
  if (!Number.isFinite(policyNumber)) {
    return reason('rule_invalid', `the rule's threshold "${rule.value}" is not a number.`);
  }
  const matched = rule.operator === 'gte' ? sourceNumber >= policyNumber : sourceNumber <= policyNumber;
  return matched
    ? reason('rule', `"${rule.field}" is ${rule.operator === 'gte' ? 'at least' : 'at most'} ${rule.value}.`)
    : { matched: false, reason: { code: 'rule', label: rule.label, ruleLabel: rule.label } };
}
