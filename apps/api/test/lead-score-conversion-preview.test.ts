import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  composeTemplate,
  ConversionSectionSchema,
  DEFAULT_CONVERSION_MAPPING,
  LeadScoreSettingsService,
  previewHash,
  typeCompatible,
  valueIssue,
} from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.12 — the field map and the side-effect-free conversion preview
 * (`PLAN_Phase_19_LeadScore.md` §5.7, §7.1–§7.4, §8.3, §11.4, §16 `19-LS.12`; audit §11 `LS.12`;
 * contract §7, §8).
 *
 * The exit criterion is *"the preview is side-effect-free and faithfully describes the operation that would
 * run"*, and the suite splits it in two:
 *
 * 1. **side-effect-free** — a preview leaves the Lead's `version` and `modifiedAt`, the record counts per
 *    entity, the audit log, the outbox and the job table exactly as they were. The service has no writer;
 *    this asserts nobody added one.
 * 2. **faithful** — the answer names the values each target would receive *and* the ones it would not
 *    (with a reason), the required values still missing, the before/after of every differing value on a
 *    linked record, and a fingerprint over the Lead revision, the mapping versions, the explicit merges and
 *    the fields this actor could see and write. A pinned revision or mapping version that no longer matches
 *    is refused with `LEADSCORE_PREVIEW_STALE` naming the component.
 *
 * The map itself is configuration that writes records, so the settings suite half asserts the refusals:
 * an unknown field, an incompatible type, a template naming a field Lead does not have, and a changed map
 * that kept its version — all `422` before anything is stored.
 *
 * `afterEach` puts the whole `leadScore` settings row back as it was before the test (the map-changing tests
 * need a clean version history, and the monotonic-version rule is one of the assertions), and `afterAll`
 * removes only what the run created.
 */

const RUN = `AGENT_TEST_LS12_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const PREVIEW_PATH = '/api/v1/LeadScore/action/conversion/preview';

let ctx: ApiContext;
let previousSettings: string | null = null;
let settingsAfterSetup = '';
let adminUserId = '';
const created = { records: [] as string[], roles: [] as string[], users: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface PreviewTarget {
  type: string;
  action: string;
  existingId: string | null;
  existing: { id: string; label: string | null } | null;
  mappingVersion: number;
  proposed: { field: string; value: unknown; origin: string }[];
  skipped: { from?: string; to?: string; reason: string }[];
  required: string[];
  conflicts: { field: string; current: unknown; proposed: unknown }[];
  notCopied: string[];
  relationship: { type: string; action: string; id: string | null }[];
}

interface Preview {
  leadId: string;
  leadRevision: number;
  targets: PreviewTarget[];
  duplicates: { candidates: { id: string }[]; hiddenMatches: number; requiresChoice: boolean } | null;
  permission: { canExecute: boolean; reasons: string[] };
  confirmationTypes: string[];
  previewHash: string;
  fingerprint: { mappingVersions: Record<string, number>; leadScope: string[]; readerScope: Record<string, string[]> };
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, token?: string): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorOf(result: CallResult): { code: string; details: Body } {
  return (result.body['error'] ?? {}) as { code: string; details: Body };
}

async function createRecord(entity: string, data: Record<string, unknown>): Promise<string> {
  const result = await call('POST', `/api/v1/${entity}`, data);
  expect(result.status, `${entity}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  const id = String(result.body['id'] ?? '');
  created.records.push(id);
  return id;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const result = await call('POST', '/api/v1/LeadScore/action/settings', patch);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

/** The settings document as stored, so a test can change the map and the next test can start clean. */
async function storedSettings(): Promise<Body> {
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  return (row?.data ?? {}) as Body;
}

async function preview(leadId: string, targets: readonly { type: string; action: string; existingId?: string }[], extra: Body = {}, token?: string): Promise<CallResult> {
  return call('POST', PREVIEW_PATH, { leadId, targets, ...extra }, token);
}

function view(result: CallResult): Preview {
  return result.body as unknown as Preview;
}

async function createLead(suffix: string, data: Record<string, unknown> = {}): Promise<string> {
  const name = `${RUN} ${suffix}`;
  return createRecord('Lead', { name, firstName: 'Probe', lastName: name, status: 'New', ...data });
}

