import { AuthorizationDeniedError, ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { I18nService } from '../i18n/i18n.service.js';
import { Public } from './auth.guard.js';
import type { AuthTokens, PrincipalRecord } from './auth.service.js';
import { AuthService } from './auth.service.js';

const LoginSchema = z.object({
  userName: z.string().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const LogoutSchema = z.object({
  refreshToken: z.string().optional(),
});

/** §4.9: the second factor that finishes a sign-in the password started. */
const ChallengeSchema = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().min(4).max(64),
});

const TotpCodeSchema = z.object({
  code: z.string().min(4).max(64),
});

export interface LoginResult extends AuthTokens {
  userId: string;
  portalId: string | null;
  role: string[];
  type: string;
  csrfToken: string;
}

/** §4.9: what the API answers when the password matched but 2FA still stands in the way. */
export interface LoginChallengeResult {
  challengeId: string;
}

const ProfileSchema = z.object({
  locale: z.string().min(2).nullable().optional(),
  timezone: z.string().min(1).max(64).nullable().optional(),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  emailAddress: z.string().email().max(255).nullable().optional(),
  phoneNumber: z.string().max(64).nullable().optional(),
  title: z.string().max(128).nullable().optional(),
  avatarId: z.string().max(36).nullable().optional(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});

@ApiTags('authentication')
@Controller('api/v1')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(I18nService) private readonly i18n: I18nService,
  ) {}

  @Public()
  @Post('Authentication')
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResult | LoginChallengeResult> {
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid login payload.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    const outcome = await this.auth.login(parsed.data.userName, parsed.data.password, request.ip);
    if (outcome.kind === 'challenge') {
      // §4.9: no cookies yet — the second factor still stands between the password and the session.
      return { challengeId: outcome.challengeId };
    }
    return this.respond(outcome.tokens, request, reply);
  }

  /** §4.9: finish the sign-in the password started, with a TOTP code or a recovery code. */
  @Public()
  @HttpCode(200)
  @Post('Authentication/challenge')
  async completeChallenge(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResult> {
    const parsed = ChallengeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid two-factor challenge payload.', {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const tokens = await this.auth.verifyChallenge(parsed.data.challengeId, parsed.data.code, request.ip);
    return this.respond(tokens, request, reply);
  }

  @Public()
  @Post('Refresh')
  async refresh(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ): Promise<LoginResult> {
    const parsed = RefreshSchema.safeParse(body);
    let tokens: AuthTokens;
    if (parsed.success) {
      tokens = await this.auth.refresh(parsed.data.refreshToken);
    } else {
      const cookies = parseCookies(request.headers.cookie ?? '');
      const refreshToken = cookies['CRM-REFRESH'];
      if (!refreshToken) throw new ValidationError('Missing refresh token.');
      tokens = await this.auth.refresh(refreshToken);
    }
    return this.respond(tokens, request, reply);
  }

  @Post('Logout')
  async logout(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: boolean }> {
    const parsed = LogoutSchema.safeParse(body ?? {});
    const refreshToken = parsed.success ? parsed.data.refreshToken : undefined;
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    await this.auth.logout(token, refreshToken ?? parseCookies(request.headers.cookie ?? '')['CRM-REFRESH']);
    reply.header('set-cookie', [
      'CRM-SESSION=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'CRM-REFRESH=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'CRM-CSRF=; Path=/; SameSite=Lax; Max-Age=0',
    ]);
    return { status: true };
  }

  @Get('AppUser/me')
  async me(@Query('view') view?: string): Promise<unknown> {
    void view;
    return this.profileResponse(this.scope.requirePrincipal());
  }

  /**
   * Phase 7A (PLAN §41.5/§41.6) and the profile page: the signed-in user edits their own language,
   * timezone, name, contact details and avatar here — never through the admin identity endpoints.
   * A locale outside the instance's enabled list is rejected (§41.5); a timezone must be a valid
   * IANA name; an avatar must be a file this user uploaded.
   */
  @Patch('AppUser/me')
  async updateProfile(@Body() body: unknown): Promise<unknown> {
    const principal = this.scope.requirePrincipal();
    const parsed = ProfileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid profile payload.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const settings = await this.i18n.settings();
    if (parsed.data.locale !== undefined && parsed.data.locale !== null && !settings.enabledLocales.includes(parsed.data.locale)) {
      throw new ValidationError(`Locale "${parsed.data.locale}" is not enabled on this instance.`, { enabledLocales: settings.enabledLocales });
    }
    if (parsed.data.timezone !== undefined && parsed.data.timezone !== null) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: parsed.data.timezone });
      } catch {
        throw new ValidationError(`Unknown time zone "${parsed.data.timezone}".`, { timezone: parsed.data.timezone });
      }
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new ValidationError('Nothing to update: provide at least one profile field.');
    }
    await this.auth.updatePreferences(principal.userId, parsed.data);
    return this.profileResponse(await this.auth.principalFromUser(principal.userId, principal.sessionId));
  }

  /**
   * Changing one's own password. `changePassword` revokes every active session of this user, so the
   * client signs out and logs in again with the new credentials.
   */
  @HttpCode(200)
  @Post('AppUser/me/password')
  async changePassword(@Body() body: unknown): Promise<{ status: boolean }> {
    const principal = this.scope.requirePrincipal();
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid password payload.', { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    await this.auth.changePassword(principal.userId, parsed.data.currentPassword, parsed.data.newPassword);
    return { status: true };
  }

  /**
   * §4.9 enrollment: hand out a pending secret. Nothing is enforced until `enable` sees a code it
   * produced, so an abandoned setup cannot lock the account.
   */
  @HttpCode(200)
  @Post('AppUser/me/totp/setup')
  beginTotpSetup(): Promise<{ secret: string; otpauthUri: string }> {
    return this.auth.beginTotpSetup(this.scope.requirePrincipal().userId);
  }

  /** Confirm the authenticator with a live code and receive the one-time recovery codes. */
  @HttpCode(200)
  @Post('AppUser/me/totp/enable')
  async enableTotp(@Body() body: unknown): Promise<{ recoveryCodes: string[] }> {
    const principal = this.scope.requirePrincipal();
    const parsed = TotpCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('An authenticator code is required.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    return { recoveryCodes: await this.auth.enableTotp(principal.userId, parsed.data.code) };
  }

  /** Turning 2FA off requires a current factor — never a silent security downgrade. */
  @HttpCode(200)
  @Post('AppUser/me/totp/disable')
  async disableTotp(@Body() body: unknown): Promise<{ status: boolean }> {
    const principal = this.scope.requirePrincipal();
    const parsed = TotpCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('An authenticator code is required.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    await this.auth.disableTotp(principal.userId, parsed.data.code);
    return { status: true };
  }

  /** Burn the remaining recovery codes and issue a fresh set. */
  @HttpCode(200)
  @Post('AppUser/me/totp/recovery-codes')
  async regenerateRecoveryCodes(@Body() body: unknown): Promise<{ recoveryCodes: string[] }> {
    const principal = this.scope.requirePrincipal();
    const parsed = TotpCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('An authenticator code is required.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    return { recoveryCodes: await this.auth.regenerateRecoveryCodes(principal.userId, parsed.data.code) };
  }

  /**
   * §4.9 help-desk path: an administrator clears a second factor the user lost. The user enrolls
   * again from their profile; nothing else about the account changes.
   */
  @HttpCode(200)
  @Post('User/:id/totp-reset')
  async resetUserTotp(@Param('id') id: string): Promise<{ status: boolean }> {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError('Administrator access required.');
    }
    await this.auth.adminResetTotp(id);
    return { status: true };
  }

  @Get('AppUser/current')
  async current(@Query('view') view?: string): Promise<unknown> {
    void view;
    const principal = this.scope.requirePrincipal();
    return {
      id: principal.userId,
      userName: principal.userName,
      type: principal.userType,
      roles: principal.roles,
      teams: principal.teams,
    };
  }

  /**
   * `GET /AppUser/me` and the profile patch answer with one shape: the authority fields of the
   * principal plus the user's own profile columns (absent for an API-key session, which has none).
   */
  private async profileResponse(principal: PrincipalRecord): Promise<Record<string, unknown>> {
    return {
      ...(await this.auth.profile(principal.userId)),
      id: principal.userId,
      userName: principal.userName,
      type: principal.userType,
      roles: principal.roles,
      teams: principal.teams,
      locale: principal.locale ?? null,
      timezone: principal.timezone ?? null,
    };
  }

  private async respond(tokens: AuthTokens, request: FastifyRequest, reply: FastifyReply): Promise<LoginResult> {
    const principal = await this.auth.principalFromUser((await this.auth.verifyAccessToken(tokens.accessToken)).sub as string);
    const csrf = randomCsrf();
    const secure = request.headers['x-forwarded-proto'] === 'https';
    const cookies = [
      `CRM-SESSION=${tokens.accessToken}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${tokens.expiresIn}`,
      `CRM-REFRESH=${tokens.refreshToken}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=1209600`,
      `CRM-CSRF=${csrf}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`,
    ];
    reply.header('set-cookie', cookies);
    return {
      ...tokens,
      userId: principal.userId,
      portalId: principal.portalId ?? null,
      role: principal.roles,
      type: principal.userType,
      csrfToken: csrf,
    };
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function randomCsrf(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
