import { createHash, randomBytes } from 'node:crypto';

import { AuthenticationFailedError } from '@carocrm/core/errors/index.js';
import type { MailTransport } from '@carocrm/mail';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { sql } from 'kysely';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { MAIL_TRANSPORT_TOKEN } from '../email/email.constants.js';
import { assertPasswordPolicy, readSecurityPolicy } from './security-policy.js';

/** A reset request answers the same shape whether or not the account exists (no enumeration). */
export interface ResetRequestResult {
  status: true;
}

/** Minimum gap between two reset mails for one account, so the endpoint cannot mail-bomb a mailbox. */
const REQUEST_COOLDOWN_MS = 60_000;

/**
 * Phase 23.2 (PLAN §8 task 2) — self-service password reset.
 *
 * The token is CSPRNG-backed, stored only as a SHA-256 hash, single-use and expiring. Delivery goes
 * through the existing `MAIL_TRANSPORT_TOKEN` seam: with `MAIL_TRANSPORT=none` (the default) nothing
 * can be delivered, so no token is minted — the request still answers the same generic result.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MAIL_TRANSPORT_TOKEN) private readonly transport: MailTransport,
  ) {}

  async requestReset(identifier: string): Promise<ResetRequestResult> {
    const db = this.database.db;
    const normalized = identifier.trim();
    const user = await db
      .selectFrom('users')
      .select(['id', 'email_address', 'password', 'is_active', 'is_deleted'])
      .where((eb) => eb.or([eb('user_name', '=', normalized), eb(sql<string>`lower(email_address)`, '=', normalized.toLowerCase())]))
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!user || !user.is_active || !user.password || !user.email_address) return { status: true };
    // Fail closed: an installation that cannot send mail must not mint tokens nobody can receive.
    if (this.transport.info.name === 'none') return { status: true };
    const from = process.env['SMTP_FROM'];
    if (!from) return { status: true };
    const latest = await db
      .selectFrom('auth_password_resets')
      .select('created_at')
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (latest && Date.now() - latest.created_at.getTime() < REQUEST_COOLDOWN_MS) return { status: true };

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.config.passwordResetTtlSeconds * 1000);
    const minutes = Math.round(this.config.passwordResetTtlSeconds / 60);
    try {
      // Send first, store second: a transport failure must not leave a token that was never delivered.
      await this.transport.send({
        from,
        to: user.email_address,
        subject: 'CaroCRM password reset',
        text: [
          'A password reset was requested for your CaroCRM account.',
          '',
          `Open your CRM sign-in page, choose "Forgot password", and enter this token:`,
          token,
          '',
          `The token expires in ${String(minutes)} minutes and can be used exactly once.`,
          'If you did not request this, you can ignore this email; your password stays unchanged.',
        ].join('\n'),
      });
    } catch {
      return { status: true };
    }
    // One live token per account: a new request retires the previous one, and consumed/expired rows
    // are swept so the table stays bounded without a cleanup job.
    await db.deleteFrom('auth_password_resets').where('user_id', '=', user.id).execute();
    await db.deleteFrom('auth_password_resets').where((eb) => eb.or([eb('expires_at', '<', new Date()), eb('used_at', 'is not', null)])).execute();
    await db.insertInto('auth_password_resets').values({ token_hash: tokenHash, user_id: user.id, expires_at: expiresAt, used_at: null, created_at: new Date() }).execute();
    return { status: true };
  }

  async confirmReset(token: string, newPassword: string): Promise<ResetRequestResult> {
    const db = this.database.db;
    const policy = await readSecurityPolicy(db);
    assertPasswordPolicy(policy, newPassword);
    const tokenHash = createHash('sha256').update(token.trim()).digest('hex');
    const row = await db.selectFrom('auth_password_resets').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst();
    if (!row || row.used_at !== null || row.expires_at.getTime() < Date.now()) {
      throw new AuthenticationFailedError('Reset token is invalid or expired.');
    }
    const user = await db
      .selectFrom('users')
      .select(['id', 'user_name', 'is_active', 'is_deleted'])
      .where('id', '=', row.user_id)
      .executeTakeFirst();
    if (!user || !user.is_active || user.is_deleted) {
      throw new AuthenticationFailedError('Reset token is invalid or expired.');
    }
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const now = new Date();
    await db.transaction().execute(async (tx) => {
      // Re-check under the row lock: two concurrent confirms must not both consume the token.
      const locked = await tx
        .selectFrom('auth_password_resets')
        .select(['used_at', 'expires_at'])
        .where('token_hash', '=', tokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.used_at !== null || locked.expires_at.getTime() < Date.now()) {
        throw new AuthenticationFailedError('Reset token is invalid or expired.');
      }
      await tx.updateTable('users').set({ password: hash, modified_at: now }).where('id', '=', user.id).execute();
      await tx.updateTable('auth_password_resets').set({ used_at: now }).where('token_hash', '=', tokenHash).execute();
      await tx.deleteFrom('auth_password_resets').where('user_id', '=', user.id).where('token_hash', '!=', tokenHash).execute();
      // A reset invalidates every session the old password opened, and clears any lockout the
      // forgotten password caused — the owner has just proven control of the account's mailbox.
      await tx.updateTable('user_sessions').set({ revoked_at: now }).where('user_id', '=', user.id).where('revoked_at', 'is', null).execute();
      const subjectHash = createHash('sha256').update(user.user_name.trim().toLowerCase()).digest('hex');
      await tx.deleteFrom('auth_login_attempts').where('subject_hash', '=', subjectHash).execute();
    });
    return { status: true };
  }
}