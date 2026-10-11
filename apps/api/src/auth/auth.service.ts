import { createHash, randomBytes,randomUUID } from 'node:crypto';

import { AuthenticationFailedError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { hashString } from '@carocrm/core/utils/id.js';
import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { jwtVerify,SignJWT } from 'jose';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface PrincipalRecord {
  userId: string;
  userName: string;
  userType: 'admin' | 'regular' | 'api' | 'portal' | 'system';
  roles: string[];
  teams: string[];
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

  async login(userName: string, password: string, ip?: string): Promise<AuthTokens> {
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
    return this.createSession(user.id, user.type === 'admin' || user.is_admin ? 'admin' : user.type, ip);
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
    return new SignJWT({ typ: claims.typ, scope: claims.scope, ...(claims.keyId !== undefined ? { keyId: claims.keyId } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.secretKey);
  }

  async verifyAccessToken(token: string): Promise<Record<string, string>> {
    const { payload } = await jwtVerify(token, this.secretKey);
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
    return { userId: user.id, userName: user.user_name, userType, roles, teams, ...(sessionId !== undefined ? { sessionId } : {}) };
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
