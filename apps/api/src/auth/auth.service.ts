import { createHash, randomBytes,randomUUID } from 'node:crypto';

import { AuthenticationFailedError, AuthenticationRequiredError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { hashString } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { errors as joseErrors, type JWTPayload, jwtVerify, SignJWT } from 'jose';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { newRecoveryCodes, newTotpSecret, otpauthUri, totpVerify } from './totp.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** §4.9: a password that matched on a 2FA account does not open a session yet. */
export type LoginOutcome =
  | { kind: 'ok'; tokens: AuthTokens }
  | { kind: 'challenge'; challengeId: string };

export interface PrincipalRecord {
  userId: string;
  userName: string;
  userType: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles: string[];
  teams: string[];
  /** Phase 18: portal assignment (PLAN §37). */
  portalId?: string | undefined;
  /** Phase 18: the Contact record a portal user is. */
  contactId?: string | undefined;
  /** Phase 7A (PLAN §41.6): the user's own locale/timezone; null falls back to instance defaults. */
  locale?: string | undefined;
  timezone?: string | undefined;
}

/** What the signed-in user may change about themselves; `null` clears a value. */
export interface ProfilePatch {
  locale?: string | null | undefined;
  timezone?: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
  emailAddress?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  title?: string | null | undefined;
  avatarId?: string | null | undefined;
}

export interface ProfileDto {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  emailAddress: string | null;
  phoneNumber: string | null;
  title: string | null;
  avatarId: string | null;
  /** §4.9: whether sign-in still owes a TOTP code after the password. */
  twoFactorEnabled: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private get secretKey(): Uint8Array {
    return new Uint8Array(createHash('sha256').update(this.config.jwtSecret).digest());
  }

  async login(userName: string, password: string, ip?: string): Promise<LoginOutcome> {
    const db = this.database.db;
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('user_name', '=', userName)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!user || !user.is_active || !user.password) {
      throw new AuthenticationFailedError();
    }
    let ok = false;
    try {
      ok = await argon2.verify(user.password, password);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new AuthenticationFailedError();
    }
    const userType = user.type === 'admin' || user.is_admin ? 'admin' : user.type;
    if (user.totp_enabled && user.totp_secret) {
      // §4.9: the password was only the first factor — the session is issued by the challenge.
      return { kind: 'challenge', challengeId: await this.createChallenge(user.id) };
    }
    return { kind: 'ok', tokens: await this.createSession(user.id, userType, ip) };
  }

  /**
   * §4.9 two-factor authentication: the login challenge plus enrollment and recovery codes.
   *
   * The secret only becomes enforced at `enableTotp`, when a code it produced is presented, so an
   * abandoned enrollment never locks anyone out. A challenge is single-use, expires after five
   * minutes and is attempt-bounded — it can never become a second password-guessing oracle.
   */
  private async createChallenge(userId: string): Promise<string> {
    const db = this.database.db;
    // One live challenge per account: starting a new sign-in retires the previous one.
    await db.deleteFrom('auth_challenges').where('user_id', '=', userId).execute();
    const id = randomUUID();
    await db
      .insertInto('auth_challenges')
      .values({ id, user_id: userId, expires_at: new Date(Date.now() + 5 * 60_000), attempts: 0, created_at: new Date() })
      .execute();
    return id;
  }

  async verifyChallenge(challengeId: string, code: string, ip?: string): Promise<AuthTokens> {
    const db = this.database.db;
    const challenge = await db
      .selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirst();
    if (!challenge || challenge.expires_at.getTime() < Date.now()) {
      throw new AuthenticationFailedError('Sign-in challenge is invalid or expired.');
    }
    if (challenge.attempts >= 5) {
      await db.deleteFrom('auth_challenges').where('id', '=', challengeId).execute();
      throw new AuthenticationFailedError('Too many attempts. Sign in again.');
    }
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', challenge.user_id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!user || !user.is_active || !user.totp_enabled || !user.totp_secret) {
      throw new AuthenticationFailedError();
    }
    const normalized = code.trim();
    let ok = totpVerify(user.totp_secret, normalized);
    let usedRecoveryHash: string | null = null;
    if (!ok) {
      // A recovery code signs in exactly once; a consumed one must look like a wrong one.
      const candidate = hashString(normalized.toLowerCase());
      const recovery = await db
        .selectFrom('user_recovery_codes')
        .select(['code_hash'])
        .where('user_id', '=', user.id)
        .where('code_hash', '=', candidate)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (recovery) {
        ok = true;
        usedRecoveryHash = recovery.code_hash;
      }
    }
    if (!ok) {
      await db
        .updateTable('auth_challenges')
        .set({ attempts: challenge.attempts + 1 })
        .where('id', '=', challengeId)
        .execute();
      throw new AuthenticationFailedError('Two-factor code is not valid.');
    }
    await db.deleteFrom('auth_challenges').where('user_id', '=', user.id).execute();
    if (usedRecoveryHash !== null) {
      await db
        .updateTable('user_recovery_codes')
        .set({ used_at: new Date() })
        .where('user_id', '=', user.id)
        .where('code_hash', '=', usedRecoveryHash)
        .execute();
    }
    return this.createSession(user.id, user.type === 'admin' || user.is_admin ? 'admin' : user.type, ip);
  }

  /** §4.9: hand out a pending secret; nothing is enforced until `enableTotp` confirms it. */
  async beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const db = this.database.db;
    const user = await db.selectFrom('users').select(['user_name']).where('id', '=', userId).executeTakeFirstOrThrow();
    const secret = newTotpSecret();
    await db
      .updateTable('users')
      .set({ totp_secret: secret, totp_enabled: false, totp_confirmed_at: null, modified_at: new Date() })
      .where('id', '=', userId)
      .execute();
    return { secret, otpauthUri: otpauthUri(user.user_name, secret, 'CaroCRM') };
  }

  /** Confirm enrollment with a code from the app, then issue the one-time recovery codes. */
  async enableTotp(userId: string, code: string): Promise<string[]> {
    const db = this.database.db;
    if (!(await this.totpCodeOk(userId, code, false))) {
      throw new AuthenticationFailedError('That code does not match the authenticator.');
    }
    await db
      .updateTable('users')
      .set({ totp_enabled: true, totp_confirmed_at: new Date(), modified_at: new Date() })
      .where('id', '=', userId)
      .execute();
    return this.replaceRecoveryCodes(userId);
  }

  /** §4.9: turning the second factor off requires a current factor — never a silent downgrade. */
  async disableTotp(userId: string, code: string): Promise<void> {
    if (!(await this.totpCodeOk(userId, code, true))) {
      throw new AuthenticationFailedError('That code is not valid.');
    }
    const db = this.database.db;
    await db
      .updateTable('users')
      .set({ totp_enabled: false, totp_secret: null, totp_confirmed_at: null, modified_at: new Date() })
      .where('id', '=', userId)
      .execute();
    await db.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute();
    await db.deleteFrom('auth_challenges').where('user_id', '=', userId).execute();
  }

  /** Burn the remaining codes and issue a fresh set; requires a current TOTP code. */
  async regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    if (!(await this.totpCodeOk(userId, code, true))) {
      throw new AuthenticationFailedError('That code is not valid.');
    }
    return this.replaceRecoveryCodes(userId);
  }

  /** §4.9 help-desk path: an administrator clears a factor the user lost; they re-enroll later. */
  async adminResetTotp(userId: string): Promise<void> {
    const db = this.database.db;
    await db
      .updateTable('users')
      .set({ totp_enabled: false, totp_secret: null, totp_confirmed_at: null, modified_at: new Date() })
      .where('id', '=', userId)
      .execute();
    await db.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute();
    await db.deleteFrom('auth_challenges').where('user_id', '=', userId).execute();
  }

  private async totpCodeOk(userId: string, code: string, requireEnabled: boolean): Promise<boolean> {
    const user = await this.database.db
      .selectFrom('users')
      .select(['totp_secret', 'totp_enabled'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user?.totp_secret) return false;
    if (requireEnabled && !user.totp_enabled) return false;
    return totpVerify(user.totp_secret, code.trim());
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const db = this.database.db;
    await db.deleteFrom('user_recovery_codes').where('user_id', '=', userId).execute();
    const codes = newRecoveryCodes();
    const now = new Date();
    await db
      .insertInto('user_recovery_codes')
      .values(codes.map((raw) => ({ user_id: userId, code_hash: hashString(raw.toLowerCase()), used_at: null, created_at: now })))
      .execute();
    return codes;
  }

  async createSession(userId: string, userType: PrincipalRecord['userType'], ip?: string): Promise<AuthTokens> {
    const db = this.database.db;
    const sessionId = randomUUID();
    const refreshToken = randomBytes(32).toString('hex');
    const user = await db.selectFrom('users').select(['user_name']).where('id', '=', userId).executeTakeFirst();
    if (!user) throw new RecordNotFoundError('User', userId);

    await db
      .insertInto('user_sessions')
      .values({
        id: sessionId,
        user_id: userId,
        refresh_token: hashString(refreshToken),
        revoked_at: null,
        is_admin: userType === 'admin',
        created_at: new Date(),
        modified_at: new Date(),
        last_access_at: new Date(),
        expired_at: new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000),
      })
      .execute();

    void ip;
    const accessToken = await this.signAccessToken({
      sub: userId,
      sid: sessionId,
      typ: 'access',
      scope: 'user',
    });
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const db = this.database.db;
    const hashed = hashString(refreshToken);
    const session = await db
      .selectFrom('user_sessions')
      .selectAll()
      .where('refresh_token', '=', hashed)
      .executeTakeFirst();
    if (!session || session.revoked_at !== null || (session.expired_at && session.expired_at.getTime() < Date.now())) {
      throw new AuthenticationFailedError('Session is invalid or expired.');
    }
    const user = await db.selectFrom('users').select(['id', 'type', 'is_admin', 'is_active', 'is_deleted'])
      .where('id', '=', session.user_id)
      .executeTakeFirst();
    if (!user || !user.is_active || user.is_deleted) {
      throw new AuthenticationFailedError();
    }
    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', session.id)
      .execute();
    return this.createSession(user.id, user.type === 'admin' || user.is_admin ? 'admin' : user.type);
  }

  async logout(accessToken: string | undefined, refreshToken?: string): Promise<void> {
    const db = this.database.db;
    if (refreshToken) {
      await db
        .updateTable('user_sessions')
        .set({ revoked_at: new Date() })
        .where('refresh_token', '=', hashString(refreshToken))
        .execute();
      return;
    }
    if (accessToken) {
      try {
        const payload = await this.verifyAccessToken(accessToken);
        const sid = payload.sid;
        if (typeof sid === 'string') {
          await db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('id', '=', sid).execute();
        }
      } catch {
        // token is not valid; logging out a stale token is a no-op
      }
    }
  }

  async signAccessToken(claims: { sub: string; sid?: string; typ: string; scope: string; keyId?: string }): Promise<string> {
    // `sid` travels in the token so the guard can honour session revocation (logout, password
    // change); without it a revoked session keeps working until the access token expires.
    return new SignJWT({
      typ: claims.typ,
      scope: claims.scope,
      ...(claims.sid !== undefined ? { sid: claims.sid } : {}),
      ...(claims.keyId !== undefined ? { keyId: claims.keyId } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.secretKey);
  }

  async verifyAccessToken(token: string): Promise<Record<string, string>> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.secretKey));
    } catch (error) {
      // `jwtVerify` signals every rejection — expiry, a forged signature, a malformed string — with
      // its own error class. Left to propagate it reached the exception filter as an unknown error
      // and answered **500**, which also meant the SPA's refresh-on-401 never ran: a session that had
      // simply aged out looked to the person holding it like a server outage. An unusable access
      // token is an authentication outcome, so it is reported as one.
      if (error instanceof joseErrors.JWTExpired) {
        throw new AuthenticationRequiredError('Access token has expired.');
      }
      throw new AuthenticationFailedError('Access token could not be verified.');
    }
    if (payload.typ !== 'access') {
      throw new AuthenticationFailedError('Invalid token type.');
    }
    if (typeof payload.sub !== 'string') {
      throw new AuthenticationFailedError('Invalid token subject.');
    }
    const result: Record<string, string> = { sub: payload.sub };
    if (typeof payload.sid === 'string') result.sid = payload.sid;
    if (typeof payload.keyId === 'string') result.keyId = payload.keyId;
    return result;
  }

  async issueApiKey(apiUserId: string): Promise<{ keyId: string; secret: string }> {
    const db = this.database.db;
    const keyId = `key_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    await db
      .insertInto('api_keys')
      .values({ id: keyId, api_user_id: apiUserId, secret_hash: hashString(secret), created_at: new Date(), last_used_at: null, revoked_at: null })
      .execute();
    return { keyId, secret };
  }

  async authenticateApiKey(keyId: string, secret: string): Promise<PrincipalRecord | undefined> {
    const db = this.database.db;
    const key = await db.selectFrom('api_keys').selectAll().where('id', '=', keyId).executeTakeFirst();
    if (!key || key.revoked_at !== null) return undefined;
    if (key.secret_hash !== hashString(secret)) return undefined;
    const apiUser = await db.selectFrom('api_users').selectAll().where('id', '=', key.api_user_id).executeTakeFirst();
    if (!apiUser || !apiUser.is_active) return undefined;
    await db.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', keyId).execute();
    const roles = Array.isArray(apiUser.assigned_role_ids) ? (apiUser.assigned_role_ids as string[]) : [];
    if (roles.includes('sysAdmin')) {
      return { userId: apiUser.id, userName: apiUser.user_name, userType: 'admin', roles, teams: [] };
    }
    return { userId: apiUser.id, userName: apiUser.user_name, userType: 'api', roles, teams: [] };
  }

  async principalFromUser(userId: string, sessionId?: string): Promise<PrincipalRecord> {
    const db = this.database.db;
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || !user.is_active || user.is_deleted) {
      throw new AuthenticationFailedError('User is not active.');
    }
    if (sessionId) {
      const session = await db
        .selectFrom('user_sessions')
        .select(['revoked_at'])
        .where('id', '=', sessionId)
        .executeTakeFirst();
      if (!session || session.revoked_at !== null) {
        throw new AuthenticationFailedError('Session has been revoked.');
      }
      await db.updateTable('user_sessions').set({ last_access_at: new Date() }).where('id', '=', sessionId).execute();
    }
    const directRoles = Array.isArray(user.assigned_role_ids) ? (user.assigned_role_ids as string[]) : [];
    const teamRows = await db.selectFrom('users_teams').select('team_id').where('user_id', '=', user.id).execute();
    const teams = teamRows.map((r) => r.team_id);
    const teamRoleRows = await db
      .selectFrom('teams_roles')
      .select('role_id')
      .where('team_id', 'in', teams.length > 0 ? teams : ['__none__'])
      .execute();
    const roles = Array.from(new Set([...directRoles, ...teamRoleRows.map((r) => r.role_id)]));
    const userType: PrincipalRecord['userType'] =
      user.type === 'admin' || user.is_admin ? 'admin' : user.type;
    // Portal linkage travels with the principal so the portal ACL policy never re-reads the user
    // row and an internal role list can never be grafted onto a portal session.
    const portal = user.type === 'portal';
    return {
      userId: user.id,
      userName: user.user_name,
      userType,
      roles,
      teams,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(portal ? { portalId: user.portal_id ?? undefined } : {}),
      ...(portal ? { contactId: user.contact_id ?? undefined } : {}),
      ...(user.locale ? { locale: user.locale } : {}),
      ...(user.timezone ? { timezone: user.timezone } : {}),
    };
  }

  /**
   * Phase 7A (PLAN §41.5) + the profile page: a user edits their own preferences and contact
   * details here — never through the admin identity endpoints. `null` clears a value back to the
   * instance default (PLAN §41.6) or to no avatar.
   */
  async updatePreferences(userId: string, patch: ProfilePatch): Promise<void> {
    const db = this.database.db;
    if (patch.avatarId) {
      // The avatar is served straight to an <img>, so only a file this user uploaded may be named.
      const owned = await db
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', patch.avatarId)
        .where('created_by_id', '=', userId)
        .executeTakeFirst();
      if (!owned) throw new ValidationError('Avatar must be a file you uploaded yourself.');
    }
    await db
      .updateTable('users')
      .set({
        ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.firstName !== undefined ? { first_name: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { last_name: patch.lastName } : {}),
        ...(patch.emailAddress !== undefined ? { email_address: patch.emailAddress } : {}),
        ...(patch.phoneNumber !== undefined ? { phone: patch.phoneNumber } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.avatarId !== undefined ? { avatar_id: patch.avatarId } : {}),
        modified_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();
  }

  /**
   * The columns the profile page shows; authority (roles/teams) comes from the principal.
   * Null for a principal that is not a `users` row — an API-key session has no profile.
   */
  async profile(userId: string): Promise<ProfileDto | null> {
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'user_name', 'first_name', 'last_name', 'email_address', 'phone', 'title', 'avatar_id', 'totp_enabled'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) return null;
    return {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.user_name,
      emailAddress: user.email_address,
      phoneNumber: user.phone,
      title: user.title,
      avatarId: user.avatar_id,
      twoFactorEnabled: user.totp_enabled,
    };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) {
      throw new ValidationError('Password must be at least 8 characters.');
    }
    const db = this.database.db;
    const user = await db.selectFrom('users').select(['password']).where('id', '=', userId).executeTakeFirst();
    if (!user?.password) throw new RecordNotFoundError('User', userId);
    const ok = await argon2.verify(user.password, oldPassword);
    if (!ok) throw new AuthenticationFailedError('Current password is incorrect.');
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await db.updateTable('users').set({ password: hash, modified_at: new Date() }).where('id', '=', userId).execute();
    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) {
      throw new ValidationError('Password must be at least 8 characters.');
    }
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.database.db.updateTable('users').set({ password: hash, modified_at: new Date() }).where('id', '=', userId).execute();
  }
}
