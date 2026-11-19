/**
 * Domain event catalog (PLAN §23.2), shared by the API that produces events and the worker that
 * consumes them. Producers write these types into `outbox_events` inside the same transaction as
 * the record mutation, so a committed row and its event appear together or not at all.
 */
export const DOMAIN_EVENT_TYPES = {
  entityCreated: 'entity.created',
  entityUpdated: 'entity.updated',
  entityDeleted: 'entity.deleted',
  entityRestored: 'entity.restored',
} as const;

export const KNOWN_DOMAIN_EVENTS: readonly string[] = Object.values(DOMAIN_EVENT_TYPES);

/** The kernel mutations that publish an entity event. */
export type RecordMutation = 'create' | 'update' | 'delete' | 'restore';

/** Bounded before/after values for fields that actually changed in a mutation. */
export interface EntityEventValues {
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface EntityEventPayload {
  entityType: string;
  entityId: string;
  changed: string[];
  userId: string | null;
  version: number;
  /**
   * 25.6 — a bounded snapshot of the changed fields only. Values are scalars or arrays of
   * scalars; objects are omitted and strings are truncated. This is untrusted data for trigger
   * conditions, never an instruction or a source of record state.
   */
  values?: EntityEventValues | undefined;
}

const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(['id', 'modifiedAt', 'createdAt', 'version', 'deletedAt']);

export function entityEventType(operation: RecordMutation): string {
  switch (operation) {
    case 'create':
      return DOMAIN_EVENT_TYPES.entityCreated;
    case 'update':
      return DOMAIN_EVENT_TYPES.entityUpdated;
    case 'delete':
      return DOMAIN_EVENT_TYPES.entityDeleted;
    case 'restore':
      return DOMAIN_EVENT_TYPES.entityRestored;
  }
}

export interface DomainEventInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date) {
    const a = left instanceof Date ? left.getTime() : Number.NaN;
    const b = right instanceof Date ? right.getTime() : Number.NaN;
    return a === b;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (typeof left === 'object' && typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

/** Field names that differ from the previous state; a create reports every supplied field. */
export function changedFields(data: Readonly<Record<string, unknown>>, previous?: Readonly<Record<string, unknown>>): string[] {
  const keys = new Set([...Object.keys(data), ...Object.keys(previous ?? {})]);
  const changed: string[] = [];
  for (const key of keys) {
    if (BOOKKEEPING_FIELDS.has(key)) continue;
    if (previous === undefined) {
      if (data[key] !== undefined) changed.push(key);
      continue;
    }
    if (sameValue(data[key], previous[key])) continue;
    changed.push(key);
  }
  return changed.sort();
}

const MAX_EVENT_VALUE_FIELDS = 20;
const MAX_EVENT_VALUE_LENGTH = 500;
const MAX_EVENT_VALUE_ITEMS = 10;

type EventScalar = string | number | boolean | null;
type EventValue = EventScalar | EventScalar[];

function eventScalar(value: unknown): EventScalar | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, MAX_EVENT_VALUE_LENGTH);
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function eventValue(value: unknown): EventValue | undefined {
  const scalar = eventScalar(value);
  if (scalar !== undefined) return scalar;
  if (!Array.isArray(value)) return undefined;
  const items: EventScalar[] = [];
  for (const item of value.slice(0, MAX_EVENT_VALUE_ITEMS)) {
    const converted = eventScalar(item);
    if (converted === undefined) return undefined;
    items.push(converted);
  }
  return items;
}

/**
 * 25.6 — build the bounded value snapshot carried by an entity event. Only changed fields are
 * included; nested objects are dropped so an outbox row can never become a full record dump.
 */
export function changedEventValues(
  data: Readonly<Record<string, unknown>>,
  previous?: Readonly<Record<string, unknown>>,
): EntityEventValues {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of changedFields(data, previous).slice(0, MAX_EVENT_VALUE_FIELDS)) {
    const previousScalar = eventValue(previous?.[key]);
    const currentScalar = eventValue(data[key]);
    if (previousScalar !== undefined) before[key] = previousScalar;
    if (currentScalar !== undefined) after[key] = currentScalar;
  }
  return { before, after };
}
