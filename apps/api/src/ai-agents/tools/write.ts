/**
 * Write-side tool handlers — notes, activities, email drafts, tasks, field updates (19-AI.25).
 */

import { ValidationError } from '@carocrm/core/errors/index.js';

import { type AIToolContext, type AIToolProposal, type AIToolResult } from '../ai-agent-tools.js';
import { displayName } from './helpers.js';
import { AIToolReadHandlers } from './read.js';
import { CreateTaskArgumentsSchema, DraftEmailArgumentsSchema, LogActivityArgumentsSchema, PostNoteArgumentsSchema, UpdateFieldsArgumentsSchema,WRITABLE_FIELDS } from './schemas.js';

export class AIToolWriteHandlers extends AIToolReadHandlers {
  /**
   * `crm_post_note` — the most common AI-CRM action: recording what a call concluded.
   *
   * The note is written by `StreamService`, not by an insert of our own, so the parent's `stream`
   * ACL action is enforced, mentions resolve, followers are notified and the audit trail is the same
   * one a human note produces. The author is the run's actor, and the idempotency key means a retried
   * step cannot post the same note twice.
   */
  protected async previewPostNote(raw: unknown): Promise<AIToolProposal> {
    const args = PostNoteArgumentsSchema.parse(raw);
    return {
      summary: `Post a note on ${args.entity} ${args.id}.`,
      targets: [{ type: args.entity, id: args.id }],
      detail: { text: args.text },
    };
  }

