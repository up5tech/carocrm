/**
 * Phase 19-AI.6 — the server-side tool registry
 * (plans/PLAN_Phase_19_AI_Agents.md §7.1–§7.5, §20 `19-AI.6`, `19-AI.10`).
 *
 * Tools are registered by trusted application code only. A model selects a **key** and supplies
 * **arguments**; it can never name a handler, a URL, a table, SQL or a permission rule. Every
 * definition carries its own strict input schema, effect class and result cap, and the handler runs
 * through the normal Entity Engine — so record ACL, field permissions, validation, audit and domain
 * hooks apply exactly as they do for a human request.
 *
 * The catalogue starts deliberately small: four CRM read tools, two product-documentation read tools and
 * two low-risk writes. There is no
 * arbitrary-code, raw-SQL, shell or unrestricted-HTTP tool, and none may be added here without a
 * separate reviewed sandbox design (§7.4).
 *
 * 19-AI.25 — handlers live under `tools/` (schemas, shared helpers, base, read, write); this file
 * keeps the public types, the catalogue registrations and the `AIToolRegistry` facade.
 */

import { ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { DocsService } from '../docs/docs.service.js';
import type { EntityCrudService } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { StreamService } from '../stream/stream.service.js';
import { AIAgentActorDirectoryService } from './ai-agent-directory.service.js';
import { PERIOD_TOKEN_MAX_LENGTH } from './ai-agent-periods.js';
import type { EffectClass } from './ai-agents-module.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { ACTIVITY_ENTITIES, ACTIVITY_RECORD_ENTITIES, AGGREGATE_OPERATORS, AggregateArgumentsSchema, CreateTaskArgumentsSchema, DocsReadArgumentsSchema, DocsSearchArgumentsSchema, DraftEmailArgumentsSchema, EMAIL_RECORD_ENTITIES, jsonSchemaString, ListActivitiesArgumentsSchema, ListEmailsArgumentsSchema, LogActivityArgumentsSchema, NoArgumentsSchema,PostNoteArgumentsSchema, READABLE_ENTITIES, ReadArgumentsSchema, RELATED_TARGETS, RelatedArgumentsSchema, SearchArgumentsSchema, UpdateFieldsArgumentsSchema, WRITABLE_FIELDS } from './tools/schemas.js';
import { AIToolWriteHandlers } from './tools/write.js';

export interface AIToolContext {
  readonly runId: string;
  readonly step: number;
  /** The human who started the run; the tool executes inside their request scope. */
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  /**
   * Targeted records' versions at proposal time, keyed `Entity:id`. Present when an approved action
   * is revalidated or executed: the proposal the human saw is about that version, not whatever the
   * record looks like now.
   */
  readonly expectedTargetVersions?: Readonly<Record<string, number>> | undefined;
}

export interface AIToolPreviewTarget {
  readonly type: string;
  readonly id: string;
  readonly label?: string | undefined;
  /** The record's version when the proposal was built, when the tool can capture it. */
  readonly version?: number | undefined;
}

/** The `Entity:id` version map a revalidation context expects from an approval's targets. */
export function expectedTargetVersionsOf(targets: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(targets)) return out;
  for (const raw of targets) {
    if (raw === null || typeof raw !== 'object') continue;
    const target = raw as Record<string, unknown>;
    if (typeof target['type'] !== 'string' || typeof target['id'] !== 'string') continue;
    if (typeof target['version'] !== 'number' || !Number.isFinite(target['version'])) continue;
    out[`${target['type']}:${target['id']}`] = target['version'];
  }
  return out;
}

