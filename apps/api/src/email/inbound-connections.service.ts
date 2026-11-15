/**
 * Inbound mail connections (Phase 24.6).
 *
 * One row per mailbox/connection, administered at installation level like email accounts:
 * admin-only routes, the credential write-only and encrypted with `ENCRYPTION_KEY` (the same
 * vault as SMTP account passwords), responses never carrying the secret. Each connection
 * keeps its own poll cursor, so overlapping provider-local ids across mailboxes cannot
 * collide (Phase 24.6 dedupe rule).
 */
import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { decryptSecret, encryptSecret } from '@carocrm/core/utils/crypto.js';
import type { InboundMailProvider } from '@carocrm/mail';
import { GraphInboundProvider, ImapInboundProvider } from '@carocrm/mail';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { patchOf } from '../common/patch-schema.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService, type InboundMailConnectionsTable } from '../database/database.service.js';

const ConnectionInputSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(190),
  provider: z.enum(['imap', 'graph']),
  mailbox: z.string().trim().min(3).max(320),
  /** IMAP host (required for `imap`); Graph leaves this empty. */
  host: z.string().trim().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
  secure: z.boolean().default(true),
  folder: z.string().trim().max(255).nullable().optional(),
  tenantId: z.string().trim().max(255).nullable().optional(),
  clientId: z.string().trim().max(255).nullable().optional(),
  /** Write-only. Stored encrypted (§28.3); omitted on update means "keep the current credential". */
  credential: z.string().max(4000).nullable().optional(),
  ownerUserId: z.string().trim().max(64).nullable().optional(),
  isActive: z.boolean().default(true),
});

export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;

/** Safe read shape: the row minus the encrypted credential. */
export interface InboundConnectionView {
  id: string;
  name: string;
  provider: string;
  mailbox: string;
  host: string | null;
  port: number | null;
  secure: boolean;
  folder: string | null;
  tenantId: string | null;
  clientId: string | null;
  hasCredential: boolean;
  ownerUserId: string | null;
  isActive: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
  createdById: string | null;
  createdAt: string;
  modifiedAt: string;
}

