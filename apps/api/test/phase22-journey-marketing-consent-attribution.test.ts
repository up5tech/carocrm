import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeadScoreSettingsService } from '../src/lead-score/lead-score-settings.service.js';
import {
  assertProviderMessage,
  type MarketingProviderAdapter,
  type MarketingProviderInfo,
  type MarketingProviderMessage,
  MarketingProviderRegistry,
} from '../src/marketing-automation/marketing-automation-provider.js';
import { MarketingAutomationSettingsService } from '../src/marketing-automation/marketing-automation-settings.service.js';
import { MarketingConsentService } from '../src/marketing-automation/marketing-consent.service.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';
import { restoreSettings, snapshotSettings } from './support/settings-snapshot.js';

/**
 * Phase 22.12 — the journey: marketing automation, consent, and attribution
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §13.5, steps 1–10, and its acceptance assertions).
 *
 * One story, in order, through the public contracts: a person consents, a campaign is built around them, the
 * audience is validated and the suppression list reviewed, the send is decided (sealed, approved, queued),
 * and **the consent and suppression gates are re-checked at the last moment before a message is handed to a
 * provider** — so an unsubscribe that lands after the queue but before the wire stops the message. The
 * provider then talks back: delivered, opened, clicked, bounced, complained, unsubscribed, and every one of
 * those arriving twice is still one event. A conversion is recorded and reported as a *model*, never as proof
 * of causation. Lead Score reads only the engagement this log really holds, and a repeated event does not
 * multiply a score.
 *
 * Nothing here sends mail. The provider is an in-process scripted adapter with no socket, the webhook door is
 * a local secret, and every address is synthetic (AGENTS.md §3.3, §3.5 of the Phase 19 plan).
 *
 * Runs against the configured primary database. No database is created, reset or truncated; every record
 * this run creates is removed by exact id or by this run's unique marker.
 */

const runId = `ma22${Date.now().toString(36)}`;
const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;
/** The adapter a campaign is allowed to hand messages to: live mode, no network. */
const PROVIDER_KEY = `agent-test-${runId}`;
/** The provider name on the inbound door — the same adapter seen from the other side. */
const WEBHOOK_PROVIDER = `agent-test-events-${runId}`;
const WEBHOOK_SECRET = `ma22-webhook-${runId}`;
const ADDRESS = (who: string) => `${who}-${runId}@example.test`;

type Body = Record<string, unknown>;

interface CallResult {
  readonly status: number;
  readonly body: Body;
}

let ctx: ApiContext;
let previousSecret: string | undefined;
let settingsBaseline: unknown;
let leadScoreBaseline: unknown;
let senderAccountId = '';
let campaignId = '';
let includedListId = '';
let excludedListId = '';
let templateId = '';
let modelId = '';
const contactIds: string[] = [];
const sendIds: string[] = [];
const createdIds: string[] = [];
const jobIds: string[] = [];
const entityIds: { entity: string; id: string }[] = [];
/** Everything the provider was handed — the only proof of an outbound message in this journey. */
const sentMessages: MarketingProviderMessage[] = [];

/**
 * The scripted provider. `mode: 'live'` is what the pipeline requires to put a message on the wire; the
 * wire here is an array in this process.
 */
class ScriptedProvider implements MarketingProviderAdapter {
  readonly info: MarketingProviderInfo = {
    key: PROVIDER_KEY,
    label: 'Scripted Phase 22.12 provider',
    mode: 'live',
    maxRecipients: 50,
    ratePerMinute: 0,
    maxConcurrency: 1,
    fromAddress: `agent-test-${runId}@example.test`,
    reportsEvents: false,
    supportsTestSend: true,
  };
  /**
   * Fail the next message handed to this one address, once. The failure has to be aimed: a batch claims
   * several rows, and "fail the next call" would land on whichever recipient happened to be first.
   */
  failFor: { address: string; kind: 'retryable' | 'permanent' | 'unknown_submission'; reasonCode: string } | null = null;

  validate(message: MarketingProviderMessage): void {
    assertProviderMessage(message);
  }

  async verify(): Promise<void> {}

  async send(message: MarketingProviderMessage): Promise<MarketingProviderResult> {
    this.validate(message);
    if (this.failFor !== null && message.to.includes(this.failFor.address)) {
      const failure = this.failFor;
      this.failFor = null;
      const { MarketingProviderError } = await import('../src/marketing-automation/marketing-automation-provider.js');
      throw new MarketingProviderError(`Scripted ${failure.kind}.`, failure.kind, failure.reasonCode);
    }
    sentMessages.push(message);
    const receiptId = `scripted-${String(sentMessages.length)}`;
    return {
      key: this.info.key,
      accepted: true,
      providerMessageId: receiptId,
      receipts: message.to.map((recipient) => ({
        recipient,
        status: 'accepted' as const,
        providerMessageId: receiptId,
      })),
    };
  }
}

type MarketingProviderResult = Awaited<ReturnType<MarketingProviderAdapter['send']>>;

const provider = new ScriptedProvider();

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  url: string,
  payload?: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...authHeader(token ?? ctx.adminToken), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Body }),
  });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

