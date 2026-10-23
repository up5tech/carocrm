import { describe, expect, it } from 'vitest';

import { evaluateApprovalPolicy } from '../src/esignature/esignature-approval-policy.js';
import { ESignatureSettingsSchema } from '../src/esignature/esignature-settings.service.js';

/**
 * Phase 19-ES.17 — the approval policy engine
 * (`PLAN_Phase_19_ESignature.md` §11.1, §18 `19-ES.17`).
 *
 * The engine is pure, so every policy decision is unit-tested without a database or a provider. The
 * cases below are the plan's policy examples: source type, a value/risk field and a monetary
 * threshold, plus the fail-closed behaviour that keeps an unreadable or empty field from bypassing a
 * rule.
 */

function settings(approval: Record<string, unknown> = {}, features: Record<string, boolean> = {}) {
  return ESignatureSettingsSchema.parse({
    enabled: true,
    features: { requests: true, approvals: true, ...features },
    approval,
  });
}

const RULE = {
  label: 'High-value contract',
  sourceEntityType: 'Quote',
  field: 'amount',
  operator: 'gte',
  value: '10000',
};

describe('approval policy', () => {
  it('requires approval for a configured source entity, and not for another one', () => {
    const policy = settings({ requiredForSourceEntities: ['Account'] });
    const matching = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Account', sourceValues: {}, explicitRequired: false });
    expect(matching.required).toBe(true);
    expect(matching.reasons.map((reason) => reason.code)).toContain('source_entity');
    const other = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Contact', sourceValues: {}, explicitRequired: false });
    expect(other.required).toBe(false);
  });

  it('evaluates a numeric threshold against the linked record, in both directions', () => {
    const policy = settings({ rules: [RULE] });
    const high = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Quote', sourceValues: { amount: '25000' }, explicitRequired: false });
    expect(high.required).toBe(true);
    expect(high.matchedRules).toEqual(['High-value contract']);
    expect(high.reasons[0]?.label).toContain('at least 10000');
    const low = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Quote', sourceValues: { amount: 5000 }, explicitRequired: false });
    expect(low.required).toBe(false);
  });

  it('supports equality, inequality and contains rules for type and risk values', () => {
    const equal = settings({ rules: [{ label: 'Banking', sourceEntityType: 'Account', field: 'industry', operator: 'equals', value: 'Banking' }] });
    expect(evaluateApprovalPolicy({ settings: equal, sourceEntityType: 'Account', sourceValues: { industry: 'banking' }, explicitRequired: false }).required).toBe(true);
    expect(evaluateApprovalPolicy({ settings: equal, sourceEntityType: 'Account', sourceValues: { industry: 'Technology' }, explicitRequired: false }).required).toBe(false);

    const notEqual = settings({ rules: [{ label: 'Not standard', sourceEntityType: 'Account', field: 'type', operator: 'not_equals', value: 'Customer' }] });
    expect(evaluateApprovalPolicy({ settings: notEqual, sourceEntityType: 'Account', sourceValues: { type: 'Partner' }, explicitRequired: false }).required).toBe(true);

    const contains = settings({ rules: [{ label: 'Sensitive', sourceEntityType: 'Account', field: 'industry', operator: 'contains', value: 'fin' }] });
    expect(evaluateApprovalPolicy({ settings: contains, sourceEntityType: 'Account', sourceValues: { industry: 'Fintech' }, explicitRequired: false }).required).toBe(true);
  });

  it('fails closed when the source record or the named field is unavailable', () => {
    const policy = settings({ rules: [RULE] });
    const unreadable = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Quote', sourceValues: null, explicitRequired: false });
    expect(unreadable.required).toBe(true);
    expect(unreadable.reasons[0]?.code).toBe('source_unavailable');

    const blank = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Quote', sourceValues: { amount: '' }, explicitRequired: false });
    expect(blank.required).toBe(true);
    expect(blank.reasons[0]?.code).toBe('field_missing');

    const nonNumeric = evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Quote', sourceValues: { amount: 'not-a-number' }, explicitRequired: false });
    expect(nonNumeric.required).toBe(true);
    expect(nonNumeric.reasons[0]?.code).toBe('field_not_numeric');
  });

  it('ignores rules for other entities and is inactive when the feature is off', () => {
    const policy = settings({ rules: [RULE] });
    expect(evaluateApprovalPolicy({ settings: policy, sourceEntityType: 'Account', sourceValues: { amount: '99999' }, explicitRequired: false }).required).toBe(false);

    const disabled = settings({ rules: [RULE] }, { approvals: false });
    expect(evaluateApprovalPolicy({ settings: disabled, sourceEntityType: 'Quote', sourceValues: { amount: '99999' }, explicitRequired: false }).required).toBe(false);
  });

  it('always honours a sender’s explicit request, even without a policy', () => {
    const decision = evaluateApprovalPolicy({ settings: settings(), sourceEntityType: null, sourceValues: null, explicitRequired: true });
    expect(decision.required).toBe(true);
    expect(decision.reasons[0]?.code).toBe('explicit');
  });
});
