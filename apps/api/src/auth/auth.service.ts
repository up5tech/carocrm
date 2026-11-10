import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { AuthenticationFailedError, AuthenticationRequiredError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { hashString } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import ipaddr from 'ipaddr.js';
import { errors as joseErrors, type JWTPayload, jwtVerify, SignJWT } from 'jose';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import { assertPasswordPolicy, mfaRequiredFor, readSecurityPolicy } from './security-policy.js';
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
  /** Phase 23.2: the server-side session this token belongs to, when there is one. */
  sessionId?: string | undefined;
  /** Phase 23.2: the session may only enroll TOTP until the instance MFA policy is satisfied. */
  mfaPending?: boolean | undefined;
  /** Phase 23.2 (PLAN §17.2): the presenting API key's scope restriction; undefined = unrestricted. */
  keyScopes?: readonly string[] | undefined;
  /** Phase 23.2 (PLAN §17.2): the id of the API key that authenticated this principal. */
  keyId?: string | undefined;
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
    const subjectHash = this.accountFailureKey(userName);
    // Phase 23.2 (PLAN §8 task 1): per-account lockout, derived from the bounded failed-login history.
    const lockedUntil = await this.lockoutUntil(subjectHash);
    if (lockedUntil !== null && lockedUntil.getTime() > Date.now()) {
      // The same authentication outcome as a wrong password: a locked account is never named, so the
      // refusal cannot be used to enumerate accounts (PLAN §0.1 evidence-over-assumption).
      throw new AuthenticationFailedError();
    }
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('user_name', '=', userName)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!user || !user.is_active || !user.password) {
      await this.recordFailure(subjectHash);
      throw new AuthenticationFailedError();
    }
    let ok = false;
    try {
      ok = await argon2.verify(user.password, password);
    } catch {
      ok = false;
    }
    if (!ok) {
      await this.recordFailure(subjectHash);
      throw new AuthenticationFailedError();
    }
    await this.clearFailures(subjectHash);
    const userType = user.type === 'admin' || user.is_admin ? 'admin' : user.type;
    if (user.totp_enabled && user.totp_secret) {
      // §4.9: the password was only the first factor — the session is issued by the challenge.
      return { kind: 'challenge', challengeId: await this.createChallenge(user.id) };
    }
    // Phase 23.2 (PLAN §8 task 3): when the instance requires MFA and the account has not enrolled,
    // the password opens an enrollment-only session, never a usable one. The guard restricts it to
    // the TOTP setup/enable routes until the factor is confirmed.
    const policy = await readSecurityPolicy(db);
    const mfaPending = mfaRequiredFor(policy, user);
    return { kind: 'ok', tokens: await this.createSession(user.id, userType, ip, { mfaPending }) };
  }

  /**
   * Phase 23.2 (PLAN §8 task 1): the bucket key of one account — SHA-256 over the normalized user name,
   * so counters are keyed without ever storing a raw account value.
   */
  private accountFailureKey(userName: string): string {
    return createHash('sha256').update(userName.trim().toLowerCase()).digest('hex');
  }

  /**
   * Phase 23.2 (PLAN §8 task 1): when the account must be locked, derived from the failed-login rows of
   * the trailing auth window (`authRateLimitWindowSeconds`): `loginLockoutThreshold` failures inside the
   * window end in a lockout of `loginLockoutSeconds`. `null` while the account is still inside its budget.
   */
  private async lockoutUntil(subjectHash: string): Promise<Date | null> {
    const db = this.database.db;
    const windowStart = new Date(Date.now() - this.config.authRateLimitWindowSeconds * 1000);
    const failures = await db
      .selectFrom('auth_login_attempts')
      .select('failed_at')
      .where('subject_hash', '=', subjectHash)
      .where('failed_at', '>=', windowStart)
      .orderBy('failed_at', 'desc')
      .execute();
    const lastFailureAt = failures[0]?.failed_at;
    if (lastFailureAt === undefined) return null;
    if (failures.length < this.config.loginLockoutThreshold) return null;
    return new Date(lastFailureAt.getTime() + this.config.loginLockoutSeconds * 1000);
  }

  /** Phase 23.2 (PLAN §8 task 1): one failed sign-in, then drop the failure rows older than the policy retention. */
  private async recordFailure(subjectHash: string): Promise<void> {
    const db = this.database.db;
    await db.insertInto('auth_login_attempts').values({ subject_hash: subjectHash, failed_at: new Date() }).execute();
    const retentionCutoff = new Date(Date.now() - (this.config.authRateLimitWindowSeconds + this.config.loginLockoutSeconds) * 1000);
    await db.deleteFrom('auth_login_attempts').where('failed_at', '<', retentionCutoff).execute();
  }

  /** Phase 23.2 (PLAN §8 task 1): a successful sign-in clears the account's failure history. */
  private async clearFailures(subjectHash: string): Promise<void> {
    await this.database.db.deleteFrom('auth_login_attempts').where('subject_hash', '=', subjectHash).execute();
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
    return this.createSession(user.id, user.type === 'admin' || user.is_admin ? 'admin' : user.type, ip, { twoFactorVerified: true });
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
  async enableTotp(userId: string, code: string, sessionId?: string): Promise<string[]> {
    const db = this.database.db;
    if (!(await this.totpCodeOk(userId, code, false))) {
      throw new AuthenticationFailedError('That code does not match the authenticator.');
    }
    await db
      .updateTable('users')
      .set({ totp_enabled: true, totp_confirmed_at: new Date(), modified_at: new Date() })
      .where('id', '=', userId)
      .execute();
    // Phase 23.2 (PLAN §8 task 3): the second factor is bound to the session. The enrolling session
    // proved the factor with the code above; every other session that never completed a second
    // factor ends here, so enabling 2FA cannot leave password-only sessions alive.
    if (sessionId !== undefined) {
      await db
        .updateTable('user_sessions')
        .set({ two_factor_verified: true, mfa_pending: false, modified_at: new Date() })
        .where('id', '=', sessionId)
        .where('user_id', '=', userId)
        .execute();
    }
    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'mfa-enrolled' })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('two_factor_verified', '=', false)
      .execute();
    return this.replaceRecoveryCodes(userId);
  }

  /** §4.9: turning the second factor off requires a current factor — never a silent downgrade. */
  async disableTotp(userId: string, code: string): Promise<void> {
    if (!(await this.totpCodeOk(userId, code, true))) {
      throw new AuthenticationFailedError('That code is not valid.');
    }
    const db = this.database.db;
    // Phase 23.2: an account covered by the instance MFA policy cannot opt out below it; the
    // administrator reset path remains the deliberate escape hatch.
    const user = await db.selectFrom('users').select(['type', 'is_admin']).where('id', '=', userId).executeTakeFirst();
    if (user && mfaRequiredFor(await readSecurityPolicy(db), user)) {
      throw new ValidationError('Two-factor authentication is required by the instance policy and cannot be turned off here.');
    }
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

  /**
   * Phase 23.2 (PLAN §8 tasks 3–4): a session carries its rotation family, sign-in source and
   * second-factor state. A fresh sign-in starts a new family and honours the single-session policy;
   * a rotation (familyId given) continues the existing one and never extends the absolute expiry.
   */
  async createSession(
    userId: string,
    userType: PrincipalRecord['userType'],
    ip?: string,
    opts: { familyId?: string; twoFactorVerified?: boolean; mfaPending?: boolean; expiresAt?: Date } = {},
  ): Promise<AuthTokens> {
    const db = this.database.db;
    const sessionId = randomUUID();
    const refreshToken = randomBytes(32).toString('hex');
    const user = await db.selectFrom('users').select(['user_name']).where('id', '=', userId).executeTakeFirst();
    if (!user) throw new RecordNotFoundError('User', userId);

    const isRotation = opts.familyId !== undefined;
    if (!isRotation) {
      const policy = await readSecurityPolicy(db);
      if (policy.session.singleSession) {
        await db
          .updateTable('user_sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'single-session' })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();
      }
    }

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
        expired_at: opts.expiresAt ?? new Date(Date.now() + this.config.refreshTokenTtlSeconds * 1000),
        family_id: opts.familyId ?? randomUUID(),
        ip_address: ip ?? null,
        two_factor_verified: opts.twoFactorVerified ?? false,
        mfa_pending: opts.mfaPending ?? false,
        revoked_reason: null,
      })
      .execute();

    const accessToken = await this.signAccessToken({
      sub: userId,
      sid: sessionId,
      typ: 'access',
      scope: 'user',
    });
    return { accessToken, refreshToken, expiresIn: this.config.accessTokenTtlSeconds };
  }

  async refresh(refreshToken: string, ip?: string): Promise<AuthTokens> {
    const db = this.database.db;
    const hashed = hashString(refreshToken);
    const session = await db
      .selectFrom('user_sessions')
      .selectAll()
      .where('refresh_token', '=', hashed)
      .executeTakeFirst();
    if (!session) {
      throw new AuthenticationFailedError('Session is invalid or expired.');
    }
    if (session.revoked_at !== null) {
      // Reuse detection: a token that was already rotated must never work again. Presenting one
      // means the chain leaked, so the whole family is revoked — the legitimate holder signs in
      // again, and the replayed copy dies with it. Logout/password revocations are not replays.
      if (session.revoked_reason === 'rotation' && session.family_id !== null) {
        await db
          .updateTable('user_sessions')
          .set({ revoked_at: new Date(), revoked_reason: 'reuse-detected' })
          .where('family_id', '=', session.family_id)
          .where('revoked_at', 'is', null)
          .execute();
      }
      throw new AuthenticationFailedError('Session is invalid or expired.');
    }
    if (session.expired_at && session.expired_at.getTime() < Date.now()) {
      throw new AuthenticationFailedError('Session is invalid or expired.');
    }
    const policy = await readSecurityPolicy(db);
    if (policy.session.idleLogoutMinutes > 0 && session.last_access_at) {
      const idleMs = policy.session.idleLogoutMinutes * 60_000;
      if (Date.now() - session.last_access_at.getTime() > idleMs) {
        await db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: 'idle-timeout' }).where('id', '=', session.id).execute();
        throw new AuthenticationFailedError('Session expired due to inactivity.');
      }
    }
    const user = await db.selectFrom('users').select(['id', 'type', 'is_admin', 'is_active', 'is_deleted'])
      .where('id', '=', session.user_id)
      .executeTakeFirst();
    if (!user || !user.is_active || user.is_deleted) {
      throw new AuthenticationFailedError();
    }
    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'rotation' })
      .where('id', '=', session.id)
      .execute();
    // Rotation keeps the family, the factor state and the absolute expiry of the original sign-in.
    return this.createSession(user.id, user.type === 'admin' || user.is_admin ? 'admin' : user.type, ip, {
      ...(session.family_id !== null ? { familyId: session.family_id } : {}),
      twoFactorVerified: session.two_factor_verified,
      mfaPending: session.mfa_pending,
      ...(session.expired_at !== null ? { expiresAt: session.expired_at } : {}),
    });
  }

  async logout(accessToken: string | undefined, refreshToken?: string): Promise<void> {
    const db = this.database.db;
    if (refreshToken) {
      await db
        .updateTable('user_sessions')
        .set({ revoked_at: new Date(), revoked_reason: 'logout' })
        .where('refresh_token', '=', hashString(refreshToken))
        .execute();
      return;
    }
    if (accessToken) {
      try {
        const payload = await this.verifyAccessToken(accessToken);
        const sid = payload.sid;
        if (typeof sid === 'string') {
          await db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: 'logout' }).where('id', '=', sid).execute();
        }
      } catch {
        // token is not valid; logging out a stale token is a no-op
      }
    }
  }

  /** Phase 23.2 (PLAN §8 task 4): the caller's own active sessions — never another account's. */
  async listSessions(userId: string): Promise<
    { id: string; createdAt: string; lastAccessAt: string | null; expiresAt: string | null; ip: string | null; twoFactorVerified: boolean; mfaPending: boolean }[]
  > {
    const rows = await this.database.db
      .selectFrom('user_sessions')
      .select(['id', 'created_at', 'last_access_at', 'expired_at', 'ip_address', 'two_factor_verified', 'mfa_pending'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastAccessAt: row.last_access_at ? row.last_access_at.toISOString() : null,
      expiresAt: row.expired_at ? row.expired_at.toISOString() : null,
      ip: row.ip_address,
      twoFactorVerified: row.two_factor_verified,
      mfaPending: row.mfa_pending,
    }));
  }

  /** Revoke one of the caller's own sessions; the ownership predicate is the authorization. */
  async revokeSession(userId: string, sessionId: string): Promise<{ success: boolean }> {
    const result = await this.database.db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'revoked' })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw new RecordNotFoundError('Session', sessionId);
    return { success: true };
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

  /**
   * Phase 23.2 (PLAN §8 task 5 / PLAN §17.2): issue a key with an optional scope restriction
   * (`read`/`write`; `write` implies `read`) and an optional source-IP allowlist (IPs or CIDRs).
   * Omitted options store NULL — the pre-23.2 unrestricted behaviour.
   */
  async issueApiKey(
    apiUserId: string,
    opts: { scopes?: readonly string[] | undefined; allowedIps?: readonly string[] | undefined } = {},
  ): Promise<{ keyId: string; secret: string }> {
    const db = this.database.db;
    const keyId = `key_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    const scopes = normalizeApiKeyScopes(opts.scopes);
    const allowedIps = normalizeApiKeyAllowedIps(opts.allowedIps);
    await db
      .insertInto('api_keys')
      .values({
        id: keyId,
        api_user_id: apiUserId,
        secret_hash: hashString(secret),
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
        scopes: scopes === null ? null : JSON.stringify(scopes),
        allowed_ips: allowedIps === null ? null : JSON.stringify(allowedIps),
      })
      .execute();
    return { keyId, secret };
  }

  async authenticateApiKey(keyId: string, secret: string, ip?: string): Promise<PrincipalRecord | undefined> {
    const db = this.database.db;
    const key = await db.selectFrom('api_keys').selectAll().where('id', '=', keyId).executeTakeFirst();
    if (!key || key.revoked_at !== null) return undefined;
    const providedHash = hashString(secret);
    if (key.secret_hash.length !== providedHash.length) return undefined;
    if (!timingSafeEqual(Buffer.from(key.secret_hash, 'utf8'), Buffer.from(providedHash, 'utf8'))) return undefined;
    // Phase 23.2 (PLAN §17.2): the optional IP restriction is checked before the key is honoured.
    // A key that names sources and is used from anywhere else simply does not authenticate — the
    // same outcome as a wrong secret, so the restriction itself is not enumerable.
    if (!apiKeyIpAllowed(key.allowed_ips, ip)) return undefined;
    const apiUser = await db.selectFrom('api_users').selectAll().where('id', '=', key.api_user_id).executeTakeFirst();
    if (!apiUser || !apiUser.is_active) return undefined;
    await db.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', keyId).execute();
    const roles = Array.isArray(apiUser.assigned_role_ids) ? (apiUser.assigned_role_ids as string[]) : [];
    const keyScopes = apiKeyScopesOf(key.scopes);
    const keyFields = { keyId, ...(keyScopes !== null ? { keyScopes } : {}) };
    if (roles.includes('sysAdmin')) {
      return { userId: apiUser.id, userName: apiUser.user_name, userType: 'admin', roles, teams: [], ...keyFields };
    }
    return { userId: apiUser.id, userName: apiUser.user_name, userType: 'api', roles, teams: [], ...keyFields };
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
    let mfaPending = false;
    if (sessionId) {
      const session = await db
        .selectFrom('user_sessions')
        .select(['revoked_at', 'expired_at', 'last_access_at', 'two_factor_verified', 'mfa_pending'])
        .where('id', '=', sessionId)
        .executeTakeFirst();
      if (!session || session.revoked_at !== null) {
        throw new AuthenticationFailedError('Session has been revoked.');
      }
      // Absolute expiry: rotation never extends the original sign-in's lifetime.
      if (session.expired_at && session.expired_at.getTime() < Date.now()) {
        throw new AuthenticationFailedError('Session is invalid or expired.');
      }
      // Phase 23.2 (PLAN §8 task 4): the idle policy is enforced on use, not only at refresh.
      const policy = await readSecurityPolicy(db);
      if (policy.session.idleLogoutMinutes > 0 && session.last_access_at) {
        const idleMs = policy.session.idleLogoutMinutes * 60_000;
        if (Date.now() - session.last_access_at.getTime() > idleMs) {
          await db.updateTable('user_sessions').set({ revoked_at: new Date(), revoked_reason: 'idle-timeout' }).where('id', '=', sessionId).execute();
          throw new AuthenticationFailedError('Session expired due to inactivity.');
        }
      }
      // Phase 23.2 (PLAN §8 task 3): the 2FA state is bound to the session — a password-only
      // session cannot serve an account whose second factor is enabled.
      if (user.totp_enabled && !session.two_factor_verified) {
        throw new AuthenticationFailedError('Session has not completed two-factor authentication.');
      }
      // The flag written at sign-in is not the whole story: the policy may have been tightened
      // since. A covered account that never enrolled is pending on every session it holds, so the
      // guard restricts it to enrollment until the factor exists — same outcome as a fresh login.
      mfaPending = session.mfa_pending || (mfaRequiredFor(policy, user) && !user.totp_enabled);
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
      ...(mfaPending ? { mfaPending: true } : {}),
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
    const db = this.database.db;
    assertPasswordPolicy(await readSecurityPolicy(db), newPassword);
    const user = await db.selectFrom('users').select(['password']).where('id', '=', userId).executeTakeFirst();
    if (!user?.password) throw new RecordNotFoundError('User', userId);
    const ok = await argon2.verify(user.password, oldPassword);
    if (!ok) throw new AuthenticationFailedError('Current password is incorrect.');
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await db.updateTable('users').set({ password: hash, modified_at: new Date() }).where('id', '=', userId).execute();
    await db
      .updateTable('user_sessions')
      .set({ revoked_at: new Date(), revoked_reason: 'password-change' })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const db = this.database.db;
    assertPasswordPolicy(await readSecurityPolicy(db), newPassword);
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await db.updateTable('users').set({ password: hash, modified_at: new Date() }).where('id', '=', userId).execute();
  }
}

/** Phase 23.2 (PLAN §17.2): the only scopes an API key may carry. `write` implies `read`. */
const API_KEY_SCOPES = new Set(['read', 'write']);

function normalizeApiKeyScopes(scopes: readonly string[] | undefined): string[] | null {
  if (scopes === undefined) return null;
  const unique = [...new Set(scopes.map((scope) => scope.trim().toLowerCase()).filter((scope) => scope !== ''))];
  const invalid = unique.filter((scope) => !API_KEY_SCOPES.has(scope));
  if (invalid.length > 0) {
    throw new ValidationError('Unknown API key scope.', { scopes: invalid, allowed: [...API_KEY_SCOPES] });
  }
  return unique.length === 0 ? null : unique;
}

function apiKeyScopesOf(value: unknown): string[] | null {
  const list = jsonStringList(value);
  return list.length === 0 ? null : list;
}

function normalizeApiKeyAllowedIps(ips: readonly string[] | undefined): string[] | null {
  if (ips === undefined) return null;
  const entries = [...new Set(ips.map((entry) => entry.trim()).filter((entry) => entry !== ''))];
  for (const entry of entries) {
    const valid = entry.includes('/') ? ipaddr.isValidCIDR(entry) : ipaddr.isValid(entry);
    if (!valid) {
      throw new ValidationError('Invalid API key IP restriction entry; use an IP address or CIDR range.', { entry });
    }
  }
  return entries.length === 0 ? null : entries;
}

function apiKeyAllowedIpsOf(value: unknown): string[] | null {
  const list = jsonStringList(value);
  return list.length === 0 ? null : list;
}

function jsonStringList(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Phase 23.2 (PLAN §17.2): whether the request's source address satisfies the key's optional IP
 * restriction. No restriction (NULL/[]) allows any source; a restricted key used from an unnamed or
 * non-matching source does not authenticate.
 */
function apiKeyIpAllowed(allowedIps: unknown, ip: string | undefined): boolean {
  const entries = apiKeyAllowedIpsOf(allowedIps);
  if (entries === null) return true;
  if (ip === undefined || ip.trim() === '') return false;
  let addr: ReturnType<typeof ipaddr.process>;
  try {
    addr = ipaddr.process(ip.trim());
  } catch {
    return false;
  }
  return entries.some((entry) => {
    try {
      if (entry.includes('/')) {
        return addr.match(ipaddr.parseCIDR(entry));
      }
      const other = ipaddr.parse(entry);
      return addr.kind() === other.kind() && addr.toNormalizedString() === other.toNormalizedString();
    } catch {
      return false;
    }
  });
}
