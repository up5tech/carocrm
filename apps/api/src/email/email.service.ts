/**
 * Outbound email (PLAN §28.1, §28.3).
 *
 * An email is a metadata entity record, so the kernel already enforces its ACL, audit and stream
 * rules and the SPA can list it like anything else. This service adds only what is not record
 * content: the transport's own recipient/From validation, the per-recipient `email_deliveries`
 * ledger, and the queueing of `system.sendEmail`. Nothing is sent from the API process — the worker
 * owns the network call, so a slow or broken SMTP server can never hold a request open.
 */
import { AuthorizationDeniedError, FeatureDisabledError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { InboundMailMessage, InboundMailProvider, MailMessage, MailTransport, MailTransportInfo } from '@carocrm/mail';
import { createAccountSmtpTransport, emailRecordToMessageInput, inboundToEmailRecord, renderTemplateParts } from '@carocrm/mail';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Selectable,sql } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import { AttachmentService } from '../attachment/attachment.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService, type EmailDeliveriesTable } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import {
  EMAIL_ENTITY,
  EMAIL_TEMPLATE_ENTITY,
  INBOUND_MAIL_PROVIDER_TOKEN,
  MAIL_TRANSPORT_TOKEN,
  SEND_EMAIL_JOB,
  SENDABLE_STATUSES,
} from './email.constants.js';
import { EmailAccountsService } from './email-accounts.service.js';
import { InboundConnectionsService } from './inbound-connections.service.js';

/** Per-connection poll bound (Phase 24.6): one run can never load a whole mailbox into memory. */
const INBOUND_POLL_MAX_MESSAGES = 50;
/** Global fetched cap per pollInbound call, across every connection. */
const INBOUND_POLL_GLOBAL_MAX = 500;

export interface EmailDeliveryView {
  id: string;
  emailId: string;
  recipient: string;
  recipientType: string;
  status: string;
  transport: string | null;
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  sentAt: string | null;
  createdAt: string;
  modifiedAt: string;
}

export interface QueuedEmail {
  email: Record<string, unknown>;
  deliveries: EmailDeliveryView[];
  transport: MailTransportInfo;
  /** The §24 job row that carries this send, so an admin can watch or cancel it. */
  job: { id: string; name: string; status: string };
}

type DeliveryRow = Selectable<EmailDeliveriesTable>;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDeliveryView(row: DeliveryRow): EmailDeliveryView {
  return {
    id: row.id,
    emailId: row.email_id,
    recipient: row.recipient,
    recipientType: row.recipient_type,
    status: row.status,
    transport: row.transport,
    providerMessageId: row.provider_message_id,
    error: row.error,
    attempts: row.attempts,
    sentAt: toIso(row.sent_at),
    createdAt: toIso(row.created_at) ?? '',
    modifiedAt: toIso(row.modified_at) ?? '',
  };
}

