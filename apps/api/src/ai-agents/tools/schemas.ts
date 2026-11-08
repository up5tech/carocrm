/**
 * Tool argument schemas and catalogue constants, split out of `ai-agent-tools.ts` (19-AI.25).
 * Every schema is strict: a model may only send the documented arguments.
 */

import { z } from 'zod';

import { PERIOD_TOKEN_MAX_LENGTH } from '../ai-agent-periods.js';

/** Entities a read tool may address. Internal administration entities are deliberately absent. */
export const READABLE_ENTITIES = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'Case',
  'Task',
  'Project',
  'Campaign',
  'CustomerSuccessProfile',
  'Quote',
] as const;

/**
 * Entities a field update may address, with the fields it may change.
 *
 * Widened in `19-CHAT.22`. The rule is unchanged: a field is here only if changing it is
 * **reversible and domain-validated** by the Entity Engine. Nothing that deletes, merges, or moves
 * money is on this list — those belong to `high_impact` and need their own design.
 */
export const WRITABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Account: ['description'],
  Contact: ['description'],
  Lead: ['description', 'status', 'assignedUserId'],
  Opportunity: ['description', 'stage', 'amount', 'closeDate'],
  Case: ['description', 'status', 'priority', 'assignedUserId'],
  Task: ['description', 'status', 'dateEnd', 'assignedUserId'],
};

/**
 * Activities a calendar question may address (`19-CHAT.21`). Kept separate from
 * `READABLE_ENTITIES` so adding an activity to this tool does not silently widen what
 * `crm_search_records` may read.
 */
export const ACTIVITY_ENTITIES = ['Call', 'Meeting', 'Task'] as const;

/**
 * The record types an activity can be *about*. Activities declare `accounts` and `contacts` and
 * nothing else, so a question about "calls on this opportunity" is answered honestly as
 * unsupported rather than as an empty list.
 */
export const ACTIVITY_RECORD_ENTITIES = ['Account', 'Contact'] as const;

/** The `entity_links` relation an activity uses for each record type it can point at. */
export const ACTIVITY_RECORD_RELATION: Readonly<Record<string, string>> = {
  Account: 'accounts',
  Contact: 'contacts',
};

/**
 * The record types an email can name as its parent (`parentType`/`parentId`). Emails carry the
 * link directly, so no `entity_links` relation is consulted; kept separate from
 * `READABLE_ENTITIES` for the same reason as `ACTIVITY_ENTITIES`.
 */
export const EMAIL_RECORD_ENTITIES = ['Account', 'Contact', 'Lead', 'Opportunity', 'Case'] as const;

/** Query operators an aggregate filter may use: the Query Engine's set minus the exact matchers. */
export const AGGREGATE_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'isNull',
  'isNotNull',
  'in',
] as const;

/**
 * How many distinct groups one aggregate may scan before it stops.
 *
 * The store returns at most `maxGroups + 1` rows and orders by the group key, so asking it for the
 * top N by value is impossible in one query. Scanning a bounded set and sorting here is the honest
 * compromise: correct top-N up to this many groups (stages, owners, countries, statuses all fit),
 * and an explicit `truncated` flag beyond it.
 */
export const AGGREGATE_GROUP_SCAN = 100;

export const SearchCriterionSchema = z
  .object({
    field: z.string().trim().min(1).max(80),
    operator: z
      .enum(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'isNull', 'isNotNull'])
      .default('equals'),
    value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

export const SearchArgumentsSchema = z
  .object({
    entity: z.enum(READABLE_ENTITIES),
    criteria: z.array(SearchCriterionSchema).max(6).default([]),
    fields: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    orderBy: z.string().trim().max(80).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    maxSize: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const ReadArgumentsSchema = z
  .object({
    entity: z.enum(READABLE_ENTITIES),
    id: z.string().trim().min(1).max(120),
    fields: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  })
  .strict();

export const RelatedArgumentsSchema = z
  .object({
    entity: z.enum(READABLE_ENTITIES),
    id: z.string().trim().min(1).max(120),
    relation: z.string().trim().min(1).max(80),
    maxSize: z.number().int().min(1).max(25).default(10),
  })
  .strict();

/** `DocsService` slices a longer query itself; the schema states the real bound so the model is told. */
export const DocsSearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(2).max(120),
    maxSize: z.number().int().min(1).max(5).default(3),
  })
  .strict();

/** A documentation page key is `section/slug`, the same key the `/docs` route uses. */
export const DocsReadArgumentsSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/, 'Expected a documentation page key such as "admin/crm-chat".'),
  })
  .strict();