export interface AIToolProposal {
  readonly summary: string;
  readonly targets: readonly AIToolPreviewTarget[];
  /** Typed, redaction-safe preview of what will change; stored on the approval. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface AIToolResult {
  readonly summary: string;
  readonly result: unknown;
  readonly resultRef?: string | undefined;
}

export interface AIToolDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly version: string;
  readonly owningModule: string;
  readonly effectClass: EffectClass;
  readonly requiresApproval: boolean;
  /** Entities the tool can touch; empty means it touches none. */
  readonly entityScopes: readonly string[];
  readonly inputSchema: z.ZodTypeAny;
  /** JSON Schema handed to the provider. Hand-written so the model never sees a Zod internal. */
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  readonly maxResultBytes: number;
  readonly timeoutMs: number;
  /** Proposal shown to a human when approval is required (§9.3). */
  readonly preview?: (args: unknown, context: AIToolContext) => Promise<AIToolProposal>;
  readonly execute: (args: unknown, context: AIToolContext) => Promise<AIToolResult>;
}

export interface AIToolIssue {
  readonly key: string;
  readonly message: string;
}


@Injectable()
export class AIToolRegistry extends AIToolWriteHandlers {
  private readonly definitions = new Map<string, AIToolDefinition>();

  constructor(
    @Inject(EntityService) entities: EntityCrudService,
    @Inject(METADATA_STORE) metadata: MetadataStoreService,
    @Inject(AIAgentsSettingsService) settings: AIAgentsSettingsService,
    @Inject(DocsService) docs: DocsService,
    @Inject(AIAgentActorDirectoryService) actors: AIAgentActorDirectoryService,
    @Inject(StreamService) stream: StreamService,
  ) {
    super(entities, metadata, settings, docs, actors, stream);
    this.register({
      key: 'crm_search_records',
      label: 'Search CRM records',
      description:
        'Search one allowlisted CRM entity. Returns at most 25 records the calling user may read. Use it to find a record by name or a simple field condition.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: SearchArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          criteria: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field'],
              properties: {
                field: jsonSchemaString(80),
                operator: {
                  type: 'string',
                  enum: ['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'isNull', 'isNotNull'],
                },
                value: { type: ['string', 'number', 'boolean', 'null'] },
              },
            },
          },
          fields: { type: 'array', maxItems: 20, items: jsonSchemaString(80) },
          orderBy: jsonSchemaString(80),
          order: { type: 'string', enum: ['asc', 'desc'] },
          maxSize: { type: 'integer', minimum: 1, maximum: 25 },
        },
      },
      maxResultBytes: 32_768,
      timeoutMs: 10_000,
      execute: (args) => this.search(args),
    });
    this.register({
      key: 'crm_read_record',
      label: 'Read a CRM record',
      description:
        'Read one allowlisted CRM record by id. Only fields the calling user may read are returned; restricted fields are removed server-side.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: ReadArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'id'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          id: jsonSchemaString(120),
          fields: { type: 'array', maxItems: 20, items: jsonSchemaString(80) },
        },
      },
      maxResultBytes: 24_576,
      timeoutMs: 10_000,
      execute: (args) => this.readRecord(args),
    });
    this.register({
      key: 'crm_list_related',
      label: 'List related records',
      description:
        'List records related to one authorized CRM record through a declared metadata relation. At most 25 related records are returned.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: RelatedArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'id', 'relation'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          id: jsonSchemaString(120),
          relation: jsonSchemaString(80),
          maxSize: { type: 'integer', minimum: 1, maximum: 25 },
        },
      },
      maxResultBytes: 32_768,
      timeoutMs: 10_000,
      execute: (args) => this.listRelated(args),
    });
    this.register({
      key: 'crm_record_summary',
      label: 'Summarize a CRM record',
      description:
        'Read a bounded, field-permission-filtered summary of one CRM record: its name, a short description and a handful of key detail fields.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: ReadArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'id'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          id: jsonSchemaString(120),
          fields: { type: 'array', maxItems: 20, items: jsonSchemaString(80) },
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 10_000,
      execute: (args) => this.recordSummary(args),
    });
    this.register({
      key: 'crm_actor_context',
      label: 'Read the acting user\'s context',
      description:
        'Who the assistant is acting for: the user id, name, locale, time zone and teams, plus today\'s date in that zone. Use it before any question about "my", "our" or "today", and to quote the date an answer is as of. It returns the caller\'s own details only.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [],
      inputSchema: NoArgumentsSchema,
      inputJsonSchema: { type: 'object', additionalProperties: false, properties: {} },
      maxResultBytes: 4_096,
      timeoutMs: 5_000,
      execute: (_args, context) => this.actorContext(context),
    });
    this.register({
      key: 'crm_aggregate',
      label: 'Aggregate CRM records',
      description:
        'Count, sum, average, minimum or maximum over one allowlisted entity, optionally grouped by one field and limited to a period such as "this_quarter" or "rolling:30d". Use it for every "how many", "total value", "by stage" or "per owner" question: the number comes from SQL over the records this user may read, so never add up records returned by crm_search_records yourself.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: AggregateArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'metric'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          metric: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
          field: jsonSchemaString(80),
          groupBy: jsonSchemaString(80),
          criteria: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field'],
              properties: {
                field: jsonSchemaString(80),
                operator: { type: 'string', enum: [...AGGREGATE_OPERATORS] },
                value: { type: ['string', 'number', 'boolean', 'null', 'array'] },
              },
            },
          },
          dateField: jsonSchemaString(80),
          period: {
            type: 'string',
            maxLength: PERIOD_TOKEN_MAX_LENGTH,
            description: 'this_quarter | last_quarter | this_month | last_month | this_week | last_week | next_week | this_year | last_year | today | yesterday | rolling:30d',
          },
          from: jsonSchemaString(40),
          to: jsonSchemaString(40),
          order: { type: 'string', enum: ['asc', 'desc'] },
          maxGroups: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 10_000,
      execute: (args, context) => this.aggregate(args, context),
    });
    this.register({
      key: 'crm_list_activities',
      label: 'List activities',
      description:
        'List Calls, Meetings or Tasks for the acting user ("what do I have today") or for one Account or Contact. Optionally limited to a period. Use it before answering any question about someone\'s schedule, and use crm_read_record for the detail of one activity.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [...ACTIVITY_ENTITIES],
      inputSchema: ListActivitiesArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: [...ACTIVITY_ENTITIES] },
          scope: { type: 'string', enum: ['mine', 'record'] },
          record: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'id'],
            properties: {
              entity: { type: 'string', enum: [...ACTIVITY_RECORD_ENTITIES] },
              id: jsonSchemaString(120),
            },
          },
          period: {
            type: 'string',
            maxLength: PERIOD_TOKEN_MAX_LENGTH,
            description: 'this_week | next_week | today | this_month | rolling:7d | …',
          },
          status: jsonSchemaString(40),
          order: { type: 'string', enum: ['asc', 'desc'] },
          maxSize: { type: 'integer', minimum: 1, maximum: 25 },
        },
      },
      maxResultBytes: 24_576,
      timeoutMs: 10_000,
      execute: (args, context) => this.listActivities(args, context),
    });
    this.register({
      key: 'crm_list_emails',
      label: 'List emails',
      description:
        'List emails (metadata only: subject, direction, addresses, date, status) for the acting user or for one Account/Contact/Lead/Opportunity/Case. Never returns bodies. Use it to answer "which emails went out to this customer" or "what did we send about account X".',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: ['Email'],
      inputSchema: ListEmailsArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['mine', 'record'] },
          record: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'id'],
            properties: {
              entity: { type: 'string', enum: [...EMAIL_RECORD_ENTITIES] },
              id: jsonSchemaString(120),
            },
          },
          period: {
            type: 'string',
            maxLength: PERIOD_TOKEN_MAX_LENGTH,
            description: 'this_week | last_week | yesterday | this_month | rolling:30d | …',
          },
          status: jsonSchemaString(40),
          order: { type: 'string', enum: ['asc', 'desc'] },
          maxSize: { type: 'integer', minimum: 1, maximum: 25 },
        },
      },
      maxResultBytes: 24_576,
      timeoutMs: 10_000,
      execute: (args, context) => this.listEmails(args, context),
    });
    this.register({
      key: 'docs_search',
      label: 'Search product documentation',
      description:
        'Search the in-app product handbook for questions about using this CRM ("how do I ...", "where do I find ..."). Returns up to 5 page keys, titles and short excerpts, already filtered to the pages this user is allowed to read. Read the page you intend to cite with docs_read_page.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [],
      inputSchema: DocsSearchArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: jsonSchemaString(120),
          maxSize: { type: 'integer', minimum: 1, maximum: 5 },
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 5_000,
      execute: (args) => this.docsSearch(args),
    });
    this.register({
      key: 'docs_read_page',
      label: 'Read a documentation page',
      description:
        'Read one product-handbook page by key (for example "admin/crm-chat"), as returned by docs_search. A page the user may not read returns no content and produces no citation.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'read',
      requiresApproval: false,
      entityScopes: [],
      inputSchema: DocsReadArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: {
          key: jsonSchemaString(120),
        },
      },
      maxResultBytes: 16_384,
      timeoutMs: 5_000,
      execute: (args) => this.docsReadPage(args),
    });
    this.register({
      key: 'crm_post_note',
      label: 'Post a note on a record',
      description:
        'Add a note to one authorized CRM record, visible on that record\'s timeline. Use it to record the outcome of a call or a decision the user just described. The note is attributed to the acting user.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'low_write',
      requiresApproval: false,
      entityScopes: READABLE_ENTITIES,
      inputSchema: PostNoteArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'id', 'text'],
        properties: {
          entity: { type: 'string', enum: [...READABLE_ENTITIES] },
          id: jsonSchemaString(120),
          text: jsonSchemaString(4_000),
        },
      },
      maxResultBytes: 4_096,
      timeoutMs: 10_000,
      preview: (args) => this.previewPostNote(args),
      execute: (args, context) => this.postNote(args, context),
    });
    this.register({
      key: 'crm_log_activity',
      label: 'Log a call or meeting',
      description:
        'Record a Call or Meeting that already happened, optionally linked to the Account or Contact it concerned. It records history: it sends nothing to the customer and schedules nothing.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'low_write',
      requiresApproval: false,
      entityScopes: ['Call', 'Meeting'],
      inputSchema: LogActivityArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'name', 'dateStart'],
        properties: {
          kind: { type: 'string', enum: ['Call', 'Meeting'] },
          name: jsonSchemaString(255),
          dateStart: jsonSchemaString(40),
          durationMinutes: { type: 'integer', minimum: 1, maximum: 1_440 },
          outcome: jsonSchemaString(4_000),
          related: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'id'],
            properties: {
              entity: { type: 'string', enum: [...RELATED_TARGETS] },
              id: jsonSchemaString(120),
            },
          },
          assignedUserId: jsonSchemaString(120),
        },
      },
      maxResultBytes: 8_192,
      timeoutMs: 10_000,
      preview: (args) => this.previewLogActivity(args),
      execute: (args, context) => this.logActivity(args, context),
    });
    this.register({
      key: 'crm_draft_email',
      label: 'Draft an email',
      description:
        'Create an email **draft** on a record. It is never sent: the user reviews and sends it from the record. Use it when asked to write a follow-up; do not claim the email was sent.',
      version: '1',
      owningModule: 'AIAgents',
      effectClass: 'low_write',
      requiresApproval: false,
      entityScopes: ['Email'],
      inputSchema: DraftEmailArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'body'],
        properties: {
          subject: jsonSchemaString(255),
          body: jsonSchemaString(8_000),
          to: { type: 'array', maxItems: 5, items: jsonSchemaString(320) },
          related: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'id'],
            properties: {
              entity: { type: 'string', enum: [...RELATED_TARGETS] },
              id: jsonSchemaString(120),
            },
          },
          templateId: jsonSchemaString(64),
        },
      },
      maxResultBytes: 4_096,
      timeoutMs: 10_000,
      preview: (args) => this.previewDraftEmail(args),
      execute: (args, context) => this.draftEmail(args, context),
    });
    this.register({
      key: 'crm_create_task',
      label: 'Create an internal task',
      description:
        'Create a Task assigned within the calling user\'s ACL scope, optionally attached to the record it is about so it appears on that record\'s timeline. The task is internal CRM work; it sends nothing to a customer.',
      version: '2',
      owningModule: 'AIAgents',
      effectClass: 'low_write',
      requiresApproval: false,
      entityScopes: ['Task'],
      inputSchema: CreateTaskArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: jsonSchemaString(255),
          description: jsonSchemaString(4_000),
          dateStart: jsonSchemaString(40),
          assignedUserId: jsonSchemaString(120),
          parent: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'id'],
            properties: {
              entity: { type: 'string', enum: [...READABLE_ENTITIES] },
              id: jsonSchemaString(120),
            },
          },
        },
      },
      maxResultBytes: 8_192,
      timeoutMs: 10_000,
      preview: (args) => this.previewCreateTask(args),
      execute: (args, context) => this.createTask(args, context),
    });
    this.register({
      key: 'crm_update_record_fields',
      label: 'Propose a field update',
      description:
        'Change a small, allowlisted set of fields on one authorized CRM record: description, status, owner, priority, an opportunity\'s stage/amount/close date, a task\'s due date. This is a material write and requires human approval.',
      version: '2',
      owningModule: 'AIAgents',
      effectClass: 'material_write',
      requiresApproval: true,
      entityScopes: Object.keys(WRITABLE_FIELDS),
      inputSchema: UpdateFieldsArgumentsSchema,
      inputJsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['entity', 'id', 'fields'],
        properties: {
          entity: { type: 'string', enum: Object.keys(WRITABLE_FIELDS) },
          id: jsonSchemaString(120),
          fields: {
            type: 'object',
            additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          },
        },
      },
      maxResultBytes: 8_192,
      timeoutMs: 10_000,
      preview: (args, context) => this.previewUpdateFields(args, context),
      execute: (args, context) => this.updateFields(args, context),
    });
  }

  register(definition: AIToolDefinition): void {
    if (this.definitions.has(definition.key)) {
      throw new Error(`AI tool "${definition.key}" is already registered.`);
    }
    this.definitions.set(definition.key, definition);
  }

  get(key: string): AIToolDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw new ValidationError(`Unknown AI tool "${key}".`, { tool: key });
    return definition;
  }

  has(key: string): boolean {
    return this.definitions.has(key);
  }

  list(): readonly AIToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Whether an administrator has left the tool switched on (§7.1 `enabled`). */
  async isEnabled(key: string): Promise<boolean> {
    const settings = await this.settings.settings();
    return !settings.tools.disabled.includes(key);
  }

  /** Every reason a tool grant cannot be published, empty when it is valid. */
  async validateGrant(key: string, requiresApproval: boolean): Promise<AIToolIssue[]> {
    const issues: AIToolIssue[] = [];
    const definition = this.definitions.get(key);
    if (!definition) return [{ key, message: `Tool "${key}" is not registered.` }];
    if (!(await this.isEnabled(key))) issues.push({ key, message: `Tool "${key}" is disabled by an administrator.` });
    if (definition.requiresApproval && !requiresApproval) {
      issues.push({ key, message: `Tool "${key}" requires human approval and cannot be granted without it.` });
    }
    for (const entity of definition.entityScopes) {
      if (!this.metadata.registry.hasEntity(entity)) {
        issues.push({ key, message: `Tool "${key}" targets entity "${entity}", which is not registered.` });
      }
    }
    return issues;
  }

}

export const READ_TOOL_KEYS = [
  'crm_search_records',
  'crm_read_record',
  'crm_list_related',
  'crm_record_summary',
  'crm_actor_context',
  'crm_aggregate',
  'crm_list_activities',
] as const;


export { HELP_DOCUMENT_REF_KIND } from './tools/schemas.js';
