/**
 * Outbound email (PLAN §28.1, §28.3).
 *
 * An email is a metadata entity record, so the kernel already enforces its ACL, audit and stream
 * rules and the SPA can list it like anything else. This service adds only what is not record
 * content: the transport's own recipient/From validation, the per-recipient `email_deliveries`
 * ledger, and the queueing of `system.sendEmail`. Nothing is sent from the API process — the worker
 * owns the network call, so a slow or broken SMTP server can never hold a request open.
 */
import { AuthorizationDeniedError, FeatureDisabledError, ValidationError } from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { MailMessage, MailTransport, MailTransportInfo } from '@carocrm/mail';
import { emailRecordToMessageInput } from '@carocrm/mail';
import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService, type EmailDeliveriesTable } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { EMAIL_ENTITY, MAIL_TRANSPORT_TOKEN, SEND_EMAIL_JOB, SENDABLE_STATUSES } from './email.constants.js';

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

@Injectable()
export class EmailService {
  constructor(
    @Inject(MAIL_TRANSPORT_TOKEN) private readonly transport: MailTransport,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(JobsService) private readonly jobs: JobsService,
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
   */
  async queueSend(emailId: string): Promise<QueuedEmail> {
    this.scope.requirePrincipal();
    const record = await this.loadReadable(emailId);
    await this.assertCanEdit(record);

    const status = typeof record['status'] === 'string' ? record['status'] : 'Draft';
    if (!SENDABLE_STATUSES.has(status)) {
      throw new ValidationError(`An email with status "${status}" cannot be queued for sending.`, { status });
    }

    const message = this.transport.prepare(
      emailRecordToMessageInput({ id: emailId, data: record }, { fallbackFrom: this.transport.info.fromAddress }),
    );
    const info = this.transport.info;
    if (info.name === 'none') {
      throw new FeatureDisabledError('mail transport');
    }

    await this.writeLedger(emailId, message);
    // A §24 job row is created for the send, so the attempt is visible and cancellable like any
    // other background work; the worker adopts that row when it picks the queue entry up.
    const job = await this.jobs.enqueue({ job: SEND_EMAIL_JOB, data: { emailId } });
    const updated = await this.records.update(EMAIL_ENTITY, emailId, { status: 'Queued', version: record['version'] });

    return {
      email: updated,
      deliveries: await this.deliveries(emailId),
      transport: info,
      job: { id: job.id, name: job.job, status: job.status },
    };
  }

  /** One row per recipient of the normalized message; re-queueing replaces the ledger. */
  private async writeLedger(emailId: string, message: MailMessage): Promise<void> {
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
            transport: this.transport.name,
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
      assignedUserId: typeof record['assignedUserId'] === 'string' ? record['assignedUserId'] : undefined,
      createdById: typeof record['createdById'] === 'string' ? record['createdById'] : undefined,
      teams: teamIdsOf(record),
    });
    if (!decision.allowed) {
      throw new AuthorizationDeniedError('You may not send this email.', { reason: decision.reason ?? 'no edit access' });
    }
  }
}