export const CreateTaskArgumentsSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().trim().max(4_000).optional(),
    /** ISO date or date-time; the Entity Engine validates it against the field type. */
    dateStart: z.string().trim().max(40).optional(),
    assignedUserId: z.string().trim().min(1).max(120).optional(),
    /** The record this task is about, so it appears on that record's timeline (`19-CHAT.22`). */
    parent: z
      .object({
        entity: z.enum(READABLE_ENTITIES),
        id: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The record types a note, call or email can be attached to. */
export const RELATED_TARGETS = ['Account', 'Contact', 'Lead', 'Opportunity', 'Case'] as const;

export const RelatedSchema = z
  .object({
    entity: z.enum(RELATED_TARGETS),
    id: z.string().trim().min(1).max(120),
  })
  .strict();

export const PostNoteArgumentsSchema = z
  .object({
    entity: z.enum(READABLE_ENTITIES),
    id: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const LogActivityArgumentsSchema = z
  .object({
    kind: z.enum(['Call', 'Meeting']),
    name: z.string().trim().min(1).max(255),
    /** When it happened. ISO date-time; the Entity Engine validates the type. */
    dateStart: z.string().trim().min(1).max(40),
    durationMinutes: z.number().int().min(1).max(1_440).optional(),
    /** What came of it — the reason the record exists. */
    outcome: z.string().trim().max(4_000).optional(),
    related: RelatedSchema.optional(),
    assignedUserId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const DraftEmailArgumentsSchema = z
  .object({
    subject: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(8_000),
    /** Recipients; the Email entity validates each address. */
    to: z.array(z.string().trim().min(3).max(320)).max(5).optional(),
    related: RelatedSchema.optional(),
    templateId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const UpdateFieldsArgumentsSchema = z
  .object({
    entity: z.enum(['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Task']),
    id: z.string().trim().min(1).max(120),
    fields: z.record(z.string().max(80), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export const jsonSchemaString = (maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength });

/** A filter criterion the aggregate tool accepts; a subset of the Query Engine's grammar. */
export const AggregateCriterionSchema = z
  .object({
    field: z.string().trim().min(1).max(80),
    operator: z.enum(AGGREGATE_OPERATORS).default('equals'),
    value: z
      .union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(200), z.number()])).max(50)])
      .optional(),
  })
  .strict();

export const AggregateArgumentsSchema = z
  .object({
    entity: z.enum(READABLE_ENTITIES),
    metric: z.enum(['count', 'sum', 'avg', 'min', 'max']),
    /** Required for every metric except `count`. */
    field: z.string().trim().min(1).max(80).optional(),
    /** One grouping dimension; the group count returned is capped by `maxGroups`. */
    groupBy: z.string().trim().min(1).max(80).optional(),
    criteria: z.array(AggregateCriterionSchema).max(6).default([]),
    /** The date field the period applies to. Required as soon as a period or a bound is given. */
    dateField: z.string().trim().min(1).max(80).optional(),
    /** A closed token: `this_quarter`, `last_month`, `rolling:30d`, … — never a date. */
    period: z.string().trim().min(1).max(PERIOD_TOKEN_MAX_LENGTH).optional(),
    from: z.string().trim().min(1).max(40).optional(),
    to: z.string().trim().min(1).max(40).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    maxGroups: z.number().int().min(1).max(10).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.metric !== 'count' && value.field === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['field'],
        message: `metric "${value.metric}" needs a numeric field to aggregate`,
      });
    }
    const hasWindow = value.period !== undefined || value.from !== undefined || value.to !== undefined;
    if (hasWindow && value.dateField === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateField'],
        message: 'a period or date bound needs the date field it applies to (for example "closeDate")',
      });
    }
  });

export const ListActivitiesArgumentsSchema = z
  .object({
    kind: z.enum(ACTIVITY_ENTITIES),
    scope: z.enum(['mine', 'record']).default('mine'),
    record: z
      .object({
        entity: z.enum(ACTIVITY_RECORD_ENTITIES),
        id: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
    /** A closed token; `dateStart` is filtered to the resolved range. */
    period: z.string().trim().min(1).max(PERIOD_TOKEN_MAX_LENGTH).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
    maxSize: z.number().int().min(1).max(25).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'record' && value.record === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['record'],
        message: 'scope "record" needs { entity, id }',
      });
    }
  });

export const ListEmailsArgumentsSchema = z
  .object({
    scope: z.enum(['mine', 'record']).default('mine'),
    record: z
      .object({
        entity: z.enum(EMAIL_RECORD_ENTITIES),
        id: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
    /** A closed token; `dateSent` is filtered to the resolved range. */
    period: z.string().trim().min(1).max(PERIOD_TOKEN_MAX_LENGTH).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    maxSize: z.number().int().min(1).max(25).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'record' && value.record === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['record'],
        message: 'scope "record" needs { entity, id }',
      });
    }
  });

/** `crm_actor_context` takes no arguments at all; the actor is the run's initiator. */
export const NoArgumentsSchema = z.object({}).strict();

/**
 * The `result_ref` namespace a handbook page citation is stored under. It is not an entity name, which is
 * why `AIAgentMemoryService` and `CRMChatCitationService` both special-case it instead of reading a record.
 */
export const HELP_DOCUMENT_REF_KIND = 'help_document';