  protected async postNote(raw: unknown, context: AIToolContext): Promise<AIToolResult> {
    const args = PostNoteArgumentsSchema.parse(raw);
    this.assertReadableEntity(args.entity);
    // Read the parent first: it turns "not yours" into a 404 the model can report, before any write.
    const record = await this.entities.get(args.entity, args.id);
    const item = await this.stream.create(args.entity, args.id, {
      type: 'Post',
      post: args.text,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      summary: `Posted a note on ${args.entity} "${displayName(record)}".`,
      result: {
        entity: args.entity,
        id: args.id,
        name: displayName(record),
        streamItemId: item.id,
        createdAt: item.createdAt,
        idempotencyKey: context.idempotencyKey,
      },
      resultRef: `${args.entity}:${args.id}`,
    };
  }

  /**
   * `crm_log_activity` — history, not scheduling.
   *
   * The record is created with `status: 'Held'` and, when a related record is given, linked through
   * the activity's own `accounts` / `contacts` relation. Nothing is sent to the customer: a Call or
   * Meeting record is internal evidence that the conversation happened.
   */
  protected async previewLogActivity(raw: unknown): Promise<AIToolProposal> {
    const args = LogActivityArgumentsSchema.parse(raw);
    return {
      summary: `Log the ${args.kind.toLowerCase()} "${args.name}".`,
      targets: [
        { type: args.kind, id: 'new', label: args.name },
        ...(args.related === undefined ? [] : [{ type: args.related.entity, id: args.related.id }]),
      ],
      detail: {
        kind: args.kind,
        name: args.name,
        dateStart: args.dateStart,
        durationMinutes: args.durationMinutes ?? null,
        outcome: args.outcome ?? null,
        related: args.related ?? null,
      },
    };
  }

  protected async logActivity(raw: unknown, context: AIToolContext): Promise<AIToolResult> {
    const args = LogActivityArgumentsSchema.parse(raw);
    this.assertActivityEntity(args.kind);
    const created = await this.entities.create(args.kind, {
      name: args.name,
      status: 'Held',
      dateStart: args.dateStart,
      ...(args.durationMinutes === undefined ? {} : { duration: args.durationMinutes }),
      ...(args.outcome === undefined ? {} : { description: args.outcome }),
      ...(args.assignedUserId === undefined ? { assignedUserId: context.actorUserId } : { assignedUserId: args.assignedUserId }),
    });
    const id = String(created['id'] ?? '');
    if (id === '') throw new Error(`The created ${args.kind} has no identifier.`);
    const related = args.related === undefined ? undefined : await this.linkRelated(args.kind, id, args.related);
    return {
      summary: `Logged the ${args.kind.toLowerCase()} "${args.name}"${related === undefined ? '' : ` on ${related.entity} ${related.id}`}.`,
      result: {
        entity: args.kind,
        id,
        name: args.name,
        status: 'Held',
        dateStart: args.dateStart,
        related: related ?? null,
        idempotencyKey: context.idempotencyKey,
      },
      resultRef: `${args.kind}:${id}`,
    };
  }

  /**
   * `crm_draft_email` — a draft, and only a draft.
   *
   * Two independent guards keep it from becoming a send: the record is created with
   * `status: 'Draft'`, and this tool never calls `EmailService.queueSend`, which itself refuses any
   * status outside `Draft`/`Failed`. The user opens the record and sends it under their own
   * authorisation.
   */
  protected async previewDraftEmail(raw: unknown): Promise<AIToolProposal> {
    const args = DraftEmailArgumentsSchema.parse(raw);
    return {
      summary: `Draft the email "${args.subject}".`,
      targets: [
        { type: 'Email', id: 'new', label: args.subject },
        ...(args.related === undefined ? [] : [{ type: args.related.entity, id: args.related.id }]),
      ],
      detail: {
        subject: args.subject,
        to: args.to ?? [],
        body: args.body,
        related: args.related ?? null,
        sends: false,
      },
    };
  }

  protected async draftEmail(raw: unknown, context: AIToolContext): Promise<AIToolResult> {
    const args = DraftEmailArgumentsSchema.parse(raw);
    if (!this.metadata.registry.hasEntity('Email')) {
      throw new ValidationError('Email is not installed in this deployment.');
    }
    const created = await this.entities.create('Email', {
      // The record's display name is the subject (Email metadata).
      name: args.subject,
      status: 'Draft',
      direction: 'Outbound',
      body: args.body,
      ...(args.to === undefined ? {} : { toAddressList: args.to.join(', ') }),
      ...(args.templateId === undefined ? {} : { templateId: args.templateId }),
      ...(args.related === undefined ? {} : { parentType: args.related.entity, parentId: args.related.id }),
    });
    const id = String(created['id'] ?? '');
    if (id === '') throw new Error('The created email has no identifier.');
    const related = args.related === undefined ? undefined : await this.linkRelated('Email', id, args.related);
    return {
      summary: `Drafted the email "${args.subject}" — not sent.`,
      result: {
        entity: 'Email',
        id,
        subject: args.subject,
        status: 'Draft',
        to: args.to ?? [],
        related: related ?? null,
        sent: false,
        note: 'This is a draft. The user must open it and send it; the assistant did not send anything.',
        idempotencyKey: context.idempotencyKey,
      },
      resultRef: `Email:${id}`,
    };
  }

  protected async previewCreateTask(raw: unknown): Promise<AIToolProposal> {
    const args = CreateTaskArgumentsSchema.parse(raw);
    return {
      summary: `Create the internal task "${args.name}".`,
      targets: [
        { type: 'Task', id: 'new', label: args.name },
        ...(args.parent === undefined ? [] : [{ type: args.parent.entity, id: args.parent.id }]),
      ],
      detail: {
        name: args.name,
        description: args.description ?? null,
        dateStart: args.dateStart ?? null,
        assignedUserId: args.assignedUserId ?? null,
        parent: args.parent ?? null,
      },
    };
  }

  protected async createTask(raw: unknown, context: AIToolContext): Promise<AIToolResult> {
    const args = CreateTaskArgumentsSchema.parse(raw);
    const created = await this.entities.create('Task', {
      name: args.name,
      // A task with no owner is a task nobody does; default to the person who asked.
      assignedUserId: args.assignedUserId ?? context.actorUserId,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.dateStart === undefined ? {} : { dateStart: args.dateStart }),
    });
    const id = String(created['id'] ?? '');
    if (id === '') throw new Error('The created task has no identifier.');
    const parent = args.parent === undefined ? undefined : await this.linkRelated('Task', id, args.parent);
    return {
      summary: `Created the internal task "${args.name}"${parent === undefined ? '' : ` on ${parent.entity} ${parent.id}`}.`,
      result: {
        entity: 'Task',
        id,
        name: args.name,
        assignedUserId: args.assignedUserId ?? context.actorUserId,
        parent: parent ?? null,
        idempotencyKey: context.idempotencyKey,
      },
      resultRef: `Task:${id}`,
    };
  }

