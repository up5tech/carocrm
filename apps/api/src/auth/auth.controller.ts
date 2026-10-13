import { ValidationError } from '@carocrm/core/errors/index.js';
import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { Public } from './auth.guard.js';
import type { AuthTokens } from './auth.service.js';
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

export interface LoginResult extends AuthTokens {
  userId: string;
  portalId: string | null;
  role: string[];
  type: string;
  csrfToken: string;
}

@ApiTags('authentication')
@Controller('api/v1')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  @Public()
  @Post('Authentication')
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResult> {
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid login payload.', { issues: parsed.error.issues.map((i) => i.message) });
    }
    const tokens = await this.auth.login(parsed.data.userName, parsed.data.password, request.ip);
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
    const principal = this.scope.requirePrincipal();
    return {
      id: principal.userId,
      userName: principal.userName,
      type: principal.userType,
      roles: principal.roles,
      teams: principal.teams,
    };
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
