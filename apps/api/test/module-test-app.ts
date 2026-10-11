/**
 * Test harness for module barrels that are not wired into AppModule yet
 * (attachments, audit). Boots a throwaway Nest root module containing the
 * kernel auth providers plus the module under test, against the same
 * `.env`/carocrm_dev database as test/helper.ts — but without importing
 * src/bootstrap.ts / src/app.module.ts, so concurrently-built entity code
 * cannot break these suites.
 */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import * as multipart from '@fastify/multipart';
import type { Provider, Type } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_GUARD , NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import argon2 from 'argon2';

import { seed } from '../../../database/seed.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { GlobalExceptionFilter } from '../src/common/global-exception.filter.js';
import { REQUEST_SCOPE_TOKEN,RequestScope } from '../src/common/request-scope.js';
import type { AppConfig } from '../src/config.js';
import { buildConfig, CONFIG_TOKEN } from '../src/config.js';
import { DatabaseService } from '../src/database/database.service.js';

export const ADMIN_LOGIN = 'admin';
export const ADMIN_PASSWORD = 'admin';
export const REGULAR_PASSWORD = 'modtest123';

export interface ModuleTestContext {
  app: NestFastifyApplication;
  config: AppConfig;
  adminToken: string;
  regularToken: string;
  regularUserId: string;
  regularUserName: string;
  scope: RequestScope;
}

type FastifyPluginLike = Parameters<NestFastifyApplication['register']>[0];

function asPlugin(mod: unknown): FastifyPluginLike {
  const candidate = mod as Record<string, unknown>;
  return (candidate['default'] ?? candidate) as FastifyPluginLike;
}

export interface ModuleTestOverrides {
  providers?: Provider[];
  controllers?: readonly unknown[];
}

export async function bootModuleTestApp(overrides: ModuleTestOverrides = {}): Promise<ModuleTestContext> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

  const config = buildConfig();
  await seed(config.databaseUrl, { adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });

  const regularUserId = `modtest-${randomUUID()}`;
  const regularUserName = `modtest-${randomUUID().slice(0, 8)}`;

  class ModuleTestRootModule {}
  Module({
    controllers: [AuthController, ...(overrides.controllers ?? []) as Type<unknown>[]],
    providers: [
      { provide: CONFIG_TOKEN, useFactory: (): AppConfig => config },
      DatabaseService,
      { provide: REQUEST_SCOPE_TOKEN, useClass: RequestScope },
      AuthService,
      AuthGuard,
      { provide: APP_GUARD, useExisting: AuthGuard },
      ...(overrides.providers ?? []),
    ],
  })(ModuleTestRootModule);

  const adapter = new FastifyAdapter({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(ModuleTestRootModule, adapter, { abortOnError: true, logger: false });
  await app.register(asPlugin(multipart), { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  const db = app.get(DatabaseService).db;
  const passwordHash = await argon2.hash(REGULAR_PASSWORD, { type: argon2.argon2id });
  const now = new Date();
  await db
    .insertInto('users')
    .values({
      id: regularUserId,
      user_name: regularUserName,
      account_name: null,
      first_name: 'Module',
      last_name: 'Tester',
      email_address: null,
      is_admin: false,
      is_active: true,
      portal_types: JSON.stringify([]),
      type: 'regular',
      auth_method: 'password',
      password: passwordHash,
      assigned_role_ids: JSON.stringify(['noAccess']),
      title: null,
      phone: null,
      is_deleted: false,
      created_at: now,
      modified_at: now,
      created_by_id: null,
      modified_by_id: null,
    })
    .execute();

  const adminToken = await login(app, ADMIN_LOGIN, ADMIN_PASSWORD);
  const regularToken = await login(app, regularUserName, REGULAR_PASSWORD);
  const scope = app.get(REQUEST_SCOPE_TOKEN) as RequestScope;

  return { app, config, adminToken, regularToken, regularUserId, regularUserName, scope };
}

async function login(app: NestFastifyApplication, userName: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/Authentication', payload: { userName, password } });
  if (res.statusCode !== 201) {
    throw new Error(`module-test login failed for "${userName}": ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { accessToken: string }).accessToken;
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface MultipartPartSpec {
  name: string;
  data: string;
  filename?: string;
  contentType?: string;
}

/** Build a raw multipart/form-data payload (text fields first, then files). */
export function buildMultipart(
  parts: readonly MultipartPartSpec[],
  boundary = 'carocrmtestboundary',
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      head += `; filename="${part.filename}"`;
    }
    head += '\r\n';
    if (part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType}\r\n\r\n`;
    } else {
      head += '\r\n';
    }
    chunks.push(Buffer.from(head, 'utf8'), Buffer.from(part.data, 'utf8'), Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