  /**
   * Link a newly created record to the record it is about.
   *
   * The relation name is read from metadata (the one whose target is the related entity), so this
   * works for an activity's `accounts`/`contacts`, an email's `leads`, and a task on any declared
   * relation. `entities.link()` writes the `entity_links` row and syncs the attribute link, which is
   * exactly what the related panel and the reverse lookup read.
   */
  private async linkRelated(
    from: string,
    fromId: string,
    related: { entity: string; id: string },
  ): Promise<{ entity: string; id: string; relation: string }> {
    const relation = this.relationTo(from, related.entity);
    if (relation === undefined) {
      throw new ValidationError(
        `A ${from} cannot be linked to a ${related.entity} in this deployment.`,
        { entity: from, relatedEntity: related.entity, supported: this.linkableTargets(from) },
      );
    }
    await this.entities.link(from, fromId, relation, related.id);
    return { entity: related.entity, id: related.id, relation };
  }

  /** The relation on `entity` that points at `target`, if the metadata declares one. */
  private relationTo(entity: string, target: string): string | undefined {
    const relations = this.metadata.registry.getRelations(entity);
    for (const [name, relation] of Object.entries(relations)) {
      if (relation.target === target && (relation.type === 'manyMany' || relation.type === 'oneToMany')) {
        return name;
      }
    }
    return undefined;
  }

  /** Targets a record of `entity` can be attached to — listed so the model can retry usefully. */
  private linkableTargets(entity: string): string[] {
    const relations = this.metadata.registry.getRelations(entity);
    const out = new Set<string>();
    for (const relation of Object.values(relations)) {
      if (relation.type !== 'manyMany' && relation.type !== 'oneToMany') continue;
      if (relation.target !== undefined) out.add(relation.target);
    }
    return [...out].sort();
  }

  protected async previewUpdateFields(raw: unknown, context: AIToolContext): Promise<AIToolProposal> {
    const args = UpdateFieldsArgumentsSchema.parse(raw);
    const allowed = WRITABLE_FIELDS[args.entity] ?? [];
    const changes = Object.entries(args.fields);
    if (changes.length === 0) throw new ValidationError('A field update must change at least one field.');
    for (const [field] of changes) {
      if (!allowed.includes(field)) {
        throw new ValidationError(`Field "${field}" cannot be changed on "${args.entity}" by an agent.`, {
          allowedFields: allowed,
        });
      }
      this.assertField(args.entity, field);
    }
    const current = await this.entities.get(
      args.entity,
      args.id,
      [...changes.map(([field]) => field), 'version'].join(','),
    );
    // The proposal the human approved was about a version. Refuse rather than silently apply the
    // same field write to a record that moved underneath the preview (Phase 22.19, plan §18 task 4).
    const expected = context.expectedTargetVersions?.[`${args.entity}:${args.id}`];
    if (expected !== undefined && expected !== Number(current['version'])) {
      throw new ValidationError(
        `The record changed after the proposal was shown (version ${String(expected)} → ${String(current['version'])}); ask the assistant again.`,
      );
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [field, value] of changes) {
      before[field] = current[field] ?? null;
      after[field] = value;
    }
    return {
      summary: `Update ${String(changes.length)} field(s) on ${args.entity} "${displayName(current)}".`,
      targets: [{
        type: args.entity,
        id: args.id,
        label: displayName(current),
        ...(Number.isFinite(Number(current['version'])) ? { version: Number(current['version']) } : {}),
      }],
      detail: { before, after },
    };
  }

  protected async updateFields(raw: unknown, context: AIToolContext): Promise<AIToolResult> {
    const args = UpdateFieldsArgumentsSchema.parse(raw);
    const allowed = WRITABLE_FIELDS[args.entity] ?? [];
    for (const field of Object.keys(args.fields)) {
      if (!allowed.includes(field)) {
        throw new ValidationError(`Field "${field}" cannot be changed on "${args.entity}" by an agent.`);
      }
      this.assertField(args.entity, field);
    }
    // The update itself carries the approved version, so a write that lands between approval and
    // execution loses cleanly instead of overwriting the newer state.
    const expected = context.expectedTargetVersions?.[`${args.entity}:${args.id}`];
    const updated = await this.entities.update(
      args.entity,
      args.id,
      expected === undefined ? args.fields : { ...args.fields, version: expected },
    );
    return {
      summary: `Updated ${args.entity} "${displayName(updated)}".`,
      result: {
        entity: args.entity,
        id: args.id,
        name: displayName(updated),
        changedFields: Object.keys(args.fields),
        idempotencyKey: context.idempotencyKey,
      },
      resultRef: `${args.entity}:${args.id}`,
    };
  }
}
