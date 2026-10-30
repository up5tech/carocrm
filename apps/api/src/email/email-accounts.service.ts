/**
 * Email accounts (PLAN Phase 11 "Email accounts", §28.3 "credentials encrypted at rest").
 *
 * An account is one sending mailbox: address plus its SMTP connection settings. The password is
 * write-only — it is encrypted with `ENCRYPTION_KEY` (AES-256-GCM) before it reaches the database
 * and is never returned by any read path; responses only report `hasPassword`. The worker decrypts
 * it at send time to build the account's transport.
 *
 * Accounts are administration data, not CRM records: every route is admin-only, mirroring the
 * metadata write gate (a non-admin cannot even list mailboxes).
 */
import { randomUUID } from 'node:crypto';

import { AuthorizationDeniedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { decryptSecret, encryptSecret } from '@carocrm/core/utils/crypto.js';
import { type AccountSmtpConfig,createAccountSmtpTransport } from '@carocrm/mail';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { patchOf } from '../common/patch-schema.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService, type DbTx, type EmailAccountsTable } from '../database/database.service.js';

const SECURITY_MODES = ['starttls', 'ssl', 'none'] as const;

const AccountInputSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.').max(190),
  emailAddress: z.string().trim().min(3).max(320),
  fromName: z.string().trim().max(190).nullable().optional(),
  smtpHost: z.string().trim().min(1, 'An SMTP host is required.').max(255),
  smtpPort: z.number().int().min(1).max(65_535).default(587),
  smtpSecurity: z.enum(SECURITY_MODES).default('starttls'),
  smtpUsername: z.string().trim().max(255).nullable().optional(),
  /** Write-only. Stored encrypted (§28.3); omitted on update means "keep the current password". */
  smtpPassword: z.string().max(1000).nullable().optional(),
  signature: z.string().max(10_000).nullable().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export type AccountInput = z.infer<typeof AccountInputSchema>;

/** Safe read shape: identical to the row minus the encrypted password. */
export interface EmailAccountView {
  id: string;
  name: string;
  emailAddress: string;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  smtpUsername: string | null;
  /** True when a password is stored; the secret itself never leaves the server. */
  hasPassword: boolean;
  signature: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdById: string | null;
  createdAt: string;
  modifiedAt: string;
}

function toView(row: EmailAccountsTable): EmailAccountView {
  return {
    id: row.id,
    name: row.name,
    emailAddress: row.email_address,
    fromName: row.from_name,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    smtpUsername: row.smtp_username,
    hasPassword: row.smtp_password_encrypted !== null && row.smtp_password_encrypted !== '',
    signature: row.signature,
    isActive: row.is_active,
    isDefault: row.is_default,
    createdById: row.created_by_id,
    createdAt: row.created_at.toISOString(),
    modifiedAt: row.modified_at.toISOString(),
  };
}

/** The AccountSmtpConfig the worker needs, with the password decrypted in memory only. */
export interface ResolvedAccountTransport extends AccountSmtpConfig {
  accountId: string;
}


@Injectable()
export class EmailAccountsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async list(): Promise<EmailAccountView[]> {
    this.requireAdmin();
    const rows = await this.database.db
      .selectFrom('email_accounts')
      .selectAll()
      .where('is_deleted', '=', false)
      .orderBy('name')
      .execute();
    return rows.map(toView);
  }

  async get(id: string): Promise<EmailAccountView> {
    this.requireAdmin();
    return toView(await this.row(id));
  }

  async create(payload: unknown): Promise<EmailAccountView> {
    this.requireAdmin();
    const data = AccountInputSchema.parse(payload);
    const encrypted = this.encryptPassword(data.smtpPassword ?? null);
    const id = randomUUID();
    const now = new Date();
    await this.database.db.transaction().execute(async (tx) => {
      if (data.isDefault) await clearDefault(tx);
      await tx
        .insertInto('email_accounts')
        .values({
          id,
          name: data.name,
          email_address: data.emailAddress,
          from_name: data.fromName ?? null,
          smtp_host: data.smtpHost,
          smtp_port: data.smtpPort,
          smtp_security: data.smtpSecurity,
          smtp_username: data.smtpUsername ?? null,
          smtp_password_encrypted: encrypted,
          signature: data.signature ?? null,
          is_active: data.isActive,
          is_default: data.isDefault,
          is_deleted: false,
          created_by_id: this.scope.userId ?? null,
          created_at: now,
          modified_at: now,
        })
        .execute();
    });
    return this.get(id);
  }

  async update(id: string, payload: unknown): Promise<EmailAccountView> {
    this.requireAdmin();
    const data = patchOf(AccountInputSchema).parse(payload);
    await this.row(id); // 404 before any write
    const encrypted = data.smtpPassword === undefined ? undefined : this.encryptPassword(data.smtpPassword);
    await this.database.db.transaction().execute(async (tx) => {
      if (data.isDefault === true) await clearDefault(tx);
      await tx
        .updateTable('email_accounts')
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.emailAddress !== undefined ? { email_address: data.emailAddress } : {}),
          ...(data.fromName !== undefined ? { from_name: data.fromName } : {}),
          ...(data.smtpHost !== undefined ? { smtp_host: data.smtpHost } : {}),
          ...(data.smtpPort !== undefined ? { smtp_port: data.smtpPort } : {}),
          ...(data.smtpSecurity !== undefined ? { smtp_security: data.smtpSecurity } : {}),
          ...(data.smtpUsername !== undefined ? { smtp_username: data.smtpUsername } : {}),
          ...(encrypted !== undefined ? { smtp_password_encrypted: encrypted } : {}),
          ...(data.signature !== undefined ? { signature: data.signature } : {}),
          ...(data.isActive !== undefined ? { is_active: data.isActive } : {}),
          ...(data.isDefault !== undefined ? { is_default: data.isDefault } : {}),
          modified_at: new Date(),
        })
        .where('id', '=', id)
        .where('is_deleted', '=', false)
        .execute();
    });
    return this.get(id);
  }

  /** Soft delete; an account that already sent mail is kept for the delivery history. */
  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    this.requireAdmin();
    await this.row(id);
    await this.database.db
      .updateTable('email_accounts')
      .set({ is_deleted: true, is_active: false, is_default: false, modified_at: new Date() })
      .where('id', '=', id)
      .execute();
    return { id, deleted: true };
  }

  /**
   * The transport settings for an account, with the password decrypted in memory (never logged,
   * never returned). Used by the worker when it sends through a specific mailbox.
   */
  async resolveTransportConfig(accountId: string): Promise<ResolvedAccountTransport> {
    const row = await this.row(accountId);
    if (!row.is_active) {
      throw new ValidationError(`Email account "${row.name}" is not active.`, { accountId });
    }
    return {
      accountId: row.id,
      emailAddress: row.email_address,
      fromName: row.from_name,
      smtpHost: row.smtp_host,
      smtpPort: row.smtp_port,
      smtpSecurity: row.smtp_security,
      smtpUsername: row.smtp_username,
      smtpPassword:
        row.smtp_password_encrypted === null || row.smtp_password_encrypted === ''
          ? null
          : decryptSecret(row.smtp_password_encrypted, this.requireEncryptionKey()),
      signature: row.signature,
    };
  }

  /** The default sending mailbox id, when one is configured. */
  async defaultAccountId(): Promise<string | null> {
    const row = await this.database.db
      .selectFrom('email_accounts')
      .select('id')
      .where('is_deleted', '=', false)
      .where('is_active', '=', true)
      .where('is_default', '=', true)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async row(id: string): Promise<EmailAccountsTable> {
    const row = await this.database.db
      .selectFrom('email_accounts')
      .selectAll()
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!row) throw new RecordNotFoundError('EmailAccount', id);
    return row;
  }

  private encryptPassword(password: string | null): string | null {
    if (password === null || password === '') return null;
    return encryptSecret(password, this.requireEncryptionKey());
  }

  /** An empty key must never degrade into plaintext storage (§28.3). */
  private requireEncryptionKey(): string {
    if (this.config.encryptionKey.trim() === '') {
      throw new ValidationError(
        'ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before storing mail credentials.',
      );
    }
    return this.config.encryptionKey;
  }

  private requireAdmin(): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Only an administrator can manage email accounts.');
    }
  }

  /** Opens the account's SMTP connection; admin-only "test settings" action. */
  async verify(id: string): Promise<{ verified: boolean; error: string | null }> {
    this.requireAdmin();
    const transport = createAccountSmtpTransport(await this.resolveTransportConfig(id));
    try {
      await transport.verify();
      return { verified: true, error: null };
    } catch (error: unknown) {
      return { verified: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Only one account may be the default at a time. */
async function clearDefault(tx: DbTx): Promise<void> {
  await tx.updateTable('email_accounts').set({ is_default: false }).where('is_default', '=', true).execute();
}