function toView(row: InboundMailConnectionsTable): InboundConnectionView {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    mailbox: row.mailbox,
    host: row.host,
    port: row.port,
    secure: row.secure,
    folder: row.folder,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    hasCredential: row.credential_encrypted !== null && row.credential_encrypted !== '',
    ownerUserId: row.owner_user_id,
    isActive: row.is_active,
    lastPolledAt: row.last_polled_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdById: row.created_by_id,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

@Injectable()
export class InboundConnectionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async list(): Promise<InboundConnectionView[]> {
    this.requireAdmin();
    const rows = await this.database.db
      .selectFrom('inbound_mail_connections')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name')
      .execute();
    return rows.map(toView);
  }

  async get(id: string): Promise<InboundConnectionView> {
    this.requireAdmin();
    return toView(await this.row(id));
  }

  async create(payload: unknown): Promise<InboundConnectionView> {
    this.requireAdmin();
    const data = ConnectionInputSchema.parse(payload);
    this.requireShape(data);
    const encrypted = this.encryptCredential(data.credential ?? null);
    const id = randomUUID();
    const now = new Date();
    await this.database.db
      .insertInto('inbound_mail_connections')
      .values({
        id,
        name: data.name,
        provider: data.provider,
        mailbox: data.mailbox,
        host: data.host ?? null,
        port: data.port ?? null,
        secure: data.secure,
        folder: data.folder ?? null,
        tenant_id: data.tenantId ?? null,
        client_id: data.clientId ?? null,
        credential_encrypted: encrypted,
        owner_user_id: data.ownerUserId ?? null,
        is_active: data.isActive,
        is_deleted: false,
        last_polled_at: null,
        last_error: null,
        created_by_id: this.scope.userId ?? null,
        created_at: now,
        modified_at: now,
      })
      .execute();
    return this.get(id);
  }

  async update(id: string, payload: unknown): Promise<InboundConnectionView> {
    this.requireAdmin();
    const data = patchOf(ConnectionInputSchema).parse(payload);
    const existing = await this.row(id);
    const merged: ConnectionInput = {
      name: data.name ?? existing.name,
      provider: (data.provider ?? existing.provider) as 'imap' | 'graph',
      mailbox: data.mailbox ?? existing.mailbox,
      host: data.host !== undefined ? data.host : existing.host,
      port: data.port !== undefined ? data.port : existing.port,
      secure: data.secure ?? existing.secure,
      folder: data.folder !== undefined ? data.folder : existing.folder,
      tenantId: data.tenantId !== undefined ? data.tenantId : existing.tenant_id,
      clientId: data.clientId !== undefined ? data.clientId : existing.client_id,
      credential: data.credential !== undefined ? data.credential : null,
      ownerUserId: data.ownerUserId !== undefined ? data.ownerUserId : existing.owner_user_id,
      isActive: data.isActive ?? existing.is_active,
    };
    this.requireShape(merged);
    const encrypted =
      data.credential !== undefined ? this.encryptCredential(data.credential) : existing.credential_encrypted;
    await this.database.db
      .updateTable('inbound_mail_connections')
      .set({
        name: merged.name,
        provider: merged.provider,
        mailbox: merged.mailbox,
        host: merged.host ?? null,
        port: merged.port ?? null,
        secure: merged.secure,
        folder: merged.folder ?? null,
        tenant_id: merged.tenantId ?? null,
        client_id: merged.clientId ?? null,
        credential_encrypted: encrypted,
        owner_user_id: merged.ownerUserId ?? null,
        is_active: merged.isActive,
        modified_at: new Date(),
      })
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .execute();
    return this.get(id);
  }

  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.row(id);
    await this.database.db
      .updateTable('inbound_mail_connections')
      .set({ is_deleted: true, modified_at: new Date() })
      .where('id', '=', id)
      .execute();
    return { id, deleted: true };
  }

  /** Active connections, with the decrypted credential for the poll loop. Internal to the email module. */
  async activeForPoll(): Promise<Array<{ view: InboundConnectionView; credential: string | null }>> {
    const rows = await this.database.db
      .selectFrom('inbound_mail_connections')
      .selectAll()
      .where('is_deleted', '=', false)
      .where('is_active', '=', true)
      .orderBy('name')
      .execute();
    return rows.map((row) => ({
      view: toView(row),
      credential: row.credential_encrypted === null || row.credential_encrypted === '' ? null : this.decryptCredential(row.credential_encrypted),
    }));
  }

  /** Builds the provider for one connection from its (decrypted) credential. */
  buildProvider(view: InboundConnectionView, credential: string | null): InboundMailProvider {
    if (view.provider === 'imap') {
      if (view.host === null || view.host.trim() === '') throw new ValidationError(`Inbound connection "${view.name}" has no IMAP host.`, { connectionId: view.id });
      if (credential === null) throw new ValidationError(`Inbound connection "${view.name}" has no stored credential.`, { connectionId: view.id });
      return new ImapInboundProvider(
        {
          host: view.host,
          port: view.port ?? 993,
          secure: view.secure,
          username: view.mailbox,
          password: credential,
          mailbox: view.folder ?? 'INBOX',
          maxMessageBytes: 10 * 1024 * 1024,
          connectTimeoutMs: 15_000,
        },
        { connectionId: view.id },
      );
    }
    if (view.tenantId === null || view.clientId === null || credential === null) {
      throw new ValidationError(`Inbound connection "${view.name}" is missing tenant, client or credential.`, { connectionId: view.id });
    }
    return new GraphInboundProvider(
      { tenantId: view.tenantId, clientId: view.clientId, clientSecret: credential, accessToken: null, mailbox: view.mailbox },
      { connectionId: view.id },
    );
  }

  async lastPolled(id: string): Promise<void> {
    await this.database.db
      .updateTable('inbound_mail_connections')
      .set({ last_polled_at: new Date(), last_error: null, modified_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  async recordPollError(id: string, message: string): Promise<void> {
    await this.database.db
      .updateTable('inbound_mail_connections')
      .set({ last_polled_at: new Date(), last_error: message.slice(0, 1000), modified_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  private requireShape(data: ConnectionInput): void {
    if (data.provider === 'imap' && (data.host === undefined || data.host === null || data.host.trim() === '')) {
      throw new ValidationError('IMAP connections need a host.', { field: 'host' });
    }
    if (data.provider === 'graph' && ((data.tenantId ?? '').trim() === '' || (data.clientId ?? '').trim() === '')) {
      throw new ValidationError('Graph connections need a tenant id and client id.', { field: 'tenantId' });
    }
  }

  private encryptCredential(plaintext: string | null): string | null {
    if (plaintext === null || plaintext === '') return null;
    const key = this.config.encryptionKey;
    if (!key) {
      throw new ValidationError('ENCRYPTION_KEY is not configured, so the credential cannot be stored encrypted.', {
        field: 'credential',
      });
    }
    return encryptSecret(plaintext, key);
  }

  private decryptCredential(payload: string): string {
    const key = this.config.encryptionKey;
    if (!key) throw new ValidationError('ENCRYPTION_KEY is not configured, so the stored credential cannot be decrypted.', {});
    return decryptSecret(payload, key);
  }

  private async row(id: string): Promise<InboundMailConnectionsTable> {
    const row = await this.database.db
      .selectFrom('inbound_mail_connections')
      .selectAll()
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (row === undefined) throw new RecordNotFoundError('InboundConnection', id);
    return row;
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Only an administrator can manage inbound mail connections.');
    }
  }
}