/** The Lead every value test starts from: one of each mappable field. */
function fullLead(): Record<string, unknown> {
  return {
    firstName: `${RUN}first`,
    lastName: `${RUN}last`,
    title: 'Head of Ops',
    emailAddress: `${RUN.toLowerCase()}@example.com`,
    phoneNumber: '+84 912 345 678',
    company: `${RUN} Acme Industries`,
    industry: 'Software',
    source: 'Web Site',
    description: 'Converted by the LS.12 suite.',
  };
}

async function entityCounts(): Promise<Record<string, number>> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select((eb) => [eb.fn.countAll<string>().as('count')])
    .executeTakeFirst();
  return { records: Number(rows?.count ?? 0) };
}

async function tableCount(table: 'audit_log' | 'outbox_events' | 'jobs'): Promise<number> {
  const row = await ctx.database.db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const admin = await ctx.database.db.selectFrom('users').select('id').where('is_admin', '=', true).where('is_deleted', '=', false).limit(1).executeTakeFirst();
  adminUserId = admin?.id ?? '';

  await setSettings({
    enabled: true,
    // Only the switches this phase owns. Duplicate review is turned on in the one test that asserts the
    // preview carries candidates, so nothing else depends on the resolver.
    features: { fieldMapping: true, conversionPreview: true, duplicateDetection: false },
  });
  settingsAfterSetup = JSON.stringify(await storedSettings());
}, 240_000);

afterEach(async () => {
  // The map-changing tests need a clean version history (a changed map must raise its version, by design),
  // so the whole row — version included — goes back to the post-setup snapshot.
  await ctx.database.db
    .updateTable('app_settings')
    .set({ data: JSON.parse(settingsAfterSetup) as Body, modified_at: new Date() })
    .where('name', '=', SETTINGS_ROW)
    .execute();
  ctx.app.get(LeadScoreSettingsService, { strict: false }).invalidate();
});

afterAll(async () => {
  const db = ctx.database.db;
  if (previousSettings === null) await db.deleteFrom('app_settings').where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);
  else await db.updateTable('app_settings').set({ data: JSON.parse(previousSettings) as Body, modified_at: new Date() }).where('name', '=', SETTINGS_ROW).execute().catch(() => undefined);

  if (created.records.length > 0) {
    const linked = await db
      .selectFrom('entity_links')
      .select('id')
      .where((eb) => eb.or([eb('record_id_a', 'in', created.records), eb('record_id_b', 'in', created.records)]))
      .execute()
      .catch(() => [] as { id: string }[]);
    if (linked.length > 0) await db.deleteFrom('entity_links').where('id', 'in', linked.map((entry) => entry.id)).execute().catch(() => undefined);
    await db.deleteFrom('entity_records').where('id', 'in', created.records).execute().catch(() => undefined);
  }
  if (created.users.length > 0) await db.deleteFrom('users').where('id', 'in', created.users).execute().catch(() => undefined);
  if (created.roles.length > 0) await db.deleteFrom('roles').where('id', 'in', created.roles).execute().catch(() => undefined);

  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`), eb(sql`attrs->>'name'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score conversion-preview suite left records behind');

  await shutdownApi();
}, 240_000);

