/**
 * Phase 25.6 — pure event-trigger filtering.
 *
 * The config allowlists are checked against committed event metadata before a run is created.
 * Conditions use the same sandboxed `@carocrm/formula` engine as workflow condition nodes; the
 * model never supplies an expression and no new language is introduced.
 */

import { FormulaEngine } from '@carocrm/formula';

import { type AgentConfig, AGENT_PREVIOUS_FIELD_PREFIX } from '../ai-agent-config.js';

export interface TriggerEventValues {
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface TriggerEventFilterInput {
  readonly eventId: string;
  readonly eventType: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.restored';
  readonly entityType: string;
  readonly entityId: string;
  readonly changed: readonly string[];
  readonly values?: TriggerEventValues | undefined;
  readonly now?: Date | undefined;
}

export type TriggerFilterReason =
  | 'event-not-enabled'
  | 'event-type-not-listed'
  | 'entity-not-listed'
  | 'record-context-mismatch'
  | 'watched-field-requires-update'
  | 'watched-field-unchanged'
  | 'condition-requires-update'
  | 'condition-needs-watched-fields'
  | 'condition-false'
  | 'condition-error';

export interface TriggerFilterResult {
  readonly matched: boolean;
  readonly reason?: TriggerFilterReason | undefined;
}

const ENGINE = new FormulaEngine();

function previousKey(field: string): string {
  return `${AGENT_PREVIOUS_FIELD_PREFIX}${field}`;
}

/**
 * Decide whether one published agent config should start on this event. Fail closed: an
 * unparseable condition or missing transition data is a skip, never a run.
 */
export function evaluateEventTriggerFilter(config: AgentConfig, input: TriggerEventFilterInput): TriggerFilterResult {
  const triggers = config.triggers;
  if (!triggers.event) return { matched: false, reason: 'event-not-enabled' };
  if (!triggers.eventTypes.includes(input.eventType)) return { matched: false, reason: 'event-type-not-listed' };
  if (!triggers.eventEntities.includes(input.entityType)) return { matched: false, reason: 'entity-not-listed' };
  if (config.input.mode !== 'record' || config.input.entity !== input.entityType) {
    return { matched: false, reason: 'record-context-mismatch' };
  }

  const watched = triggers.watchedFields;
  if (watched.length > 0 && input.eventType !== 'entity.updated') {
    return { matched: false, reason: 'watched-field-requires-update' };
  }
  if (watched.length > 0 && !watched.some((field) => input.changed.includes(field))) {
    return { matched: false, reason: 'watched-field-unchanged' };
  }

  const condition = triggers.condition?.trim() ?? '';
  if (condition === '') return { matched: true };
  if (input.eventType !== 'entity.updated') return { matched: false, reason: 'condition-requires-update' };
  if (watched.length === 0) return { matched: false, reason: 'condition-needs-watched-fields' };

  const after = input.values?.after ?? {};
  const before = input.values?.before ?? {};
  const record: Record<string, unknown> = {
    id: input.entityId,
    entityType: input.entityType,
    entityId: input.entityId,
  };
  for (const field of watched) {
    if (Object.prototype.hasOwnProperty.call(after, field)) record[field] = after[field];
    record[previousKey(field)] = Object.prototype.hasOwnProperty.call(before, field) ? before[field] : null;
  }
  try {
    const matched = ENGINE.evaluateCondition(condition, { record, now: input.now ?? new Date() });
    return matched ? { matched: true } : { matched: false, reason: 'condition-false' };
  } catch {
    return { matched: false, reason: 'condition-error' };
  }
}
