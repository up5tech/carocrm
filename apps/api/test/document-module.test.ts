import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiContext,authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/**
 * Kernel `document` module — `DocumentTemplate` records, the default-template rule and render preview.
 *
 * Runs against the configured primary database (AGENTS.md §3.1) through the real HTTP API. Every row
 * carries an `AGENT_TEST_<runId>` marker and is deleted by its own id in `cleanup()`; nothing broad is
 * deleted. The preview assertions double as the contract the Sales `send` command (19-S.7) will rely
 * on: a placeholder the data cannot answer is reported, never blanked.
 */

type Method = 'GET' | 'POST' | 'PATCH';

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

let ctx: ApiContext;
let runId: string;
let created = 0;

const templateIds: string[] = [];
const cleanupUsers: string[] = [];
const cleanupRoles: string[] = [];

async function call(method: Method, url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** The specific reason behind a rejected request (the generic face is localized away). */
function reasonOf(result: CallResult): string {
  const error = result.body['error'] as { message?: string; details?: Record<string, unknown> } | undefined;
  return String(error?.details?.['reason'] ?? error?.message ?? '');
}

function nextCode(): string {
  created += 1;
  return `agentTest${runId}${String(created)}`;
}

async function createTemplate(overrides: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await call('POST', '/api/v1/DocumentTemplate', {
    name: `AGENT_TEST_${runId} Template`,
    code: nextCode(),
    entityType: 'Quote',
    subject: 'Quote {{number}}',
    body: 'Hello {{name}}',
    ...overrides,
  });
  if (result.status === 201) templateIds.push(String(result.body['id']));
  return result;
}

beforeAll(async () => {
  runId = `dc${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`;
  ctx = await bootApi();
}, 120_000);

afterAll(async () => {
  if (templateIds.length > 0) {
    await ctx.database.db.deleteFrom('audit_log').where('entity_type', '=', 'DocumentTemplate').where('record_id', 'in', templateIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', templateIds).execute().catch(() => undefined);
  }
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  for (const id of cleanupRoles) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute().catch(() => undefined);
  }
  await purgeEntityEvents(ctx.database, ['DocumentTemplate']);
  await shutdownApi();
}, 120_000);

describe('document templates', () => {
  it('creates a template with the documented defaults', async () => {
    const result = await createTemplate();
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const template = result.body;
    expect(template['code']).toMatch(/^agentTest/);
    expect(template['targetEntity']).toBe('Quote');
    expect(template['subject']).toBe('Quote {{number}}');
    expect(template['body']).toBe('Hello {{name}}');
    // Defaults from the CreateDocumentTemplateSchema, not from the caller.
    expect(template['format']).toBe('html');
    expect(template['active']).toBe(true);
    expect(template['isDefault']).toBe(false);
  });

  it('refuses a second template with the same code', async () => {
    const first = await createTemplate();
    expect(first.status).toBe(201);
    const again = await createTemplate({ code: first.body['code'] });
    expect(again.status).toBe(422);
    expect(reasonOf(again)).toMatch(/already exists/);
  });

  it('refuses an unknown field instead of storing it', async () => {
    const result = await createTemplate({ bogus: 'x' });
    expect(result.status).toBe(400);
    expect((result.body['error'] as { code?: string }).code).toBe('INVALID_QUERY');
  });

  it('lists templates and filters them by entity type', async () => {
    const quote = await createTemplate();
    const order = await createTemplate({ entityType: 'SalesOrder' });
    expect(quote.status).toBe(201);
    expect(order.status).toBe(201);

    const all = await call('GET', '/api/v1/DocumentTemplate');
    expect(all.status).toBe(200);
    const listed = (all.body['list'] as Record<string, unknown>[]).map((row) => row['code']);
    expect(listed).toContain(quote.body['code']);
    expect(listed).toContain(order.body['code']);

    const filtered = await call('GET', '/api/v1/DocumentTemplate?entityType=SalesOrder');
    expect(filtered.status).toBe(200);
    const codes = (filtered.body['list'] as Record<string, unknown>[]).map((row) => row['code']);
    expect(codes).toContain(order.body['code']);
    expect(codes).not.toContain(quote.body['code']);
  });

  it('patches a template and refuses an unknown id', async () => {
    const template = await createTemplate();
    expect(template.status).toBe(201);
    const id = String(template.body['id']);

    const patched = await call('PATCH', `/api/v1/DocumentTemplate/${id}`, { subject: 'Invoice {{number}}', body: 'Regards, {{name}}' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body['subject']).toBe('Invoice {{number}}');
    expect(patched.body['body']).toBe('Regards, {{name}}');

    const missing = await call('PATCH', '/api/v1/DocumentTemplate/agent_test_missing_id', { subject: 'x' });
    expect(missing.status).toBe(404);
  });
});

describe('render preview', () => {
  it('resolves placeholders and repeats an #each block with element scoping', async () => {
    const created = await createTemplate({
      subject: 'Quote {{number}} for {{name}}',
      body: 'Hello {{name}}{{#each lines}}\n- {{label}} at {{price}}{{/each}}',
    });
    expect(created.status).toBe(201);

    const result = await call('POST', '/api/v1/document/action/preview', {
      templateCode: created.body['code'],
      data: {
        name: 'Acme',
        number: 'Q-0001',
        lines: [
          { label: 'Widget', price: '10.00' },
          { label: 'Sprocket', price: '5.50' },
        ],
      },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body['subject']).toBe('Quote Q-0001 for Acme');
    expect(result.body['body']).toBe('Hello Acme\n- Widget at 10.00\n- Sprocket at 5.50');
    expect(result.body['warnings']).toEqual([]);
    expect(result.body['format']).toBe('html');
    expect(result.body['templateCode']).toBe(created.body['code']);
  });

  it('escapes an HTML placeholder and leaves an unresolved one in place, with a warning', async () => {
    const created = await createTemplate({ subject: 'Quote {{missing}}', body: 'Dear {{name}}, ref {{missing}}' });
    expect(created.status).toBe(201);

    const result = await call('POST', '/api/v1/document/action/preview', {
      templateCode: created.body['code'],
      data: { name: '<b>Acme</b>' },
    });
    expect(result.status).toBe(200);
    expect(result.body['body']).toBe('Dear &lt;b&gt;Acme&lt;/b&gt;, ref {{missing}}');
    // The unresolved placeholder is dropped from the subject (never sent as "Quote {{missing}}")
    // and reported; the static part of the line stays. Same rule as the package's own subject test.
    expect(result.body['subject']).toBe('Quote');
    const warnings = result.body['warnings'] as string[];
    expect(warnings.some((warning) => warning.includes('{{missing}}'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('subject line'))).toBe(true);
  });

  it('substitutes a raw placeholder without escaping', async () => {
    const created = await createTemplate({ format: 'text', body: '{{{name}}}' });
    expect(created.status).toBe(201);

    const result = await call('POST', '/api/v1/document/action/preview', {
      templateCode: created.body['code'],
      data: { name: '<b>Acme</b>' },
    });
    expect(result.status).toBe(200);
    expect(result.body['body']).toBe('<b>Acme</b>');
    expect(result.body['format']).toBe('text');
  });

  it('refuses to preview an inactive template', async () => {
    const created = await createTemplate({ active: false });
    expect(created.status).toBe(201);

    const result = await call('POST', '/api/v1/document/action/preview', { templateCode: created.body['code'], data: { name: 'Acme' } });
    expect(result.status).toBe(422);
    expect(reasonOf(result)).toMatch(/inactive/);
  });

  it('refuses a preview to a non-administrator', async () => {
    const roleId = `docReader${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST doc reader ${runId}`,
      permissions: { DocumentTemplate: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
    });
    cleanupRoles.push(roleId);
    const reader = await createTestUser(ctx, { userName: `doc-reader-${runId}`, roleIds: [roleId] });
    cleanupUsers.push(reader.id);

    const created = await createTemplate();
    expect(created.status).toBe(201);

    const denied = await call('POST', '/api/v1/document/action/preview', { templateCode: created.body['code'], data: { name: 'Acme' } }, reader.token);
    expect(denied.status).toBe(403);
  });
});

describe('default template selection', () => {
  it('returns the active template when none is marked default', async () => {
    // 19-S.17 registers a default template for every Sales document kind, so the "no default is
    // marked" case has to be exercised on an entity none of those defaults cover.
    const active = await createTemplate({ entityType: 'Opportunity' });
    const inactive = await createTemplate({ entityType: 'Opportunity', active: false });
    expect(active.status).toBe(201);
    expect(inactive.status).toBe(201);

    const result = await call('GET', '/api/v1/document/defaultTemplate?entityType=Opportunity');
    expect(result.status).toBe(200);
    expect(result.body['code']).toBe(active.body['code']);
  });

  it('prefers the template marked default, and a new default replaces the old one', async () => {
    const first = await createTemplate({ entityType: 'DeliveryNote', isDefault: true });
    const second = await createTemplate({ entityType: 'DeliveryNote' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const chosen = await call('GET', '/api/v1/document/defaultTemplate?entityType=DeliveryNote');
    expect(chosen.body['code']).toBe(first.body['code']);

    // "The default" must be unambiguous: marking a second one clears the first.
    const third = await createTemplate({ entityType: 'DeliveryNote', isDefault: true });
    expect(third.status).toBe(201);
    const replaced = await call('GET', '/api/v1/document/defaultTemplate?entityType=DeliveryNote');
    expect(replaced.body['code']).toBe(third.body['code']);

    const previous = await call('GET', `/api/v1/DocumentTemplate/${String(first.body['id'])}`);
    expect(previous.status).toBe(200);
    expect(previous.body['isDefault']).toBe(false);
  });
});

describe('field-level access to the template body', () => {
  it('strips the body from a reader whose role denies the field, and shows it to an administrator', async () => {
    const roleId = `docBodyLock${runId}`;
    await createTestRole(ctx, {
      id: roleId,
      name: `AGENT_TEST doc body lock ${runId}`,
      permissions: { DocumentTemplate: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
      fieldPermissions: { DocumentTemplate: { body: { read: 'no', edit: 'no' } } },
    });
    cleanupRoles.push(roleId);
    const reader = await createTestUser(ctx, { userName: `doc-locked-${runId}`, roleIds: [roleId] });
    cleanupUsers.push(reader.id);

    const created = await createTemplate({ body: 'Secret template source' });
    expect(created.status).toBe(201);
    const code = String(created.body['code']);

    // Read the record itself: with the Sales defaults registered (19-S.17) a bounded list no longer
    // reliably contains a row this suite just created, and the assertion is about the field, not about
    // which page it landed on.
    const templateId = String(created.body['id']);
    const asReader = await call('GET', `/api/v1/DocumentTemplate/${templateId}`, undefined, reader.token);
    expect(asReader.status).toBe(200);
    expect(asReader.body['code']).toBe(code);
    expect(asReader.body).not.toHaveProperty('body');
    // The protected field is not the only field: the template is still readable.
    expect(asReader.body).toHaveProperty('name');

    const asAdmin = await call('GET', `/api/v1/DocumentTemplate/${templateId}`);
    expect(asAdmin.body).toHaveProperty('body', 'Secret template source');
  });
});