describe('the map is configuration that writes records, so it is checked twice (contract §7)', () => {
  it('starts from a default map that never copies outcomes, ownership or derived names', () => {
    const section = ConversionSectionSchema.parse({});
    expect(section.targets).toEqual(['Contact', 'Account', 'Opportunity']);
    expect(section.fieldMergeAllowed).toBe(false);
    expect(section.mapping.Contact.fields.map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      'firstName->firstName',
      'lastName->lastName',
      'title->title',
      'emailAddress->emailAddress',
      'phoneNumber->phoneNumber',
      'source->leadSource',
    ]);
    // The person's mailbox reaches an Account only when no Contact is created, so it is not in the map.
    expect(section.mapping.Account.fields.map((entry) => entry.from)).toEqual(['company', 'industry']);
    expect(section.mapping.Opportunity.createDefaults['name']).toBe('{{lastName}} — {{company}}');
    expect(section.mapping).toEqual(DEFAULT_CONVERSION_MAPPING);
  });

  it('refuses an empty target list, an unknown target and a duplicate one', () => {
    expect(ConversionSectionSchema.safeParse({ targets: [] }).success).toBe(false);
    expect(ConversionSectionSchema.safeParse({ targets: ['Contact', 'Contact'] }).success).toBe(false);
    expect(ConversionSectionSchema.safeParse({ targets: ['Lead'] }).success).toBe(false);
    expect(ConversionSectionSchema.safeParse({ mapping: { Contact: { fields: [{ from: 'x', to: 'y', extra: 1 }] } } }).success).toBe(false);
  });

  it('compares types the way the contract states, not the way a string compare would', () => {
    const field = (type: string, extra: Record<string, unknown> = {}) => ({ type, required: false, ...extra });
    expect(typeCompatible(field('text'), field('varchar', { maxLength: 255 }))).toBe(false);
    expect(typeCompatible(field('varchar', { maxLength: 255 }), field('text'))).toBe(true);
    expect(typeCompatible(field('varchar', { maxLength: 255 }), field('varchar', { maxLength: 128 }))).toBe(false);
    expect(typeCompatible(field('varchar', { maxLength: 100 }), field('varchar', { maxLength: 128 }))).toBe(true);
    expect(typeCompatible(field('email'), field('url'))).toBe(false);
    expect(typeCompatible(field('email'), field('email'))).toBe(true);
    expect(typeCompatible(field('int'), field('float'))).toBe(true);
    expect(typeCompatible(field('date'), field('datetime'))).toBe(false);
    expect(typeCompatible(field('enum', { values: ['A'] }), field('enum', { values: ['A'] }))).toBe(false);
    expect(typeCompatible(field('link', { entityKey: 'Account' }), field('link', { entityKey: 'Account' }))).toBe(true);
    expect(typeCompatible(field('link', { entityKey: 'Account' }), field('link', { entityKey: 'Contact' }))).toBe(false);
    expect(typeCompatible(field('password'), field('varchar', { maxLength: 64 }))).toBe(false);
  });

  it('checks a value against the field it would land in', () => {
    expect(valueIssue({ type: 'email' }, 'not-an-address')).not.toBeNull();
    expect(valueIssue({ type: 'email' }, 'a@b.co')).toBeNull();
    expect(valueIssue({ type: 'varchar', maxLength: 4 }, 'toolong')).not.toBeNull();
    expect(valueIssue({ type: 'int' }, 1.5)).not.toBeNull();
    expect(valueIssue({ type: 'date' }, 'yesterday')).not.toBeNull();
    expect(valueIssue({ type: 'enum', values: ['A'] }, 'B')).not.toBeNull();
    expect(valueIssue({ type: 'text' }, '')).toBeNull();
  });

  it('fills a template from the Lead and drops the separator when a side is missing', () => {
    expect(composeTemplate('{{lastName}} — {{company}}', { lastName: 'Doe', company: 'Acme' })).toBe('Doe — Acme');
    expect(composeTemplate('{{lastName}} — {{company}}', { lastName: 'Doe' })).toBe('Doe');
    expect(composeTemplate('{{lastName}} — {{company}}', { company: 'Acme' })).toBe('Acme');
    expect(composeTemplate('{{lastName}} — {{company}}', {})).toBe('');
  });

  it('hashes every component the command will compare', () => {
    const base = {
      leadId: 'lead-1',
      leadRevision: 3,
      targets: [{ type: 'Contact' as const, action: 'create' as const, existingId: null }],
      mappingVersions: { Contact: 1 },
      fieldMerge: [],
      leadScope: ['company', 'lastName'],
      readerScope: { Contact: ['firstName', 'lastName'] },
      fieldMergeAllowed: false,
    };
    const hash = previewHash(base);
    expect(previewHash(base)).toBe(hash);
    expect(previewHash({ ...base, leadRevision: 4 })).not.toBe(hash);
    expect(previewHash({ ...base, mappingVersions: { Contact: 2 } })).not.toBe(hash);
    expect(previewHash({ ...base, fieldMerge: [{ target: 'Contact', field: 'title', value: 'CTO' }] })).not.toBe(hash);
    // The security component: the same plan, taken while one more field was visible, is a different preview.
    expect(previewHash({ ...base, readerScope: { Contact: ['firstName', 'lastName', 'title'] } })).not.toBe(hash);
    // The policy that decides whether a merge is applied at all is part of what the fingerprint describes.
    expect(previewHash({ ...base, fieldMergeAllowed: true })).not.toBe(hash);
  });
});