function teamIdsOf(record: Record<string, unknown>): string[] {
  const teams = record['teams'];
  if (!Array.isArray(teams)) return [];
  return teams.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Template variables are the record's own simple fields (PLAN Phase 11 "Email templates"):
 * `{{name}}` renders the subject, `{{status}}` the status, and so on. Objects and arrays are
 * skipped — a template is text, and a list value would render as "[object Object]".
 */
function templateVariables(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

@Injectable()
export class EmailService {
  constructor(
    @Inject(MAIL_TRANSPORT_TOKEN) private readonly transport: MailTransport,
    @Inject(INBOUND_MAIL_PROVIDER_TOKEN) private readonly inbound: InboundMailProvider,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EmailAccountsService) private readonly accounts: EmailAccountsService,
    @Inject(InboundConnectionsService) private readonly inboundConnections: InboundConnectionsService,
    @Optional() @Inject(AttachmentService) private readonly attachments: AttachmentService | undefined,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** What the UI needs before it offers a send at all (driver, mailbox, ceiling). */
  info(): MailTransportInfo {
    return this.transport.info;
  }

  /** Admin "verify settings": the provider's own failure text, never a stack. */
  async verifyTransport(): Promise<{ transport: string; verified: boolean; error: string | null }> {
    try {
      await this.transport.verify();
      return { transport: this.transport.name, verified: true, error: null };
    } catch (error: unknown) {
      return { transport: this.transport.name, verified: false, error: error instanceof Error ? error.message : String(error) } ;
    }
  }

  async deliveries(emailId: string): Promise<EmailDeliveryView[]> {
    await this.loadReadable(emailId);
    const rows = await this.database.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('email_id', '=', emailId)
      .orderBy('recipient_type', 'asc')
      .orderBy('recipient', 'asc')
      .execute();
    return rows.map(toDeliveryView);
  }

  /**
   * Validate the draft against the transport, write the recipient ledger and hand the send to the
   * queue. Order matters: every check that can fail runs before the first write, and the queue
   * accepts before the record flips, so a rejected request leaves no half-queued state behind.
   *
   * Phase 11 additions, applied before validation and persisted on the record so the worker sends
   * exactly what was reviewed: a referenced EmailTemplate renders subject/body, and the sending
   * account's signature is appended when the body does not already carry it.
   */
  async queueSend(emailId: string): Promise<QueuedEmail> {
    this.scope.requirePrincipal();
    const record = await this.loadReadable(emailId);
    await this.assertCanEdit(record);

    const status = typeof record['status'] === 'string' ? record['status'] : 'Draft';
    if (!SENDABLE_STATUSES.has(status)) {
      throw new ValidationError(`An email with status "${status}" cannot be queued for sending.`, { status });
    }

    // The sending mailbox: the record's own account, else the configured default account, else the
    // process-wide transport. An account overrides the transport entirely (its own SMTP settings).
    const accountId = await this.resolveAccountId(record);
    const account = accountId === null ? null : await this.accounts.resolveTransportConfig(accountId);
    const transport = account === null ? this.transport : createAccountSmtpTransport(account);

    const rendered = await this.renderContent(emailId, record, account?.signature ?? null);
    const effective = { ...record, ...rendered };

    const message = transport.prepare(
      emailRecordToMessageInput(
        { id: emailId, data: effective },
        { fallbackFrom: account?.emailAddress ?? this.transport.info.fromAddress },
      ),
    );
    const info = transport.info;
    if (info.name === 'none') {
      throw new FeatureDisabledError('mail transport');
    }

    // Persist the rendered content before queueing: the worker (and the audit trail) must see the
    // exact subject/body that was validated here, not the template placeholders.
    let stored = record;
    if (Object.keys(rendered).length > 0) {
      stored = await this.records.update(EMAIL_ENTITY, emailId, { ...rendered, version: record['version'] });
    }

    await this.writeLedger(emailId, message, info.name);
    // A §24 job row is created for the send, so the attempt is visible and cancellable like any
    // other background work; the worker adopts that row when it picks the queue entry up.
    const job = await this.jobs.enqueue({
      job: SEND_EMAIL_JOB,
      data: { emailId, ...(account === null ? {} : { emailAccountId: account.accountId }) },
    });
    const updated = await this.records.update(EMAIL_ENTITY, emailId, {
      status: 'Queued',
      version: (stored['version'] as number | undefined) ?? (record['version'] as number),
    });

    return {
      email: updated,
      deliveries: await this.deliveries(emailId),
      transport: info,
      job: { id: job.id, name: job.job, status: job.status },
    };
  }

  /**
   * Inbound collection (Phase 24.6): polls every configured provider — the env-selected one
   * plus every active Mail Inbound Connection — and stores each new message as an Email record
   * with status/direction `Inbound`.
   *
   * Guarantees (Phase 24.6 task 3):
   * - dedupe is scoped by connection: `(inboundConnectionId, providerMessageId)`, so the same
   *   provider-local id (IMAP UID 1) in two mailboxes is not a collision;
   * - bounded polls: `INBOUND_POLL_MAX_MESSAGES` per connection, `INBOUND_POLL_GLOBAL_MAX` overall;
   * - a mailbox-specific cursor is persisted only after a connection's whole batch is ingested,
   *   so a failed poll re-runs from the old cursor and dedupe makes the overlap safe (idempotent
   *   across restarts);
   * - attachments go through the attachment ACL/malware path; a rejected attachment never fails
   *   the message or the batch (partial-batch safety);
   * - bounce/auto-reply messages are stored with `messageKind` so downstream flows suppress
   *   automatic outbound effects (see `EmailToCaseService`).
   *
   * When no provider is configured the call fails clearly (`FEATURE_DISABLED`) instead of
   * returning a fake success.
   */
  async pollInbound(): Promise<{ fetched: number; stored: number; skipped: number }> {
    this.scope.requirePrincipal();
    const providers = await this.resolveInboundProviders();
    if (providers.length === 0) {
      throw new FeatureDisabledError('inbound mail provider');
    }
    let fetched = 0;
    let stored = 0;
    let skipped = 0;
    for (const entry of providers) {
      if (fetched > INBOUND_POLL_GLOBAL_MAX) break;
      const cursor = await this.loadCursor(entry.connectionId);
      let messages: readonly InboundMailMessage[];
      try {
        messages = await entry.provider.poll({ maxMessages: INBOUND_POLL_MAX_MESSAGES, cursor });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (entry.dbConnectionId !== undefined) await this.inboundConnections.recordPollError(entry.dbConnectionId, message);
        throw new ValidationError(`Inbound poll failed for connection "${entry.connectionId}": ${message}`, { connectionId: entry.connectionId });
      }
      const bounded = messages.slice(0, INBOUND_POLL_MAX_MESSAGES);
      fetched += bounded.length;
      for (const message of bounded) {
        const existing = await this.findInboundRecord(entry.connectionId, message.providerMessageId);
        if (existing !== null) {
          skipped += 1;
          continue;
        }
        const record = inboundToEmailRecord(message, {
          connectionId: entry.connectionId,
          ...(entry.emailAccountId === undefined ? {} : { emailAccountId: entry.emailAccountId }),
        });
        record['threadId'] = (await this.resolveThreadId(message)) ?? record['threadId'];
        if (entry.ownerUserId !== undefined) record['assignedUserId'] = entry.ownerUserId;
        const created = await this.records.create(EMAIL_ENTITY, record);
        await this.storeInboundAttachments(String(created['id']), message);
        stored += 1;
      }
      const nextCursor = await entry.provider.nextCursor?.();
      await this.saveCursor(entry.connectionId, nextCursor ?? cursor);
      if (entry.dbConnectionId !== undefined) await this.inboundConnections.lastPolled(entry.dbConnectionId);
    }
    return { fetched, stored, skipped };
  }

  /** Env-selected provider (if configured) plus active database connections, each with its cursor identity. */
  private async resolveInboundProviders(): Promise<
    Array<{
      provider: InboundMailProvider;
      connectionId: string;
      dbConnectionId?: string | undefined;
      emailAccountId?: string | undefined;
      ownerUserId?: string | undefined;
    }>
  > {
    const providers: Array<{
      provider: InboundMailProvider;
      connectionId: string;
      dbConnectionId?: string | undefined;
      emailAccountId?: string | undefined;
      ownerUserId?: string | undefined;
    }> = [];
    if (this.inbound.configured !== false) {
      providers.push({
        provider: this.inbound,
        connectionId: this.inbound.connectionId ?? this.inbound.name,
      });
    }
    if (this.scope.isAdmin) {
      const connections = await this.inboundConnections.activeForPoll();
      for (const connection of connections) {
        providers.push({
          provider: this.inboundConnections.buildProvider(connection.view, connection.credential),
          connectionId: connection.view.id,
          dbConnectionId: connection.view.id,
          emailAccountId: connection.view.id,
          ...(connection.view.ownerUserId === null ? {} : { ownerUserId: connection.view.ownerUserId }),
        });
      }
    }
    return providers;
  }

  /** Scoped dedupe lookup: same provider id in a different connection is a different message. */
  private async findInboundRecord(connectionId: string, providerMessageId: string): Promise<{ id: string } | null> {
    const row = await this.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', EMAIL_ENTITY)
      .where('deleted_at', 'is', null)
      .where(sql`attrs ->> 'inboundConnectionId'`, '=', connectionId)
      .where(sql`attrs ->> 'messageId'`, '=', providerMessageId)
      .executeTakeFirst();
    return row === undefined ? null : { id: row.id };
  }

  /** A reply joins the thread of the message it answers, even across connections (thread linking). */
  private async resolveThreadId(message: InboundMailMessage): Promise<string | null> {
    if (message.inReplyTo === null) return null;
    // The RFC Message-Id lives in the stored headers JSON (`messageId` attr is the provider id,
    // needed for scoped dedupe), so match against the headers text as well as the title attribute.
    const parent = await this.database.db
      .selectFrom('entity_records')
      .select('attrs')
      .where('entity_type', '=', EMAIL_ENTITY)
      .where('deleted_at', 'is', null)
      .where((builder) =>
        builder.or([
          builder(sql`attrs ->> 'messageId'`, '=', message.inReplyTo ?? ''),
          builder(sql`attrs ->> 'headers'`, 'like', `%${message.inReplyTo}%`),
        ]),
      )
      .executeTakeFirst();
    const attrs = parent?.attrs as Record<string, unknown> | undefined;
    if (attrs === undefined) return null;
    return typeof attrs['threadId'] === 'string' ? attrs['threadId'] : null;
  }

  /** Stores decoded attachments through the attachment ACL/malware path; failures skip one attachment, never the batch. */
  private async storeInboundAttachments(emailId: string, message: InboundMailMessage): Promise<void> {
    if (this.attachments === undefined || message.attachments === undefined) return;
    for (const attachment of message.attachments) {
      try {
        await this.attachments.upload({
          filename: attachment.filename,
          mimeType: attachment.contentType,
          body: attachment.data,
          parentType: EMAIL_ENTITY,
          parentId: emailId,
        });
      } catch {
        // Malware/ACL/size rejection of one attachment must not lose the message or the batch.
      }
    }
  }

  private async loadCursor(connectionId: string): Promise<string | null> {
    const row = await this.database.db
      .selectFrom('inbound_mail_cursors')
      .select('cursor')
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    return row?.cursor ?? null;
  }

  private async saveCursor(connectionId: string, cursor: string | null): Promise<void> {
    await this.database.db
      .insertInto('inbound_mail_cursors')
      .values({ connection_id: connectionId, cursor, last_uid: null, updated_at: new Date() })
      .onConflict((builder) => builder.column('connection_id').doUpdateSet({ cursor, updated_at: new Date() }))
      .execute();
  }

  /** Email account of a record: its own `emailAccountId`, else the default account, else none. */
  private async resolveAccountId(record: Record<string, unknown>): Promise<string | null> {
    const explicit = record['emailAccountId'];
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
    return this.accounts.defaultAccountId();
  }

  /**
   * Renders the referenced template (if any) and applies the signature, returning the field patch
   * to persist. Variables are the record's own simple fields, so `{{name}}`, `{{status}}` etc. work
   * in a template body without a formula engine.
   */
  private async renderContent(
    emailId: string,
    record: Record<string, unknown>,
    signature: string | null,
  ): Promise<Record<string, string>> {
    const patch: Record<string, string> = {};
    const templateId = record['templateId'];
    if (typeof templateId === 'string' && templateId.trim() !== '') {
      const template = await this.loadTemplate(emailId, templateId.trim());
      const rendered = renderTemplateParts(
        {
          subject: typeof template['subject'] === 'string' ? template['subject'] : null,
          body: typeof template['body'] === 'string' ? template['body'] : null,
          bodyHtml: typeof template['bodyHtml'] === 'string' ? template['bodyHtml'] : null,
        },
        templateVariables(record),
      );
      if (rendered.subject !== null && rendered.subject !== '') patch['name'] = rendered.subject;
      if (rendered.body !== null && rendered.body !== '') patch['body'] = rendered.body;
      if (rendered.bodyHtml !== null && rendered.bodyHtml !== '') patch['bodyHtml'] = rendered.bodyHtml;
    }

    // Signature: append once (idempotent for a re-queue) as a plain-text footer block.
    if (signature !== null && signature.trim() !== '') {
      const body = typeof patch['body'] === 'string' ? patch['body'] : typeof record['body'] === 'string' ? record['body'] : '';
      if (!body.includes(signature)) {
        patch['body'] = `${body}${body === '' ? '' : '\n\n'}--\n${signature}`;
      }
    }
    return patch;
  }

  private async loadTemplate(emailId: string, templateId: string): Promise<Record<string, unknown>> {
    try {
      return await this.records.get(EMAIL_TEMPLATE_ENTITY, templateId);
    } catch (error: unknown) {
      if (error instanceof RecordNotFoundError) {
        throw new ValidationError(`Email "${emailId}" references template "${templateId}", which does not exist.`, {
          templateId,
        });
      }
      throw error;
    }
  }

  /** One row per recipient of the normalized message; re-queueing replaces the ledger. */
  private async writeLedger(emailId: string, message: MailMessage, transportName: string): Promise<void> {
    const rows = [
      ...message.to.map((entry) => ({ recipient: entry.address, recipientType: 'to' })),
      ...message.cc.map((entry) => ({ recipient: entry.address, recipientType: 'cc' })),
      ...message.bcc.map((entry) => ({ recipient: entry.address, recipientType: 'bcc' })),
    ];
    await this.database.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('email_deliveries').where('email_id', '=', emailId).execute();
      const now = new Date();
      for (const row of rows) {
        await tx
          .insertInto('email_deliveries')
          .values({
            id: generateId(),
            email_id: emailId,
            recipient: row.recipient,
            recipient_type: row.recipientType,
            status: 'pending',
            transport: transportName,
            provider_message_id: null,
            error: null,
            attempts: 0,
            created_at: now,
            modified_at: now,
            sent_at: null,
          })
          .execute();
      }
    });
  }

  private async loadReadable(emailId: string): Promise<Record<string, unknown>> {
    return this.records.get(EMAIL_ENTITY, emailId);
  }

  /**
   * Queueing a send is an edit of the record plus an external effect, so `edit` on the record is the
   * right gate. It is checked before any write so a denied caller cannot leave ledger rows behind.
   */
  private async assertCanEdit(record: Record<string, unknown>): Promise<void> {
    if (this.scope.isAdmin) return;
    const decision = await this.acl.canAccessRecord(EMAIL_ENTITY, 'edit', {
      ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
      ...(typeof record['id'] === 'string' ? { data: record } : {}),
      assignedUserId: typeof record['assignedUserId'] === 'string' ? record['assignedUserId'] : undefined,
      createdById: typeof record['createdById'] === 'string' ? record['createdById'] : undefined,
      teams: teamIdsOf(record),
    });
    if (!decision.allowed) {
      throw new AuthorizationDeniedError('You may not send this email.', { reason: decision.reason ?? 'no edit access' });
    }
  }
}
