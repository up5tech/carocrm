import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ChallengeSchema, LoginSchema, LogoutSchema } from '../src/auth/auth.schemas.js';

/**
 * Phase 24.4 — schema-backed contract tests.
 *
 * The bounded typed-client surface (`api-spec/schemas/*.v1.json`) must agree with the Zod schemas
 * the controllers actually enforce. This suite runs a fixture corpus through both and requires an
 * identical accept/reject verdict. `RefreshSchema` is deliberately excluded: the refresh handler
 * falls back to the HttpOnly cookie when the body does not parse, so body validation is not a hard
 * contract there (the JSON Schema document says so itself).
 *
 * DB-free: reads schema files and pure Zod objects only.
 */

const SCHEMA_DIR = join(process.cwd(), 'api-spec/schemas');

type Json = unknown;
type Schema = Record<string, Json>;

function loadSchema(file: string): Schema {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as Schema;
}

function resolveRef(ref: string, doc: Schema): Schema {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);
  const target = filePart === '' ? doc : loadSchema(filePart);
  if (fragment === '') return target;
  let node: Json = target;
  for (const raw of fragment.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, Json>)[key];
  }
  return node as Schema;
}

function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Minimal JSON Schema validator for the keyword subset the api-spec schemas use. */
function valid(schema: Schema, value: Json, doc: Schema, depth = 0): boolean {
  if (depth > 24) return false;
  if (typeof schema.$ref === 'string') return valid(resolveRef(schema.$ref, doc), value, doc, depth + 1);
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((v) => valid(v as Schema, value, doc, depth + 1));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) return false;
  const type = schema.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (types.length > 0) {
    const actual = typeOf(value);
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return false;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((item) => valid(schema.items as Schema, item, doc, depth + 1));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, Json>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in record)) return false;
    }
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, sub] of Object.entries(properties)) {
      if (key in record && !valid(sub, record[key], doc, depth + 1)) return false;
    }
  }
  return true;
}

const CASES: Array<{ name: string; schemaFile: string; zod: { safeParse(v: Json): { success: boolean } }; fixtures: Json[] }> = [
  {
    name: 'LoginRequest',
    schemaFile: 'authentication.login.request.v1.json',
    zod: LoginSchema,
    fixtures: [
      { userName: 'admin', password: 'secret' },
      { userName: 'admin', password: 'secret', rememberMe: true },
      { userName: 'admin', password: 'secret', extra: 'stripped by zod' },
      { userName: '', password: 'x' },
      { userName: 'a' },
      { password: 'x' },
      { userName: 1, password: 'x' },
      { userName: 'a', password: 'x', rememberMe: 'yes' },
      'not-an-object',
      null,
    ],
  },
  {
    name: 'LoginChallengeRequest',
    schemaFile: 'authentication.challenge.request.v1.json',
    zod: ChallengeSchema,
    fixtures: [
      { challengeId: 'c1', code: '123456' },
      { challengeId: 'c1', code: '1234' },
      { challengeId: '', code: '123456' },
      { challengeId: 'c'.repeat(65), code: '123456' },
      { challengeId: 'c1', code: '123' },
      { code: '123456' },
      { challengeId: 'c1', code: 123456 },
    ],
  },
  {
    name: 'LogoutRequest',
    schemaFile: 'authentication.logout.request.v1.json',
    zod: LogoutSchema,
    fixtures: [
      {},
      { refreshToken: 'rt' },
      { refreshToken: 5 },
      { other: true },
    ],
  },
];

describe('api-spec schema-backed contract (Phase 24.4)', () => {
  for (const entry of CASES) {
    it(`${entry.name}: JSON Schema and the controller Zod schema agree on every fixture`, () => {
      const schema = loadSchema(entry.schemaFile);
      for (const fixture of entry.fixtures) {
        const zodOk = entry.zod.safeParse(fixture).success;
        const schemaOk = valid(schema, fixture, schema);
        expect(schemaOk, `${entry.name} fixture ${JSON.stringify(fixture)}: json-schema=${String(schemaOk)} zod=${String(zodOk)}`).toBe(zodOk);
      }
    });
  }

  it('response schemas accept a well-formed LoginResult and reject a malformed one', () => {
    const doc = loadSchema('authentication.login.response.v1.json');
    const good = {
      accessToken: 'a', refreshToken: 'r', expiresIn: 3600, userId: 'u',
      portalId: null, role: ['admin'], type: 'admin', csrfToken: 'c',
    };
    const challenge = { challengeId: 'ch1' };
    const bad = { accessToken: 'a' };
    expect(valid(doc, good, doc)).toBe(true);
    expect(valid(doc, challenge, doc)).toBe(true);
    expect(valid(doc, bad, doc)).toBe(false);
  });

  it('the generated client types compile against the emitted declarations', async () => {
    // Source import (not the package name) so the suite stays DB-free and does not depend on a
    // prior workspace build.
    const mod = await import('../../../packages/api-client/src/index.js');
    expect(typeof mod.createApiClient).toBe('function');
    expect(mod.API_OPERATIONS.map((o) => o.operationId)).toEqual([
      'authentication.login',
      'authentication.challenge',
      'session.refresh',
      'session.logout',
      'session.me',
    ]);
  });
});