describe('the preview describes the operation and writes nothing (exit criterion)', () => {
  it('describes a Contact + Account create, and leaves every table exactly as it was', async () => {
    const leadId = await createLead('create lead', fullLead());
    const before = {
      lead: await ctx.database.db.selectFrom('entity_records').select(['version', 'modified_at']).where('id', '=', leadId).executeTakeFirstOrThrow(),
      records: await entityCounts(),
      audit: await tableCount('audit_log'),
      outbox: await tableCount('outbox_events'),
      jobs: await tableCount('jobs'),
    };

    const result = await preview(leadId, [
      { type: 'Contact', action: 'create' },
      { type: 'Account', action: 'create' },
    ]);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = view(result);

    const contact = body.targets.find((entry) => entry.type === 'Contact');
    const account = body.targets.find((entry) => entry.type === 'Account');
    const proposed = (target: PreviewTarget | undefined): Record<string, unknown> =>
      Object.fromEntries((target?.proposed ?? []).map((entry) => [entry.field, entry.value]));

    expect(proposed(contact)['lastName']).toBe(`${RUN}last`);
    expect(proposed(contact)['leadSource']).toBe('Web Site');
    expect(proposed(contact)['title']).toBe('Head of Ops');
    expect(proposed(account)['name']).toBe(`${RUN} Acme Industries`);
    expect(proposed(account)['industry']).toBe('Software');
    // The person's mailbox does not go to the Account when a Contact is being created.
    expect(proposed(account)['emailAddress']).toBeUndefined();
    // The relationship the command will set, not a mapped value.
    expect(contact?.relationship).toEqual([{ type: 'Account', action: 'create', id: null }]);
    expect(contact?.notCopied).toContain('name');
    expect(body.permission.canExecute).toBe(true);
    expect(body.permission.reasons).toEqual([]);
    expect(body.targets.every((target) => target.required.length === 0)).toBe(true);
    expect(body.confirmationTypes).toEqual(['simple']);
    expect(body.previewHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await ctx.database.db.selectFrom('entity_records').select(['version', 'modified_at']).where('id', '=', leadId).executeTakeFirstOrThrow()).toEqual(before.lead);
    expect(await entityCounts()).toEqual(before.records);
    expect(await tableCount('audit_log')).toBe(before.audit);
    expect(await tableCount('outbox_events')).toBe(before.outbox);
    expect(await tableCount('jobs')).toBe(before.jobs);
  });

  it('gives the Account the Lead’s contact details only when no Contact is built', async () => {
    const leadId = await createLead('account only', fullLead());
    const body = view(await preview(leadId, [{ type: 'Account', action: 'create' }]));
    const account = body.targets[0];
    const proposed = Object.fromEntries((account?.proposed ?? []).map((entry) => [entry.field, entry.value]));
    expect(proposed['emailAddress']).toBe(`${RUN.toLowerCase()}@example.com`);
    expect(proposed['phoneNumber']).toBe('+84 912 345 678');
    expect(account?.proposed.find((entry) => entry.field === 'emailAddress')?.origin).toBe('contextual');
  });

  it('names a required value a custom map no longer supplies instead of proposing an invalid create', async () => {
    // A Lead always carries `lastName`, but the map is configuration: an installation may stop copying it.
    // Then the Contact cannot be created, and the answer must say which value is missing rather than propose
    // a payload the entity layer would refuse (the same rule applies when the value is hidden — see the ACL
    // block below, where a hidden `company` leaves Account.name unset).
    await setSettings({ conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'title', to: 'title' }] } } } });
    const leadId = await createLead('nameless', { firstName: 'NoSurname', company: `${RUN} Nameless Ltd` });
    const body = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    const contact = body.targets[0];
    // A Contact needs `lastName`; `name` is derived from it, so the answer names the one real gap.
    expect(contact?.required).toEqual(['lastName']);
    expect(body.permission.canExecute).toBe(false);
    expect(body.permission.reasons).toContain('required_missing_Contact');
  });

  it('shows what a link would not apply, with the before/after of every difference', async () => {
    const leadId = await createLead('link lead', fullLead());
    const contactId = await createRecord('Contact', {
      name: `${RUN} existing`,
      firstName: 'Different',
      lastName: `${RUN} existing`,
      title: 'Old title',
      emailAddress: `${RUN.toLowerCase()}@example.com`,
    });

    const body = view(await preview(leadId, [{ type: 'Contact', action: 'link', existingId: contactId }]));
    const contact = body.targets[0];
    expect(contact?.existing).toEqual({ id: contactId, label: `${RUN} existing` });
    // A link is a reference: nothing is applied unless a person asks for a merge.
    expect(contact?.proposed).toEqual([]);
    expect(contact?.skipped.every((entry) => entry.reason === 'link_keeps_values')).toBe(true);
    const title = contact?.conflicts.find((entry) => entry.field === 'title');
    expect(title).toEqual({ field: 'title', current: 'Old title', proposed: 'Head of Ops' });
    // A field that already agrees is not a conflict.
    expect(contact?.conflicts.some((entry) => entry.field === 'emailAddress')).toBe(false);
    expect(body.confirmationTypes).toContain('field_merge');
  });

  it('refuses a merge the installation has not allowed, then proposes it once it has', async () => {
    const leadId = await createLead('merge lead', fullLead());
    const contactId = await createRecord('Contact', { name: `${RUN} merge target`, lastName: `${RUN} merge target` });
    const merge = [{ target: 'Contact', field: 'title', value: 'CTO' }];

    const refused = view(await preview(leadId, [{ type: 'Contact', action: 'link', existingId: contactId }], { fieldMerge: merge }));
    expect(refused.targets[0]?.skipped.map((entry) => entry.reason)).toContain('merge_not_allowed');
    expect(refused.permission.canExecute).toBe(false);
    expect(refused.permission.reasons).toContain('merge_not_allowed_Contact');

    await setSettings({ conversion: { fieldMergeAllowed: true } });
    const allowed = view(await preview(leadId, [{ type: 'Contact', action: 'link', existingId: contactId }], { fieldMerge: merge }));
    const merged = allowed.targets[0]?.proposed.find((entry) => entry.field === 'title');
    expect(merged).toEqual({ field: 'title', value: 'CTO', origin: 'merge' });
    expect(allowed.permission.canExecute).toBe(true);
    expect(allowed.previewHash).not.toBe(refused.previewHash);
  });

  it('refuses a stale revision or mapping version by name, and nothing else', async () => {
    const leadId = await createLead('stale lead', fullLead());
    const current = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));

    const staleRevision = await preview(leadId, [{ type: 'Contact', action: 'create' }], { expectedLeadRevision: current.leadRevision + 1 });
    expect(staleRevision.status).toBe(409);
    expect(errorOf(staleRevision).code).toBe('LEADSCORE_PREVIEW_STALE');
    expect(errorOf(staleRevision).details['component']).toBe('revision');

    const staleMapping = await preview(leadId, [{ type: 'Contact', action: 'create' }], { mappingVersion: current.fingerprint.mappingVersions['Contact'] + 1 });
    expect(staleMapping.status).toBe(409);
    expect(errorOf(staleMapping).details['component']).toBe('mapping');

    // The same request without a pin is fine, and the hash is stable for identical input.
    const again = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect(again.previewHash).toBe(current.previewHash);
  });

  it('changes the fingerprint when the Lead changes, and when the merge decision changes', async () => {
    const leadId = await createLead('hash lead', fullLead());
    const first = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect((await call('PATCH', `/api/v1/Lead/${leadId}`, { title: 'Changed' })).status).toBe(200);
    const second = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect(second.leadRevision).toBe(first.leadRevision + 1);
    expect(second.previewHash).not.toBe(first.previewHash);
    expect(second.fingerprint.leadScope).toEqual(first.fingerprint.leadScope);
  });
});

