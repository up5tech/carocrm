import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  domainOf,
  isFreeMailDomain,
  MAX_DUPLICATE_CANDIDATES,
  normalizedEmail,
  normalizedName,
  phoneMatchTail,
} from '../src/lead-score/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-LS.11 — duplicate detection and candidate review
 * (`PLAN_Phase_19_LeadScore.md` §7.1, §7.3, §9.2, §16 `19-LS.11`; audit §11 `LS.11`; contract §9).
 *
 * The exit criterion is one sentence: *ambiguous matches cannot result in silent auto-linking or
 * auto-merge.* Two properties make that true here, and both are driven through the real route against the
 * configured primary database (AGENTS.md §3.1 — no test database, no reset):
 *
 * 1. **Nothing writes.** The resolver's answer is a question; the suite asserts the Lead's `version` and
 *    `modifiedAt` and the matched Contact's are untouched, and that no audit or outbox row appeared.
 * 2. **Nothing hidden leaks.** Candidates come back only when the caller may *read* the record and see the
 *    field that matched, and a record they may not read contributes exactly one thing: `hiddenMatches`.
 *    The generic-warning half of plan §7.1 is that count, not a description.
 *
 * The pure helpers are tested first — they are the matching contract the SQL mirrors — then the route:
 * exact e-mail, phone across formats, Account company and domain, the free-mail exclusion, stage
 * reporting, the ACL partitions, the three doors (feature, capability, Lead ACL) and the result cap.
 *
 * `afterAll` removes only what this run created — its Leads, Contacts and Accounts, the roles and users
 * the ACL tests made, and every `entity_links` row touching them — and puts the `leadScore` settings row
 * back as it found it.
 */

const RUN = `AGENT_TEST_LS11_${Date.now().toString(36)}`;
const SETTINGS_ROW = 'leadScore';
const CANDIDATES_PATH = '/api/v1/LeadScore/action/conversion/candidates';

let ctx: ApiContext;
let previousSettings: string | null = null;
let adminUserId = '';
const created = { records: [] as string[], roles: [] as string[], users: [] as string[] };

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