/** The public doors: a form and a webhook carry the provider's or the visitor's own credentials. */
async function publicCall(method: 'GET' | 'POST', url: string, payload: Body, headers: Record<string, string> = {}): Promise<CallResult> {
  const res = await ctx.app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload });
  let body: Body = {};
  try {
    body = res.json() as Body;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createRecord(entity: string, payload: Body): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, payload);
  expect(res.status, `${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  const id = String(res.body['id']);
  entityIds.push({ entity, id });
  return id;
}

async function makeContact(who: string, emailAddress?: string): Promise<string> {
  const id = await createRecord('Contact', {
    name: marker(who),
    firstName: `First ${runId}`,
    lastName: who,
    ...(emailAddress === undefined ? {} : { emailAddress }),
    status: 'Active',
  });
  contactIds.push(id);
  return id;
}

async function makeList(name: string): Promise<string> {
  return createRecord('TargetList', {
    name: marker(name),
    membershipMode: 'static',
    entityTypes: 'Contact,Lead',
    status: 'Active',
  });
}

async function addMembers(listId: string, members: { entityType: string; entityId: string }[]): Promise<CallResult> {
  return call('POST', `/api/v1/MarketingAutomation/action/segment/${listId}/members`, { members });
}

/** The consent door the platform supports — never a direct row write. */
async function recordConsent(input: Body): Promise<CallResult> {
  return call('POST', '/api/v1/MarketingAutomation/action/consent', input);
}

/** The address identity the platform itself computes; the ledger and the suppression list key on this. */
function identityOf(address: string): string {
  return ctx.app.get(MarketingConsentService).identity(address) ?? '';
}

interface SignedEvent {
  readonly type: string;
  readonly eventId: string;
  readonly campaignId?: string;
  readonly sendId?: string;
  readonly slot?: number;
  readonly recipientId?: string;
  readonly recipientType?: string;
  readonly emailHash?: string;
  readonly url?: string;
  readonly providerMessageId?: string;
}

async function providerEvent(event: SignedEvent, signature?: string): Promise<CallResult> {
  const payload: Body = {
    eventId: event.eventId,
    type: event.type,
    occurredAt: new Date().toISOString(),
    recipientEntityType: event.recipientType ?? 'Contact',
    recipientEntityId: event.recipientId,
    ...(event.campaignId !== undefined ? { campaignId: event.campaignId } : {}),
    ...(event.sendId !== undefined ? { sendId: event.sendId, slot: event.slot ?? 1 } : {}),
    ...(event.emailHash !== undefined ? { emailHash: event.emailHash } : {}),
    ...(event.url !== undefined ? { url: event.url } : {}),
    ...(event.providerMessageId !== undefined ? { providerMessageId: event.providerMessageId } : {}),
  };
  return publicCall('POST', `/api/v1/MarketingAutomation/webhook/${WEBHOOK_PROVIDER}`, payload, {
    'x-webhook-signature': signature ?? WEBHOOK_SECRET,
    'x-webhook-timestamp': new Date().toISOString(),
  });
}

async function runBatch(sendId: string): Promise<CallResult> {
  return call('POST', '/api/v1/MarketingAutomation/action/delivery/run-scheduled-batch', { sendId });
}

async function ledgerRows(sendId: string): Promise<Body[]> {
  const rows = await sql<Body>`
    select entity_id, entity_type, state, category, reasons, error_code, provider_message_id, email_hash
    from marketing_recipient_deliveries where send_id = ${sendId} order by entity_id
  `.execute(ctx.database.db);
  return rows.rows;
}

async function eventRows(campaign: string, normalizedType: string): Promise<Body[]> {
  const rows = await sql<Body>`
    select id, provider_event_id, normalized_type, recipient_entity_id from marketing_events
    where campaign_id = ${campaign} and normalized_type = ${normalizedType} order by received_at asc
  `.execute(ctx.database.db);
  return rows.rows;
}

async function sendAttrs(sendId: string): Promise<Body> {
  const row = await ctx.database.db.selectFrom('entity_records').select('attrs')
    .where('entity_type', '=', 'MarketingSend').where('id', '=', sendId).executeTakeFirst();
  return (row?.attrs as Body) ?? {};
}

async function recordAttrs(entity: string, id: string): Promise<Body> {
  const row = await ctx.database.db.selectFrom('entity_records').select('attrs')
    .where('entity_type', '=', entity).where('id', '=', id).executeTakeFirst();
  return (row?.attrs as Body) ?? {};
}

function messagesTo(address: string): MarketingProviderMessage[] {
  return sentMessages.filter((message) => message.to.includes(address));
}

async function createPublishedEngagementModel(): Promise<string> {
  const id = await createRecord('LeadScoreModel', {
    name: marker('engagement model'),
    modelVersion: 1,
    scaleMin: 0,
    scaleMax: 100,
    baseScore: 0,
    scoreFloor: 0,
    scoreCeiling: 100,
    qualificationBands: JSON.stringify([
      { band: 'Cold', min: 0, max: 39 },
      { band: 'Warm', min: 40, max: 69 },
      { band: 'Hot', min: 70, max: 89 },
      { band: 'Sales Ready', min: 90, max: 100 },
    ]),
    allowedFieldPaths: JSON.stringify(['company']),
  });
  await createRecord('LeadScoreRule', {
    name: marker('opened twice'),
    modelId: id,
    modelVersion: 1,
    reasonCode: `ma22_opened_${id.slice(-6)}`,
    dimension: 'engagement',
    enabled: true,
    condition: JSON.stringify({ field: 'eventCount', operator: 'gte', value: 2 }),
    effect: 'add',
    points: 40,
    priority: 10,
    missingDataPolicy: 'neutral',
    signalSource: 'marketingEvents',
    eventType: 'opened',
    lookbackDays: 30,
  });
  const published = await call('POST', '/api/v1/LeadScore/action/model/publish', { modelId: id });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  previousSecret = process.env.MARKETING_WEBHOOK_SECRET;
  process.env.MARKETING_WEBHOOK_SECRET = WEBHOOK_SECRET;
  ctx = await bootApi();
  // The row's real name is `marketingAutomation`; snapshotting anything else snapshots nothing, and the
  // next suite then inherits this run's provider key and test-send allowlist.
  settingsBaseline = await snapshotSettings(ctx, 'marketingAutomation');
  leadScoreBaseline = await snapshotSettings(ctx, 'leadScore');
  ctx.app.get(MarketingProviderRegistry).register(provider);

  senderAccountId = `AGENT_TEST_${runId}_account`;
  await ctx.database.db
    .insertInto('email_accounts')
    .values({
      id: senderAccountId,
      name: marker('sender'),
      email_address: ADDRESS('sender'),
      smtp_host: '127.0.0.1',
      smtp_port: 2525,
      smtp_security: 'none',
      is_default: false,
    })
    .execute();

  const settings = await call('POST', '/api/v1/MarketingAutomation/action/settings', {
    features: { campaigns: true, templates: true, audience: true },
    provider: { key: PROVIDER_KEY, testSend: { allowedRecipients: [ADDRESS('friend'), ADDRESS('opted-out')] } },
    safety: { globalSendPaused: false },
  });
  expect(settings.status, JSON.stringify(settings.body)).toBeLessThan(300);

  templateId = await createRecord('EmailTemplate', {
    name: marker('newsletter template'),
    subject: `News ${runId} {{recipientName}}`,
    body: `A newsletter for {{recipientName}}.`,
    bodyHtml: `<p>A newsletter for {{recipientName}}.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>`,
  });
  includedListId = await makeList('included audience');
  excludedListId = await makeList('excluded audience');
  campaignId = await createRecord('Campaign', {
    name: marker('newsletter campaign'),
    code: `MA22${runId.slice(-6).toUpperCase()}`,
    type: 'Newsletter',
    purpose: 'Newsletter',
    templateId,
    emailAccountId: senderAccountId,
    trackingOpen: false,
    trackingClick: false,
    startsAt: '2026-11-01T09:00:00.000Z',
    endsAt: '2026-11-30T17:00:00.000Z',
  });
  modelId = await createPublishedEngagementModel();
  // Publishing makes a version immutable; the instance still has to be told which model is the live one.
  const scored = await call('POST', '/api/v1/LeadScore/action/settings', {
    enabled: true,
    features: { scoring: true, manualRecalculation: true, engagementSignals: true, scoreExplanation: true },
    scoring: { activeModelId: modelId },
  });
  expect(scored.status, JSON.stringify(scored.body)).toBe(200);
}, 240_000);

afterAll(async () => {
  try {
    const db = ctx.database.db;
    const campaignIds = [campaignId];
    const allEntityIds = [...new Set([...entityIds.map((entry) => entry.id), ...sendIds, campaignId, modelId])];
    if (sendIds.length > 0) {
      await db.deleteFrom('marketing_recipient_deliveries').where('send_id', 'in', sendIds).execute();
      await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingSendTransition')
        .where(sql`attrs ->> 'sendId'`, 'in', sendIds).execute();
      await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingSend').where('id', 'in', sendIds).execute();
    }
    if (campaignIds.length > 0) {
      await sql`delete from marketing_events where campaign_id = ${campaignId}`.execute(db);
      await sql`delete from marketing_provider_webhook_inbox where provider = ${WEBHOOK_PROVIDER}`.execute(db);
      await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingPublicToken')
        .where(sql`attrs ->> 'campaignId'`, 'in', campaignIds).execute();
      await db.deleteFrom('entity_records').where('entity_type', 'in', ['CampaignTransition', 'MarketingAudienceSnapshot', 'MarketingTemplateRevision'])
        .where(sql`attrs ->> 'campaignId'`, 'in', campaignIds).execute();
      await db.deleteFrom('entity_records').where('entity_type', 'in', ['MarketingSuppression', 'MarketingConsent', 'MarketingConsentEvent'])
        .where(sql`attrs ->> 'campaignId'`, 'in', campaignIds).execute();
      await db.deleteFrom('outbox_events').where('event_type', 'like', 'marketingAutomation.%')
        .where(sql`payload ->> 'campaignId'`, 'in', campaignIds).execute();
    }
    // Consent and suppression rows that name a contact or a lead rather than a campaign.
    const personIds = [...contactIds, ...createdIds];
    if (personIds.length > 0) {
      await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingConsent')
        .where(sql`attrs ->> 'contactId'`, 'in', personIds).execute();
      await db.deleteFrom('entity_records').where('entity_type', 'in', ['MarketingConsent', 'MarketingConsentEvent'])
        .where(sql`attrs ->> 'leadId'`, 'in', personIds).execute();
    }
    const consentIds = (await db.selectFrom('entity_records').select('id')
      .where('entity_type', '=', 'MarketingConsent')
      .where(sql`attrs ->> 'emailHash'`, 'in', [
        identityOf(ADDRESS('consented')), identityOf(ADDRESS('opted-out')), identityOf(ADDRESS('retry')),
        identityOf(ADDRESS('form')), identityOf(ADDRESS('stranger')),
      ]).execute()).map((row) => row.id);
    if (consentIds.length > 0) {
      await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingConsentEvent')
        .where(sql`attrs ->> 'consentId'`, 'in', consentIds).execute();
    }
    await db.deleteFrom('entity_records').where('entity_type', '=', 'MarketingSuppression')
      .where(sql`attrs ->> 'emailHash'`, 'in', [
        identityOf(ADDRESS('opted-out')), identityOf(ADDRESS('bounced')), identityOf(ADDRESS('complained')),
        identityOf(ADDRESS('blocked')), identityOf(ADDRESS('retry')), identityOf(ADDRESS('friend')),
      ]).execute();
    if (includedListId !== '' || excludedListId !== '') {
      const lists = [includedListId, excludedListId];
      await db.deleteFrom('entity_records').where('entity_type', '=', 'TargetListEntry')
        .where(sql`attrs ->> 'targetListId'`, 'in', lists).execute();
      for (const column of ['record_id_a', 'record_id_b'] as const) {
        await db.deleteFrom('entity_links').where('relation_name', 'in', ['includedTargetLists', 'excludedTargetLists'])
          .where(sql`${sql.ref(column)}::text`, 'in', [...campaignIds, ...lists]).execute();
      }
    }
    if (jobIds.length > 0) await db.deleteFrom('jobs').where('id', 'in', jobIds).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'LeadScoreEvaluation')
      .where(sql`attrs ->> 'modelId'`, '=', modelId).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'LeadScoreRule')
      .where(sql`attrs ->> 'modelId'`, '=', modelId).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'LeadScoreModel').where('id', '=', modelId).execute();
    await db.deleteFrom('entity_records').where('entity_type', '=', 'LeadScoreModelVersion').where(sql`attrs ->> 'modelId'`, '=', modelId).execute();
    await db.deleteFrom('stream_items').where(sql`entity_id`, 'in', allEntityIds).execute();
    await db.deleteFrom('audit_log').where('record_id', 'in', allEntityIds).execute();
    await db.deleteFrom('outbox_events').where(sql`payload ->> 'entityId'`, 'in', allEntityIds).execute();
    for (const entry of [...entityIds].reverse()) {
      await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`);
    }
    await db.deleteFrom('entity_records').where('id', 'in', allEntityIds).where('deleted_at', 'is not', null).execute();
    await db.deleteFrom('email_accounts').where('id', '=', senderAccountId).execute();
    await restoreSettings(ctx, 'marketingAutomation', settingsBaseline);
    await restoreSettings(ctx, 'leadScore', leadScoreBaseline);
    ctx.app.get(MarketingAutomationSettingsService).invalidate();
    ctx.app.get(LeadScoreSettingsService).invalidate();
    // The proof this suite leaves nothing behind: every row it can name by its marker is gone.
    const leftovers = await sql<{ n: string }>`
      select (
        (select count(*) from entity_records where name like ${`AGENT_TEST_${runId}%`}) +
        (select count(*) from marketing_events where campaign_id = ${campaignId}) +
        (select count(*) from marketing_provider_webhook_inbox where provider = ${WEBHOOK_PROVIDER})
      )::text as n
    `.execute(db);
    const deliveries = sendIds.length === 0
      ? 0
      : Number((await sql<{ count: string }>`
          select count(*)::text as count from marketing_recipient_deliveries where send_id = ${sendIds[0]}
        `.execute(db)).rows[0]?.count ?? '0');
    expect(Number(leftovers.rows[0]?.n ?? '1') + deliveries).toBe(0);
  } finally {
    if (previousSecret === undefined) delete process.env.MARKETING_WEBHOOK_SECRET;
    else process.env.MARKETING_WEBHOOK_SECRET = previousSecret;
    await shutdownApi();
  }
}, 240_000);