describe('the map is validated against metadata before it is stored (contract §7.1)', () => {
  it('refuses a field Lead does not have, and one the target does not have', async () => {
    const unknownSource = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'noSuchField', to: 'firstName' }] } } },
    });
    expect(unknownSource.status).toBe(422);
    expect(JSON.stringify(unknownSource.body)).toContain('source_unknown');

    const unknownTarget = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'lastName', to: 'noSuchField' }] } } },
    });
    expect(unknownTarget.status).toBe(422);
    expect(JSON.stringify(unknownTarget.body)).toContain('target_unknown');
  });

  it('refuses an incompatible type, a derived name, ownership and the relationship carry', async () => {
    const incompatible = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'description', to: 'firstName' }] } } },
    });
    expect(incompatible.status).toBe(422);
    expect(JSON.stringify(incompatible.body)).toContain('type_incompatible');

    for (const to of ['name', 'assignedUserId', 'teams', 'accountId']) {
      const refused = await call('POST', '/api/v1/LeadScore/action/settings', {
        conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'lastName', to }] } } },
      });
      expect(refused.status, to).toBe(422);
      expect(JSON.stringify(refused.body), to).toContain('target_not_mappable');
    }

    const outcome = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'scoreValue', to: 'firstName' }] } } },
    });
    expect(outcome.status).toBe(422);
    expect(JSON.stringify(outcome.body)).toContain('source_not_mappable');
  });

  it('refuses a changed map that kept its version, and accepts one that raised it', async () => {
    const kept = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Contact: { version: 1, fields: [{ from: 'description', to: 'description' }] } } },
    });
    expect(kept.status).toBe(422);
    expect(JSON.stringify(kept.body)).toContain('version_not_bumped');

    await setSettings({ conversion: { mapping: { Contact: { version: 2, fields: [{ from: 'description', to: 'description' }, { from: 'lastName', to: 'lastName' }] } } } });
    const leadId = await createLead('mapped', fullLead());
    const body = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect(body.targets[0]?.mappingVersion).toBe(2);
    expect(body.targets[0]?.proposed.find((entry) => entry.field === 'description')?.value).toBe('Converted by the LS.12 suite.');
  });

  it('refuses a template that names a field Lead does not have', async () => {
    const result = await call('POST', '/api/v1/LeadScore/action/settings', {
      conversion: { mapping: { Opportunity: { version: 2, createDefaults: { name: '{{noSuchToken}}' } } } },
    });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain('template_unknown_field');
  });
});