interface Candidates {
  leadId: string;
  stages: { key: string; evaluated: boolean; reason: string | null }[];
  candidates: {
    entity: string;
    id: string;
    label: string | null;
    matchClass: string;
    reasons: string[];
    details: { email?: string; phone?: string; website?: string };
  }[];
  hiddenMatches: number;
  bounded: boolean;
  requiresChoice: boolean;
  canOverride: boolean;
  allowedDecisions: string[];
  limits: { candidates: number; scan: number };
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

async function candidates(leadId: string, token?: string): Promise<CallResult> {
  const result = await call('POST', CANDIDATES_PATH, { leadId }, token);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result;
}

function view(result: CallResult): Candidates {
  return result.body as unknown as Candidates;
}

async function createLead(suffix: string, data: Record<string, unknown> = {}): Promise<string> {
  const name = `${RUN} ${suffix}`;
  return createRecord('Lead', { name, firstName: 'Probe', lastName: name, status: 'New', ...data });
}

async function createContact(suffix: string, data: Record<string, unknown> = {}): Promise<string> {
  const lastName = `${RUN} ${suffix}`;
  return createRecord('Contact', { name: lastName, firstName: 'Probe', lastName, ...data });
}

/** A row's `version` and `modified_at`, for the "nothing wrote" assertions. */
async function stamp(entityType: string, id: string): Promise<{ version: number; modifiedAt: Date }> {
  const row = await ctx.database.db
    .selectFrom('entity_records')
    .select(['version', 'modified_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return { version: row.version, modifiedAt: row.modified_at };
}

beforeAll(async () => {
  ctx = await bootApi();
  const row = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', SETTINGS_ROW).executeTakeFirst();
  previousSettings = row === undefined ? null : JSON.stringify(row.data);
  const admin = await ctx.database.db
    .selectFrom('users')
    .select('id')
    .where('is_admin', '=', true)
    .where('is_deleted', '=', false)
    .limit(1)
    .executeTakeFirst();
  adminUserId = admin?.id ?? '';

  await setSettings({
    enabled: true,
    // Only the switch this phase owns: no conversion preview, no mapping — the resolver must not depend on
    // the parts of conversion that do not exist yet.
    features: { duplicateDetection: true },
  });
}, 240_000);

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

  // The Lead's display name is mirrored from `lastName`, so the marker is checked on both columns.
  const residue = await db
    .selectFrom('entity_records')
    .select('id')
    .where((eb) => eb.or([eb('name', 'like', `${RUN}%`), eb(sql`attrs->>'lastName'`, 'like', `${RUN}%`), eb(sql`attrs->>'name'`, 'like', `${RUN}%`)]))
    .execute()
    .catch(() => [] as { id: string }[]);
  if (residue.length > 0) console.warn({ residue: residue.length, run: RUN }, 'lead-score duplicates suite left records behind');

  await shutdownApi();
}, 240_000);

describe('the matching keys are the contract the SQL mirrors (contract §9.1–§9.3)', () => {
  it('folds an e-mail to one comparison key, and refuses what is not one', () => {
    expect(normalizedEmail('  Ann.Lee@Example.COM ')).toBe('ann.lee@example.com');
    expect(normalizedEmail('not-an-email')).toBeNull();
    expect(normalizedEmail('a@b')).toBeNull();
    expect(normalizedEmail(undefined)).toBeNull();
  });

  it('takes the same digit tail from every spelling of one number', () => {
    // A Lead has no country (contract §1.4), so the tail is what survives '+84', the trunk zero and a format.
    expect(phoneMatchTail('+84 912 345 678')).toBe('912345678');
    expect(phoneMatchTail('0912345678')).toBe('912345678');
    expect(phoneMatchTail('(091) 234-5678')).toBe('912345678');
    expect(phoneMatchTail('(415) 555-2671')).toBe('155552671');
    expect(phoneMatchTail('+1 415 555 2671')).toBe('155552671');
    // Not a phone at all: too short, too long, or nothing but zeros.
    expect(phoneMatchTail('12345')).toBeNull();
    expect(phoneMatchTail('1234567890123456')).toBeNull();
    expect(phoneMatchTail('0000000')).toBeNull();
  });

  it('derives one host from a URL or an address, and refuses a bare word or an IP', () => {
    expect(domainOf('https://www.Acme-Industries.com/about?x=1#top')).toBe('acme-industries.com');
    expect(domainOf('http://acme-industries.com:8443/path')).toBe('acme-industries.com');
    expect(domainOf('  ann@Acme-Industries.COM ')).toBe('acme-industries.com');
    expect(domainOf('www.acme.co.uk')).toBe('acme.co.uk');
    expect(domainOf('acme')).toBeNull();
    expect(domainOf('10.0.0.1')).toBeNull();
    expect(domainOf('')).toBeNull();
    // Free mail is a person's domain, never an organization signal.
    expect(isFreeMailDomain(domainOf('ann@gmail.com'))).toBe(true);
    expect(isFreeMailDomain(domainOf('ann@acme-industries.com'))).toBe(false);
  });

  it('collapses whitespace the same way the SQL does', () => {
    expect(normalizedName('  Acme   Industries  ')).toBe('acme industries');
    expect(normalizedName('   ')).toBeNull();
    expect(normalizedName(undefined)).toBeNull();
  });
});

describe('exact matches, and the decision they force (exit criterion)', () => {
  it('finds a Contact by e-mail and writes nothing while doing it', async () => {
    const email = `${RUN}.ann@example.com`.toLowerCase();
    const leadId = await createLead('email lead', { emailAddress: email.toUpperCase() });
    const contactId = await createContact('email contact', { emailAddress: email });
    const before = { lead: await stamp('Lead', leadId), contact: await stamp('Contact', contactId) };
    const auditBefore = await ctx.database.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();

    const body = view(await candidates(leadId));

    const found = body.candidates.find((entry) => entry.entity === 'Contact' && entry.id === contactId);
    expect(found, JSON.stringify(body)).toBeDefined();
    expect(found?.reasons).toContain('email_exact');
    expect(found?.matchClass).toBe('same_person');
    expect(body.requiresChoice).toBe(true);
    expect(body.allowedDecisions).toEqual(['link', 'create_with_override', 'cancel']);
    expect(body.hiddenMatches).toBe(0);

    // The question did not become an action: both records and the audit log are exactly as they were.
    expect(await stamp('Lead', leadId)).toEqual(before.lead);
    expect(await stamp('Contact', contactId)).toEqual(before.contact);
    const auditAfter = await ctx.database.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    expect(auditAfter?.count).toBe(auditBefore?.count);
  });

  it('matches the same number written two different ways', async () => {
    const leadId = await createLead('phone lead', { phoneNumber: '+84 912 345 678' });
    const contactId = await createContact('phone contact', { phoneNumber: '0912 345 678' });
    const body = view(await candidates(leadId));
    const found = body.candidates.find((entry) => entry.id === contactId);
    expect(found?.reasons).toContain('phone_exact');
    expect(found?.matchClass).toBe('same_person');
  });

  it('matches an organization by company name and by the domain of the mail', async () => {
    // A host label cannot contain `_` (and `domainOf` refuses one), so the run marker is dashed here.
    const domain = `acme-${RUN.toLowerCase().replace(/_/g, '-')}.test`;
    const leadId = await createLead('org lead', { company: `${RUN} Acme Industries`, emailAddress: `probe@${domain}` });
    const byName = await createRecord('Account', { name: `${RUN} acme   industries` });
    const byDomain = await createRecord('Account', { name: `${RUN} domain account`, website: `https://www.${domain}/about` });

    const body = view(await candidates(leadId));
    const nameHit = body.candidates.find((entry) => entry.id === byName);
    const domainHit = body.candidates.find((entry) => entry.id === byDomain);
    expect(nameHit?.reasons).toContain('company_exact');
    expect(nameHit?.matchClass).toBe('same_organization');
    expect(domainHit?.reasons).toContain('domain_exact');
    expect(domainHit?.matchClass).toBe('same_organization');
    expect(body.stages.find((stage) => stage.key === 'domain')?.evaluated).toBe(true);
  });

  it('never treats a free-mail domain as an organization', async () => {
    const leadId = await createLead('free mail lead', { emailAddress: `${RUN.toLowerCase()}@gmail.com` });
    const gmailAccount = await createRecord('Account', { name: `${RUN} mail provider`, website: 'https://gmail.com' });

    const body = view(await candidates(leadId));
    expect(body.stages.find((stage) => stage.key === 'domain')?.reason).toBe('free_mail');
    expect(body.candidates.some((entry) => entry.id === gmailAccount)).toBe(false);
  });

  it('says which stage could not run, instead of silently returning nothing', async () => {
    const email = `${RUN}.stages@example.com`;
    const leadId = await createLead('stages lead', { emailAddress: email });
    const body = view(await candidates(leadId));
    const stage = (key: string) => body.stages.find((entry) => entry.key === key);
    expect(stage('email')?.evaluated).toBe(true);
    expect(stage('phone')).toMatchObject({ evaluated: false, reason: 'no_value' });
    expect(stage('company')).toMatchObject({ evaluated: false, reason: 'no_value' });
    // Nothing matched, so nothing is being asked.
    expect(body.requiresChoice).toBe(false);
    expect(body.allowedDecisions).toEqual([]);
  });

  it('caps the answer and says when a scan was bounded', async () => {
    const email = `${RUN}.cap@example.com`;
    const leadId = await createLead('cap lead', { emailAddress: email });
    const scan = 26;
    for (let index = 0; index < scan; index += 1) await createContact(`cap contact ${String(index)}`, { emailAddress: email });
    const body = view(await candidates(leadId));
    expect(body.candidates).toHaveLength(MAX_DUPLICATE_CANDIDATES);
    expect(body.bounded).toBe(true);
    expect(body.limits).toEqual({ candidates: MAX_DUPLICATE_CANDIDATES, scan: 25 });
  });
});

describe('the caller sees their own matches and only a count of the rest (plan §7.1, §9.2)', () => {
  it('withholds a candidate the caller may not read, and counts it instead of naming it', async () => {
    const email = `${RUN}.acl@example.com`;
    const leadId = await createLead('acl lead', { emailAddress: email });
    const roleId = `${RUN}_own_contacts`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} own contacts`,
      permissions: {
        Lead: { read: 'all' },
        Contact: { read: 'own' },
        LeadConversionPreview: { read: 'yes' },
      },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_caller`, roleIds: [roleId] });
    created.users.push(caller.id);

    const mine = await createContact('acl mine', { emailAddress: email, assignedUserId: caller.id });
    const theirs = await createContact('acl hidden', { emailAddress: email, assignedUserId: adminUserId });

    const result = await candidates(leadId, caller.token);
    const body = view(result);
    expect(body.candidates.map((entry) => entry.id)).toEqual([mine]);
    expect(body.hiddenMatches).toBe(1);
    expect(body.requiresChoice).toBe(true);
    // No capability for overriding: "create anyway" is not among the answers this caller may give.
    expect(body.canOverride).toBe(false);
    expect(body.allowedDecisions).toEqual(['link', 'cancel']);
    // The hidden record is not described, named or implied anywhere in the payload.
    expect(JSON.stringify(result.body)).not.toContain(theirs);
    expect(JSON.stringify(result.body)).not.toContain('acl hidden');
  });

  it('masks a field the caller may not see, and withholds a candidate it cannot name', async () => {
    const email = `${RUN}.fields@example.com`;
    const leadId = await createLead('field lead', { emailAddress: email });
    const roleId = `${RUN}_hidden_fields`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} hidden contact fields`,
      permissions: {
        Lead: { read: 'all' },
        Contact: { read: 'all' },
        LeadConversionPreview: { read: 'yes' },
      },
      fieldPermissions: { Contact: { emailAddress: { read: 'no', edit: 'no' }, phoneNumber: { read: 'no', edit: 'no' } } },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_fielded`, roleIds: [roleId] });
    created.users.push(caller.id);

    const contactId = await createContact('field contact', { emailAddress: email, phoneNumber: '+84 912 345 678' });
    const body = view(await candidates(leadId, caller.token));
    const found = body.candidates.find((entry) => entry.id === contactId);
    // The record is readable, so it is a candidate — but the values that matched are not handed back.
    expect(found).toBeDefined();
    expect(found?.details.email).toBeUndefined();
    expect(found?.details.phone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(email);

    // And a candidate whose *identity* is hidden cannot be offered at all: it is the same count.
    const namelessRole = `${RUN}_nameless`;
    await createTestRole(ctx, {
      id: namelessRole,
      name: `${RUN} nameless contacts`,
      permissions: { Lead: { read: 'all' }, Contact: { read: 'all' }, LeadConversionPreview: { read: 'yes' } },
      fieldPermissions: { Contact: { name: { read: 'no', edit: 'no' } } },
    });
    created.roles.push(namelessRole);
    const nameless = await createTestUser(ctx, { userName: `${RUN}_nameless`, roleIds: [namelessRole] });
    created.users.push(nameless.id);
    const hiddenBody = view(await candidates(leadId, nameless.token));
    expect(hiddenBody.candidates).toHaveLength(0);
    expect(hiddenBody.hiddenMatches).toBe(1);
    expect(JSON.stringify(hiddenBody)).not.toContain('field contact');
  });
});