describe('the journey: consent, a campaign, and what the provider says afterwards (22.12)', () => {
  let consentedId = '';
  let unknownId = '';
  let optedOutId = '';
  let blockedId = '';
  let excludedId = '';
  let retryId = '';

  it('step 1 — consent is recorded through the consent service, and every decision is history', async () => {
    consentedId = await makeContact('consented', ADDRESS('consented'));
    unknownId = await makeContact('no-consent', ADDRESS('no-consent'));
    optedOutId = await makeContact('opted-out', ADDRESS('opted-out'));
    blockedId = await makeContact('blocked', ADDRESS('blocked'));
    excludedId = await makeContact('excluded', ADDRESS('excluded'));
    retryId = await makeContact('retry', ADDRESS('retry'));

    const first = await recordConsent({
      emailAddress: ADDRESS('consented'), purpose: 'Newsletter', to: 'Consented', basis: 'ExplicitOptIn',
      source: 'ManualRecord', contactId: consentedId, idempotencyKey: `${runId}-consent-1`,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ changed: true, idempotent: false });

    // The same decision again is one decision.
    const replay = await recordConsent({
      emailAddress: ADDRESS('consented'), purpose: 'Newsletter', to: 'Consented', basis: 'ExplicitOptIn',
      source: 'ManualRecord', contactId: consentedId, idempotencyKey: `${runId}-consent-1`,
    });
    expect(replay.body).toMatchObject({ changed: false, idempotent: true });

    // The recipient the retry leg needs, consented once and for all.
    const retryConsent = await recordConsent({
      emailAddress: ADDRESS('retry'), purpose: 'Newsletter', to: 'Consented', basis: 'ExplicitOptIn',
      source: 'ManualRecord', contactId: retryId,
    });
    expect(retryConsent.status, JSON.stringify(retryConsent.body)).toBe(200);

    // The person who later opts out has to have been asked first.
    const optedOut = await recordConsent({
      emailAddress: ADDRESS('opted-out'), purpose: 'Newsletter', to: 'Consented', basis: 'ExplicitOptIn',
      source: 'ManualRecord', contactId: optedOutId,
    });
    expect(optedOut.status, JSON.stringify(optedOut.body)).toBe(200);
    const withdrawal = await recordConsent({
      emailAddress: ADDRESS('opted-out'), purpose: 'Newsletter', to: 'OptedOut',
      source: 'UnsubscribeLink', contactId: optedOutId, reason: 'asked to stop',
    });
    expect(withdrawal.status, JSON.stringify(withdrawal.body)).toBe(200);

    // Consent keys on the address identity, not on a copy of the address.
    const consent = await sql<Body>`
      select attrs from entity_records where entity_type = 'MarketingConsent'
        and attrs ->> 'contactId' = ${consentedId} and deleted_at is null
    `.execute(ctx.database.db);
    const attrs = (consent.rows[0]?.attrs as Body) ?? {};
    expect(String(attrs['emailHash'])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(attrs)).not.toContain(ADDRESS('consented'));

    const history = await call('GET', `/api/v1/MarketingAutomation/action/consent/${String((first.body['consent'] as Body)['consentId'])}/history`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const events = (history.body['list'] ?? []) as Body[];
    expect(events.map((event) => [event['fromStatus'], event['toStatus']])).toContainEqual(['Unknown', 'Consented']);
  });

  it('step 2 — a public form keeps the attribution it collected, and its intake key means one Lead', async () => {
    const submission = await publicCall('POST', '/api/v1/MarketingAutomation/public/form/submit', {
      firstName: 'Form', lastName: `Person ${runId}`, email: ADDRESS('form'), company: 'Acme Industries',
      consent: true, source: 'Web Form', campaignId, utmSource: 'partner-newsletter', utmMedium: 'email',
      utmCampaign: 'launch-2026', idempotencyKey: `${runId}-intake-1`,
    });
    expect(submission.status, JSON.stringify(submission.body)).toBe(200);
    expect(submission.body).toEqual({ accepted: true });

    const lead = await sql<{ id: string; attrs: Body }>`
      select id, attrs from entity_records where entity_type = 'Lead'
        and attrs ->> 'emailAddress' = ${ADDRESS('form')} and deleted_at is null
    `.execute(ctx.database.db);
    expect(lead.rows).toHaveLength(1);
    const created = lead.rows[0];
    expect(created).toBeDefined();
    const attrs = created?.attrs ?? {};
    // The company, the campaign and the medium are the point of collecting them (gap G24/G25).
    expect(attrs['company']).toBe('Acme Industries');
    expect(attrs['utmSource']).toBe('partner-newsletter');
    expect(attrs['utmMedium']).toBe('email');
    expect(attrs['utmCampaign']).toBe('launch-2026');
    expect(attrs['campaignId']).toBe(campaignId);
    expect(attrs['formIntakeKey']).toBe(`${runId}-intake-1`);
    createdIds.push(String(created?.id));

    // That evidence belongs to the intake. A record write cannot claim a campaign or steal an intake key.
    const forged = await call('PATCH', `/api/v1/Lead/${String(created?.id)}`, { formIntakeKey: 'somebody-elses-key' });
    expect(forged.status, JSON.stringify(forged.body)).toBe(422);
    expect(JSON.stringify(forged.body)).toContain('MARKETING_INTAKE_FIELDS_SERVER_OWNED');

    // The same intake, from a person who corrected their address: one Lead, not two.
    const corrected = await publicCall('POST', '/api/v1/MarketingAutomation/public/form/submit', {
      firstName: 'Form', lastName: `Person ${runId}`, email: ADDRESS('form-corrected'),
      consent: true, campaignId, idempotencyKey: `${runId}-intake-1`,
    });
    expect(corrected.status).toBe(200);
    const secondLead = await sql<{ id: string }>`
      select id from entity_records where entity_type = 'Lead'
        and attrs ->> 'emailAddress' = ${ADDRESS('form-corrected')} and deleted_at is null
    `.execute(ctx.database.db);
    expect(secondLead.rows).toHaveLength(0);

    // A stranger naming a campaign that does not exist is not a reason to lose the person.
    const stranger = await publicCall('POST', '/api/v1/MarketingAutomation/public/form/submit', {
      firstName: 'Stranger', lastName: `Thing ${runId}`, email: ADDRESS('stranger'), consent: false,
      campaignId: 'not-a-campaign', idempotencyKey: `${runId}-intake-2`,
    });
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(200);
    const strangerLead = await sql<{ attrs: Body }>`
      select attrs from entity_records where entity_type = 'Lead'
        and attrs ->> 'emailAddress' = ${ADDRESS('stranger')} and deleted_at is null
    `.execute(ctx.database.db);
    expect(strangerLead.rows).toHaveLength(1);
    expect(strangerLead.rows[0]?.attrs['campaignId']).toBeUndefined();
    const strangerId = await sql<{ id: string }>`
      select id from entity_records where entity_type = 'Lead' and attrs ->> 'emailAddress' = ${ADDRESS('stranger')}
    `.execute(ctx.database.db);
    for (const row of strangerId.rows) createdIds.push(row.id);
  });

  it('step 3 — the audience validates, and the suppression review says who is not coming', async () => {
    const added = await addMembers(includedListId, [
      { entityType: 'Contact', entityId: consentedId },
      { entityType: 'Contact', entityId: unknownId },
      { entityType: 'Contact', entityId: optedOutId },
      { entityType: 'Contact', entityId: retryId },
      { entityType: 'Contact', entityId: blockedId },
      { entityType: 'Contact', entityId: excludedId },
    ]);
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
    await addMembers(excludedListId, [{ entityType: 'Contact', entityId: excludedId }]);
    expect((await call('PUT', `/api/v1/Campaign/${campaignId}/includedTargetLists/${includedListId}`)).status).toBeLessThan(300);
    expect((await call('PUT', `/api/v1/Campaign/${campaignId}/excludedTargetLists/${excludedListId}`)).status).toBeLessThan(300);

    // A purpose-scoped block that names no purpose would silently widen itself at match time, so the shape
    // is refused at the write rather than discovered by a campaign that sends anyway.
    const malformed = await call('POST', '/api/v1/MarketingAutomation/action/suppression', {
      emailAddress: ADDRESS('malformed'), scope: 'Purpose', reason: 'ManualBlock',
    });
    expect(malformed.status).toBe(422);
    expect(JSON.stringify(malformed.body)).toContain('purpose-scoped');

    const block = await call('POST', '/api/v1/MarketingAutomation/action/suppression', {
      emailAddress: ADDRESS('blocked'), scope: 'Global', reason: 'ManualBlock', source: 'ManualRecord', note: marker('reviewed block'),
    });
    expect(block.status, JSON.stringify(block.body)).toBeLessThan(300);
    const listed = await call('GET', `/api/v1/MarketingAutomation/action/suppression?emailAddress=${encodeURIComponent(ADDRESS('blocked'))}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(((listed.body['list'] ?? []) as Body[]).length).toBe(1);

    const preview = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audiencePreview`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const categories = ((preview.body['categories'] ?? []) as Body[]).map((row) => String(row['category']));
    expect(categories).toContain('eligible');
    expect(categories).toContain('consentUnknown');
    expect(categories).toContain('optedOut');
    expect(categories).toContain('excludedBySegment');
    // The excluded person is named in the audience but is not an addressable recipient.
    const samples = ((preview.body['samples'] ?? []) as Body[]).filter((row) => row['entityId'] === excludedId);
    expect(samples.length === 0 || String(samples[0]?.['category']) === 'excludedBySegment').toBe(true);

    const validated = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/validate?as=Running`, {});
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    expect(validated.body['valid']).toBe(true);
    expect(String(validated.body['validationHash'])).toMatch(/^[0-9a-f]{32}$/);

    // The campaign may not be started against a provider that is not live.
    const withoutProvider = await call('POST', '/api/v1/MarketingAutomation/action/settings', { provider: { key: '' } });
    expect(withoutProvider.status).toBeLessThan(300);
    const refused = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/start`, {});
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('PROVIDER_NOT_BOUND');
    await call('POST', '/api/v1/MarketingAutomation/action/settings', {
      provider: { key: PROVIDER_KEY, testSend: { allowedRecipients: [ADDRESS('friend'), ADDRESS('opted-out')] } },
    });

    const scheduled = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/schedule`, {});
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    const started = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
  });

  it('step 4 — the send is decided, sealed and queued — and nothing has been sent yet', async () => {
    const created = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sends`, { slot: 1 });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const sendId = String(created.body['id']);
    sendIds.push(sendId);

    const dryRun = await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/dryRun`, {});
    expect(dryRun.status, JSON.stringify(dryRun.body)).toBe(200);
    const audience = (dryRun.body['audience'] ?? {}) as Body;
    expect(Number(audience['resolved'])).toBeGreaterThan(0);
    expect(Number(audience['blocked'])).toBeGreaterThan(0);
    expect(String(dryRun.body['materialHash'])).toMatch(/^[0-9a-f]{32}$/);

    const validated = await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/validate`, {});
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    const view = validated.body;
    expect(String((view['validation'] as Body)['hash'])).toMatch(/^[0-9a-f]{32}$/);
    expect((view['counts'] as Body)['recipient']).toBe(6);
    expect(view['snapshotId']).toBeTruthy();
    expect(view['templateRevisionId']).toBeTruthy();

    const approved = await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/approve`, { note: marker('approval') });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(((approved.body['approval'] ?? {}) as Body)['current']).toBe(true);
    expect((await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/schedule`, {})).status).toBe(200);

    const before = sentMessages.length;
    const queued = await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/queue`, {});
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    const jobId = String(queued.body['deliveryJobId'] ?? '');
    expect(jobId).toMatch(/^[0-9a-f-]{16,64}$/);
    jobIds.push(jobId);
    // A queue command writes work, not messages.
    expect(sentMessages.length).toBe(before);
    const rows = await ledgerRows(sendId);
    expect(rows.map((row) => String(row['state']))).toContain('Eligible');
  });

  it('step 5 — suppression wins over a queued send when the person opts out before the wire', async () => {
    const sendId = sendIds[0] ?? '';
    const before = sentMessages.length;

    // The provider reports the unsubscribe of somebody whose row is already sitting there as Eligible.
    const unsubscribed = await providerEvent({
      type: 'unsubscribe', eventId: `${runId}-evt-unsub-early`, campaignId, sendId, slot: 1,
      recipientId: optedOutId, emailHash: identityOf(ADDRESS('opted-out')),
    });
    expect(unsubscribed.status, JSON.stringify(unsubscribed.body)).toBe(200);
    expect(unsubscribed.body).toMatchObject({ duplicate: false, normalizedType: 'unsubscribed', processingStatus: 'processed' });

    // The same delivery, twice more: one event, one suppression, one answer.
    const replay = await providerEvent({
      type: 'unsubscribe', eventId: `${runId}-evt-unsub-early`, campaignId, sendId, slot: 1,
      recipientId: optedOutId, emailHash: identityOf(ADDRESS('opted-out')),
    });
    expect(replay.body).toMatchObject({ duplicate: true });
    expect(replay.body['inboxId']).toBe(unsubscribed.body['inboxId']);

    const suppressed = await sql<{ n: string }>`
      select count(*)::text as n from entity_records where entity_type = 'MarketingSuppression'
        and attrs ->> 'emailHash' = ${identityOf(ADDRESS('opted-out'))} and attrs ->> 'reason' = 'GlobalOptOut'
        and attrs ->> 'source' = 'ProviderWebhook' and deleted_at is null
    `.execute(ctx.database.db);
    expect(Number(suppressed.rows[0]?.n ?? '0')).toBe(1);

    const batch = await runBatch(sendId);
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    const outcome = (((batch.body['sends'] ?? []) as Body[])[0] ?? {}) as Body;
    expect(Number(outcome['sent'])).toBeGreaterThan(0);

    const rows = await ledgerRows(sendId);
    const byRecipient = new Map(rows.map((row) => [String(row['entity_id']), row]));

    // The consented person was mailed; the person who opted out in the meantime was not.
    expect(byRecipient.get(optedOutId)?.['state']).toBe('Blocked');
    const optOutProof = `${String(byRecipient.get(optedOutId)?.['category'])} ${JSON.stringify(byRecipient.get(optedOutId)?.['reasons'])} ${String(byRecipient.get(optedOutId)?.['error_code'])}`;
    expect(optOutProof).toMatch(/suppressedGlobal|optedOut|GLOBALLY_SUPPRESSED|OPTED_OUT/);
    expect(messagesTo(ADDRESS('opted-out'))).toHaveLength(0);
    expect(messagesTo(ADDRESS('no-consent'))).toHaveLength(0);
    expect(byRecipient.get(unknownId)?.['state']).toBe('Blocked');
    // The address a marketer blocked by hand is refused for the same reason, with its own code.
    expect(byRecipient.get(blockedId)?.['state']).toBe('Blocked');
    expect(`${String(byRecipient.get(blockedId)?.['category'])} ${JSON.stringify(byRecipient.get(blockedId)?.['reasons'])}`)
      .toMatch(/suppressedGlobal|GLOBALLY_SUPPRESSED/);
    expect(messagesTo(ADDRESS('blocked'))).toHaveLength(0);
    expect(messagesTo(ADDRESS('consented'))).toHaveLength(1);
    expect(byRecipient.get(consentedId)?.['state']).toBe('Sent');
    // Somebody the campaign excludes is still accounted for — blocked, with the exclusion named — but no
    // message is ever handed to a provider for them.
    expect(byRecipient.get(excludedId)?.['state']).toBe('Blocked');
    expect(`${String(byRecipient.get(excludedId)?.['category'])} ${JSON.stringify(byRecipient.get(excludedId)?.['reasons'])}`)
      .toMatch(/excludedBySegment|EXCLUDED_BY_TARGET_LIST/);
    expect(messagesTo(ADDRESS('excluded'))).toHaveLength(0);
    expect(sentMessages.length).toBeGreaterThan(before);

    // The message that left carried this recipient's own unsubscribe link, not a preview sentinel.
    const mailed = messagesTo(ADDRESS('consented'))[0];
    expect(mailed?.html ?? '').toContain('/marketing/preferences?token=');
    expect(mailed?.html ?? '').not.toContain('preview.invalid');
    expect(String(mailed?.idempotencyKey ?? '')).toMatch(/^ma:/);
  });

  it('step 6 — the tracking events are one event each, however many times the provider sends them', async () => {
    const sendId = sendIds[0] ?? '';
    const sequence = ['delivered', 'open', 'click'] as const;
    for (const type of sequence) {
      const first = await providerEvent({
        type, eventId: `${runId}-evt-${type}`, campaignId, sendId, slot: 1, recipientId: consentedId,
        ...(type === 'click' ? { url: 'https://example.test/pricing' } : {}),
        ...(type === 'delivered' ? { providerMessageId: 'scripted-1' } : {}),
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body['duplicate']).toBe(false);
      const again = await providerEvent({
        type, eventId: `${runId}-evt-${type}`, campaignId, sendId, slot: 1, recipientId: consentedId,
        ...(type === 'click' ? { url: 'https://example.test/pricing' } : {}),
      });
      expect(again.body['duplicate']).toBe(true);
    }

    const normalized = { delivered: 'delivered', open: 'opened', click: 'clicked' } as const;
    for (const type of sequence) {
      expect(await eventRows(campaignId, normalized[type])).toHaveLength(1);
    }

    // A forged delivery cannot occupy the genuine event's key.
    const forged = await providerEvent(
      { type: 'open', eventId: `${runId}-evt-forged`, campaignId, sendId, slot: 1, recipientId: consentedId },
      'the-wrong-secret',
    );
    expect(forged.status, JSON.stringify(forged.body)).toBe(200);
    expect(forged.body['processingStatus']).toBe('rejected');
    const genuine = await providerEvent({ type: 'open', eventId: `${runId}-evt-forged`, campaignId, sendId, slot: 1, recipientId: consentedId });
    expect(genuine.body['duplicate']).toBe(false);

    // What this door's "signature" really is today: the shared secret itself, compared equal, and a
    // timestamp that is only checked when the caller bothers to send one. Recorded as G33 — the platform's
    // other webhook doors sign the body and refuse a stale delivery outright.
    const staleWithoutTimestamp = await publicCall(
      'POST',
      `/api/v1/MarketingAutomation/webhook/${WEBHOOK_PROVIDER}`,
      { eventId: `${runId}-evt-stale`, type: 'open', campaignId, occurredAt: '2020-01-01T00:00:00.000Z', recipientEntityType: 'Contact', recipientEntityId: consentedId },
      { 'x-webhook-signature': WEBHOOK_SECRET },
    );
    expect(staleWithoutTimestamp.body['processingStatus']).toBe('processed');

    const stats = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/stats`);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    const delivery = (stats.body['delivery'] ?? {}) as Body;
    expect(Number(delivery['delivered'])).toBe(1);
    expect(Number(delivery['opened'])).toBe(3);
    expect(Number(delivery['clicked'])).toBe(1);

    // A bounce and a complaint are not just numbers: they block the next send through this door.
    const bouncedAddress = ADDRESS('bounced');
    await providerEvent({
      type: 'hard_bounce', eventId: `${runId}-evt-bounce`, campaignId, sendId, slot: 1,
      recipientId: 'a-recipient-that-is-not-a-record', emailHash: identityOf(bouncedAddress),
    });
    await providerEvent({
      type: 'spam_complaint', eventId: `${runId}-evt-complaint`, campaignId, sendId, slot: 1,
      recipientId: 'a-recipient-that-is-not-a-record', emailHash: identityOf(ADDRESS('complained')),
    });
    for (const address of [bouncedAddress, ADDRESS('complained')]) {
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from entity_records where entity_type = 'MarketingSuppression'
          and attrs ->> 'emailHash' = ${identityOf(address)} and deleted_at is null
      `.execute(ctx.database.db);
      expect(Number(rows.rows[0]?.n ?? '0'), address).toBe(1);
    }
  });

  it('step 7 — a retry hands the provider one message, never two', async () => {
    const created = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sends`, { slot: 2 });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const sendId = String(created.body['id']);
    sendIds.push(sendId);

    expect((await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/validate`, {})).status).toBe(200);
    expect((await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/approve`, { note: marker('retry approval') })).status).toBe(200);
    expect((await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/schedule`, {})).status).toBe(200);
    const queued = await call('POST', `/api/v1/MarketingAutomation/action/send/${sendId}/queue`, {});
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    if (typeof queued.body['deliveryJobId'] === 'string') jobIds.push(queued.body['deliveryJobId']);

    // This recipient was already mailed once by the first send, so the retry leg counts from here.
    const beforeRetry = messagesTo(ADDRESS('retry')).length;
    provider.failFor = { address: ADDRESS('retry'), kind: 'retryable', reasonCode: 'PROVIDER_TEMP_FAIL' };
    const failed = await runBatch(sendId);
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    const rows = await ledgerRows(sendId);
    const retryRow = rows.find((row) => row['entity_id'] === retryId);
    expect(retryRow?.['state']).toBe('Queued');
    // The attempt that failed handed this recipient nothing — and says why on the row.
    expect(messagesTo(ADDRESS('retry'))).toHaveLength(beforeRetry);
    expect(String(retryRow?.['error_code'] ?? '')).toBe('PROVIDER_TEMP_FAIL');

    // The second attempt is the same recipient, and the provider is handed one message for them.
    const second = await runBatch(sendId);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(messagesTo(ADDRESS('retry'))).toHaveLength(beforeRetry + 1);
    const after = await ledgerRows(sendId);
    expect(after.find((row) => row['entity_id'] === retryId)?.['state']).toBe('Sent');

    // A third sweep of a finished send sends nothing further.
    const third = await runBatch(sendId);
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    expect(messagesTo(ADDRESS('retry'))).toHaveLength(beforeRetry + 1);
    // This slot mailed everybody who is still eligible — the retry recipient among them, exactly once each.
    const attrs = await sendAttrs(sendId);
    expect(Number(attrs['sentCount'] ?? 0)).toBe(2);
  });

  it('step 8 — a suppressed address receives no automated test message either', async () => {
    const before = sentMessages.length;
    const allowed = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sendTest`, {
      recipients: [ADDRESS('friend')], confirm: true,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body['testSend']).toBe(true);
    expect(messagesTo(ADDRESS('friend'))).toHaveLength(1);
    expect(String(messagesTo(ADDRESS('friend'))[0]?.headers?.['X-Marketing-Test'])).toBe('true');

    const refused = await call('POST', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/sendTest`, {
      recipients: [ADDRESS('opted-out')], confirm: true,
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('TEST_RECIPIENT_SUPPRESSED');
    expect(messagesTo(ADDRESS('opted-out'))).toHaveLength(0);

    // A test send proves the path; it never counts as a campaign send.
    expect(sentMessages.length).toBe(before + 1);
    const stats = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/stats`);
    // A test send leaves no trace in the campaign's own counters: the 5 here are the one delivered, three
    // opened and one clicked event the log holds, none of them the test message.
    expect(Number(((stats.body['delivery'] ?? {}) as Body)['sent'])).toBe(5);
  });

  it('step 9 — a conversion is attributed as a model, and the report says so', async () => {
    const sendId = sendIds[0] ?? '';
    const recorded = await call('POST', '/api/v1/MarketingAutomation/action/attribution', {
      campaignId, sendId, outcome: 'converted', referenceType: 'Lead', referenceId: createdIds[0] ?? '',
      correlationId: `${runId}-conversion-1`,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body['duplicate']).toBe(false);

    // The same outcome reported again is one outcome: the report cannot be inflated by a retry.
    const replayed = await call('POST', '/api/v1/MarketingAutomation/action/attribution', {
      campaignId, sendId, outcome: 'converted', referenceType: 'Lead', referenceId: createdIds[0] ?? '',
      correlationId: `${runId}-conversion-1`,
    });
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body['duplicate']).toBe(true);

    const influenced = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/attribution?model=influenced`);
    expect(influenced.status, JSON.stringify(influenced.body)).toBe(200);
    expect(influenced.body['model']).toBe('influenced');
    expect(Number(influenced.body['conversions'])).toBe(1);
    expect(String(influenced.body['note'])).toContain('not additive');
    // No amount was ever supplied with this outcome, so the report claims no revenue.
    expect(Number(influenced.body['influencedRevenue'])).toBe(0);

    const firstTouch = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/attribution?model=first_touch`);
    expect(firstTouch.body['model']).toBe('first_touch');
    expect(String(firstTouch.body['note'])).toContain('single touch');

    const funnel = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/funnel`);
    expect(funnel.status, JSON.stringify(funnel.body)).toBe(200);
    const stages = ((funnel.body['stages'] ?? []) as Body[]).map((row) => String(row['stage']));
    expect(stages).toContain('delivered');
    expect(stages).toContain('conversion');
    expect(funnel.body['asOf']).toBeTruthy();
  });

  it('step 10 — Lead Score reads the engagement that really happened, and a repeat does not multiply it', async () => {
    const leadId = createdIds[0] ?? '';
    const sendId = sendIds[0] ?? '';

    for (const type of ['open', 'open', 'click']) {
      const res = await providerEvent({
        type, eventId: `${runId}-evt-lead-${type}-${Math.random().toString(36).slice(2, 8)}`,
        campaignId, sendId, slot: 1, recipientId: leadId, recipientType: 'Lead',
        ...(type === 'click' ? { url: 'https://example.test/pricing' } : {}),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const scored = await call('POST', '/api/v1/LeadScore/action/score/recalculate', { leadId });
    expect(scored.status, JSON.stringify(scored.body)).toBe(200);
    const attrs = await recordAttrs('Lead', leadId);
    expect(attrs['scoreValue']).toBe(40);
    expect(attrs['scoreModelId']).toBe(modelId);

    // The same engagement, delivered again: the event log does not grow, so neither does the score.
    const opened = await eventRows(campaignId, 'opened');
    for (const row of opened) {
      const replay = await providerEvent({
        type: 'open', eventId: String(row['provider_event_id'] ?? ''), campaignId, sendId, slot: 1,
        recipientId: leadId, recipientType: 'Lead',
      });
      expect(replay.body['duplicate']).toBe(true);
    }
    const rescored = await call('POST', '/api/v1/LeadScore/action/score/recalculate', { leadId });
    expect(rescored.status).toBe(200);
    expect((await recordAttrs('Lead', leadId))['scoreValue']).toBe(40);

    // An event that is not engagement does not move an engagement rule.
    await providerEvent({
      type: 'deferred', eventId: `${runId}-evt-lead-deferred`, campaignId, sendId, slot: 1,
      recipientId: leadId, recipientType: 'Lead',
    });
    await call('POST', '/api/v1/LeadScore/action/score/recalculate', { leadId });
    expect((await recordAttrs('Lead', leadId))['scoreValue']).toBe(40);
  });

  it('step 11 — the metrics answer for the person who is allowed to see them, and count the rest', async () => {
    const sendId = sendIds[0] ?? '';
    const outsiderRole = `ma22-outsider-${runId}`;
    await createTestRole(ctx, {
      id: outsiderRole,
      name: marker('outsider role'),
      permissions: {
        Campaign: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        MarketingSend: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        TargetList: { read: 'all', create: 'no', edit: 'no', delete: 'no' },
        Contact: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
        Lead: { read: 'no', create: 'no', edit: 'no', delete: 'no' },
      },
    });
    const outsider = await createTestUser(ctx, { userName: `ma22outsider${runId.slice(-6)}`, roleIds: [outsiderRole] });

    const recipients = await call('GET', `/api/v1/MarketingAutomation/action/send/${sendId}/recipients?limit=50`, undefined, outsider.token);
    expect(recipients.status, JSON.stringify(recipients.body)).toBe(200);
    const list = ((recipients.body['list'] ?? []) as Body[]).map((row) => String(row['entityId']));
    expect(list).not.toContain(consentedId);
    expect(Number(recipients.body['hidden'])).toBeGreaterThan(0);

    // The event log names the campaign's touches, not the people behind the ones this caller cannot read.
    const log = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/log?limit=100`, undefined, outsider.token);
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    const logRecords = ((log.body['records'] ?? []) as Body[]).map((row) => String(row['recipientEntityId'] ?? ''));
    expect(logRecords).not.toContain(consentedId);
    expect(Number(log.body['hidden'])).toBeGreaterThan(0);

    // A report never carries the address itself: the ledger holds a digest, not a copy.
    const preview = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/audiencePreview`, undefined, outsider.token);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(JSON.stringify(preview.body)).not.toContain(ADDRESS('consented'));

    expect(JSON.stringify(log.body)).not.toContain(ADDRESS('consented'));

    const stats = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/stats`, undefined, outsider.token);
    expect(stats.status).toBe(200);
    expect(JSON.stringify(stats.body)).not.toContain('@');

    // The stranger who cannot read the campaign at all is refused, not silently narrowed.
    const noAccessRole = `ma22-none-${runId}`;
    await createTestRole(ctx, {
      id: noAccessRole, name: marker('no marketing role'),
      permissions: { Campaign: { read: 'no', create: 'no', edit: 'no', delete: 'no' } },
    });
    const stranger = await createTestUser(ctx, { userName: `ma22stranger${runId.slice(-6)}`, roleIds: [noAccessRole] });
    const refused = await call('GET', `/api/v1/MarketingAutomation/action/campaign/${campaignId}/stats`, undefined, stranger.token);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
  });
});