describe('what a caller may ask for (contract §5.2, §7.6)', () => {
  it('refuses a disabled target, a switched-off Opportunity, a repeated type and a malformed choice', async () => {
    const leadId = await createLead('targets', fullLead());

    await setSettings({ conversion: { targets: ['Contact'] } });
    const disabled = await preview(leadId, [{ type: 'Account', action: 'create' }]);
    expect(disabled.status).toBe(422);
    expect(errorOf(disabled).code).toBe('LEADSCORE_TARGET_DISABLED');
    expect(errorOf(disabled).details).toMatchObject({ target: 'Account', state: 'notEnabled' });
    await setSettings({ conversion: { targets: ['Contact', 'Account', 'Opportunity'] } });

    // 19-LS.16 delivered the phase, so `Opportunity` is now refused by its own switch — a `notEnabled`
    // answer with no phase to wait for — and accepted once the switch is on.
    const off = await preview(leadId, [{ type: 'Opportunity', action: 'create' }]);
    expect(off.status).toBe(422);
    expect(errorOf(off).code).toBe('LEADSCORE_TARGET_DISABLED');
    expect(errorOf(off).details).toMatchObject({ target: 'Opportunity', state: 'notEnabled' });
    expect(errorOf(off).details['pendingPhase']).toBeUndefined();

    // `opportunityConversion` requires `leadConversion`, so the switch alone would not be effective.
    await setSettings({ features: { leadConversion: true, opportunityConversion: true } });
    const enabled = await preview(leadId, [{ type: 'Opportunity', action: 'create' }]);
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const opportunity = view(enabled).targets[0];
    // The required name is composed from the Lead, and the person is told the deal will be created.
    expect(opportunity?.proposed.find((entry) => entry.field === 'name')?.value).toBe(`${RUN}last — ${RUN} Acme Industries`);
    expect(opportunity?.required).toEqual([]);
    expect(view(enabled).confirmationTypes).toContain('opportunity_created');
    expect(opportunity?.relationship).toEqual([]);

    expect((await preview(leadId, [{ type: 'Contact', action: 'create' }, { type: 'Contact', action: 'create' }])).status).toBe(422);
    expect((await preview(leadId, [{ type: 'Contact', action: 'link' }])).status).toBe(422);
    expect((await preview(leadId, [{ type: 'Contact', action: 'create', existingId: 'x' }])).status).toBe(422);
  });

  it('refuses while the preview switch is off, and names it', async () => {
    const leadId = await createLead('switched', fullLead());
    await setSettings({ features: { conversionPreview: false } });
    const off = await preview(leadId, [{ type: 'Contact', action: 'create' }]);
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(JSON.stringify(off.body)).toContain('conversionPreview');
  });
});