describe('the three doors into the resolver', () => {
  it('refuses a caller without the conversion-preview right', async () => {
    const leadId = await createLead('no right', { emailAddress: `${RUN}.right@example.com` });
    const roleId = `${RUN}_no_preview`;
    await createTestRole(ctx, { id: roleId, name: `${RUN} no preview`, permissions: { Lead: { read: 'all' } } });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_nopreview`, roleIds: [roleId] });
    created.users.push(caller.id);

    const denied = await call('POST', CANDIDATES_PATH, { leadId }, caller.token);
    expect(denied.status).toBe(403);
    expect(errorOf(denied).details['capability']).toBe('convertPreview');
  });

  it('refuses while the duplicate-review switch is off, and names it', async () => {
    const leadId = await createLead('switched off', { emailAddress: `${RUN}.off@example.com` });
    await setSettings({ features: { duplicateDetection: false } });
    const off = await call('POST', CANDIDATES_PATH, { leadId });
    await setSettings({ features: { duplicateDetection: true } });
    expect(off.status).toBe(403);
    expect(errorOf(off).code).toBe('LEADSCORE_MODULE_DISABLED');
    expect(JSON.stringify(off.body)).toContain('duplicateDetection');
    // And it comes back once the switch is on again.
    expect((await candidates(leadId)).status).toBe(200);
  });

  it('answers a Lead it may not read as missing, not as an empty candidate list', async () => {
    // The Lead belongs to somebody else: `own` is a record predicate, and the resolver must not turn a
    // record the caller cannot see into the claim "no duplicates".
    const leadId = await createLead('unreadable lead', { emailAddress: `${RUN}.unreadable@example.com`, assignedUserId: adminUserId });
    const roleId = `${RUN}_no_lead`;
    await createTestRole(ctx, {
      id: roleId,
      name: `${RUN} own leads only`,
      permissions: { Lead: { read: 'own' }, LeadConversionPreview: { read: 'yes' } },
    });
    created.roles.push(roleId);
    const caller = await createTestUser(ctx, { userName: `${RUN}_nolead`, roleIds: [roleId] });
    created.users.push(caller.id);

    const result = await call('POST', CANDIDATES_PATH, { leadId }, caller.token);
    expect(result.status).toBe(404);
    // "Zero candidates" would be a claim about a record this caller cannot see.
    expect(JSON.stringify(result.body)).not.toContain('candidates');
  });
});