describe('the preview respects the reader’s own ACL (plan §7.1, §9.2)', () => {
  it('never proposes a hidden Lead value, and turns the gap into a blocking requirement', async () => {
    const leadId = await createLead('hidden company', { ...fullLead(), company: `${RUN} Secret Ltd` });
    const roleId = `${RUN}_no_company`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} no company`,
      permissions: { Lead: { read: 'all', edit: 'yes' }, Account: { create: 'yes', read: 'all' }, LeadConversionPreview: { read: 'yes' } },
      fieldPermissions: { Lead: { company: { read: 'no', edit: 'no' } } },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_limited`, roleIds: [roleId] });
    created.users.push(caller.id);

    const body = view(await preview(leadId, [{ type: 'Account', action: 'create' }], {}, caller.token));
    const account = body.targets[0];
    expect(account?.skipped.map((entry) => entry.reason)).toContain('source_hidden');
    expect(account?.proposed.find((entry) => entry.field === 'name')).toBeUndefined();
    // Account.name is required and the mapped source is unreadable: the preview says so instead of inventing
    // a value or proposing an invalid create.
    expect(account?.required).toEqual(['name']);
    expect(body.permission.canExecute).toBe(false);
    // The hidden value is nowhere in the payload.
    expect(JSON.stringify(body)).not.toContain('Secret Ltd');
  });

  it('refuses a link to a record this caller cannot read, without confirming it exists', async () => {
    const leadId = await createLead('hidden target', fullLead());
    const contactId = await createRecord('Contact', { name: `${RUN} invisible`, lastName: `${RUN} invisible`, assignedUserId: adminUserId });

    const roleId = `${RUN}_own_contacts`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} own contacts`,
      permissions: { Lead: { read: 'all', edit: 'yes' }, Contact: { read: 'own' }, LeadConversionPreview: { read: 'yes' } },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_owncontacts`, roleIds: [roleId] });
    created.users.push(caller.id);

    const result = await preview(leadId, [{ type: 'Contact', action: 'link', existingId: contactId }], {}, caller.token);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const body = view(result);
    expect(body.targets[0]?.existing).toBeNull();
    expect(body.permission.canExecute).toBe(false);
    expect(body.permission.reasons).toContain('target_unreadable_Contact');
    expect(JSON.stringify(body)).not.toContain('invisible');
  });

  it('carries the duplicate candidates only while that switch is on', async () => {
    const email = `${RUN.toLowerCase()}.dup@example.com`;
    const leadId = await createLead('dup lead', { ...fullLead(), emailAddress: email });
    const contactId = await createRecord('Contact', { name: `${RUN} dup contact`, lastName: `${RUN} dup contact`, emailAddress: email });

    const quiet = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect(quiet.duplicates).toBeNull();

    await setSettings({ features: { duplicateDetection: true } });
    const loud = view(await preview(leadId, [{ type: 'Contact', action: 'create' }]));
    expect(loud.duplicates?.candidates.some((entry) => entry.id === contactId)).toBe(true);
    expect(loud.confirmationTypes).toContain('duplicates_present');
  });
});
