import type {
  ConnectionValidationResult,
  ConnectorContext,
  DeleteObjectInput,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchPageInput,
  FetchPageResult,
  NormalizedProviderEvent,
  NormalizeWebhookInput,
  UpsertObjectInput,
  VerifyWebhookInput,
  WebhookVerificationResult,
} from '../../connector-adapter.port.js';
import { CONNECTOR_CAPABILITY_SCHEMA_VERSION, type ConnectorCapabilities } from '../../provider-capabilities.js';
import { ProviderError } from '../../provider-error.js';
import { type ConnectorOperationFlags,OAuth2ConnectorBase } from '../kit/base-adapter.js';
import {
  buildUrl,
  ConnectorHttp,
  decodeCursor,
  encodeCursor,
  isJsonObject,
  readNumber,
  readString,
  readStringList,
} from '../kit/connector-kit.js';
import type { OAuth2ProviderConfig } from '../kit/oauth2-base.js';
import { verifyMailchimpStyleSignature } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.18 / 19-INT.20 — the Mailchimp connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.5; `19-INT.20`).
 *
 * Audience members and campaign activity, and **nothing else**. The plan is explicit that the
 * campaign builder, the journeys, the send queue, the unsubscribe UI and the consent policy stay
 * with `MarketingAutomation`. This connector reads signals; it never sends and it never decides.
 *
 * Three rules give the connector its shape:
 *
 *  1. **A suppressed member cannot be silently resubscribed.** A profile sync that would move a
 *     member from `unsubscribed`, `cleaned` or `pending` to `subscribed` is **refused** unless the
 *     mapped fields carry explicit consent evidence. This is enforced in the connector, at the
 *     boundary, because a mapping is configuration and consent is a product rule.
 *  2. **An external unsubscribe is propagated, not mirrored.** The connector turns an unsubscribe,
 *     a complaint and a hard bounce into distinct event types, and the module's consent bridge
 *     routes them to `MarketingSuppressionService` with the provider's own event id as the
 *     provenance. The event therefore reaches the consent service **before** any ordinary profile
 *     sync can undo it.
 *  3. **The connector's data centre is part of the connection.** Mailchimp's API is addressed per
 *     data centre (`us21.api.mailchimp.com`), so the connection carries the data centre in its
 *     `tenantRef`. A connection without one is refused rather than guessed at.
 */

export const MAILCHIMP_PROVIDER_KEY = 'mailchimp';

/** The provider's API version. */
export const MAILCHIMP_API_VERSION = '3.0';

/** The maximum page size Mailchimp honours. */
export const MAILCHIMP_MAX_PAGE_SIZE = 1000;

/** The object types this connector offers. */
export const MAILCHIMP_MEMBER_OBJECT = 'audienceMember';
export const MAILCHIMP_CAMPAIGN_OBJECT = 'campaign';

const MEMBER_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Member ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'email_address', label: 'Email address', type: 'string', required: true, unique: true, identifier: false, sensitive: true },
  { name: 'status', label: 'Status', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'unsubscribe_reason', label: 'Unsubscribe reason', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'merge_fields', label: 'Merge fields', type: 'object', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'tags', label: 'Tags', type: 'array', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'timestamp_opt', label: 'Opt-in timestamp', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'list_id', label: 'Audience ID', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
];

const CAMPAIGN_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Campaign ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'type', label: 'Type', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'subject_line', label: 'Subject line', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'send_time', label: 'Sent at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'emails_sent', label: 'Emails sent', type: 'number', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'list_id', label: 'Audience ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Mailchimp connector. */
export function mailchimpCapabilities(): ConnectorCapabilities {
  const member = {
    objectType: MAILCHIMP_MEMBER_OBJECT,
    label: 'Audience member',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: true,
    syncDirections: ['inbound', 'outbound'] as const,
    fullSync: true,
    incrementalSync: false,
    // Mailchimp's OAuth grants account-wide access; it publishes no per-object scope.
    requiredScopes: [] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: MAILCHIMP_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'personal' as const,
  };
  const campaign = {
    ...member,
    objectType: MAILCHIMP_CAMPAIGN_OBJECT,
    label: 'Campaign',
    create: false,
    update: false,
    delete: false,
    // A campaign is read-only: the CRM never builds, sends or edits a campaign.
    syncDirections: ['inbound'] as const,
    dataSensitivity: 'business' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [member, campaign],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  };
}

/** The OAuth 2.0 configuration of the Mailchimp connector. */
export const MAILCHIMP_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: MAILCHIMP_PROVIDER_KEY,
  authorizationEndpoint: 'https://login.mailchimp.com/oauth2/authorize',
  tokenEndpoint: 'https://login.mailchimp.com/oauth2/token',
  scopeSeparator: ' ',
  supportsPkce: true,
  tokenAuthMethod: 'client_secret_post',
  reportsGrantedScopes: false,
};

/** The cursor the connector writes. */
interface MailchimpCursor {
  readonly listIndex: number;
  readonly offset: number;
}

/** The member statuses that mean "this person must not be resubscribed by a profile sync". */
export const MAILCHIMP_SUPPRESSED_MEMBER_STATUSES = ['unsubscribed', 'cleaned', 'pending'] as const;

export interface MailchimpAdapterOptions {
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Mailchimp connector.
 */
export class MailchimpAdapter extends OAuth2ConnectorBase {
  override readonly providerKey = MAILCHIMP_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = MAILCHIMP_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = mailchimpCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: true,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: MailchimpAdapterOptions) {
    super({
      config: MAILCHIMP_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: MAILCHIMP_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /ping` answers with the account's data centre and needs no audience.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(context), '/ping'),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      return {
        ok: true,
        code: null,
        message: null,
        accountRef: readString(body, 'account_name') ?? context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      {
        objectType: MAILCHIMP_MEMBER_OBJECT,
        label: 'Audience member',
        fields: MEMBER_FIELDS,
        incremental: false,
        maxPageSize: MAILCHIMP_MAX_PAGE_SIZE,
      },
      {
        objectType: MAILCHIMP_CAMPAIGN_OBJECT,
        label: 'Campaign',
        fields: CAMPAIGN_FIELDS,
        incremental: false,
        maxPageSize: MAILCHIMP_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === MAILCHIMP_MEMBER_OBJECT) return MEMBER_FIELDS;
    if (objectType === MAILCHIMP_CAMPAIGN_OBJECT) return CAMPAIGN_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of the object set. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<MailchimpCursor>(input.cursor, MAILCHIMP_PROVIDER_KEY);
    const listIds = this.audienceIds(input.context);

    if (input.objectType === MAILCHIMP_CAMPAIGN_OBJECT) {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(input.context), '/campaigns', {
          count: this.clampPageSize(input.pageSize),
          ...(cursor === null ? {} : { offset: cursor.offset }),
        }),
        headers: this.authHeaders(input.context),
      });
      const body = isJsonObject(payload) ? payload : {};
      const campaigns = Array.isArray(body['campaigns']) ? (body['campaigns'] as unknown[]) : [];
      const total = readNumber(body, 'total_items') ?? campaigns.length;
      const nextOffset = (cursor?.offset ?? 0) + campaigns.length;
      return {
        objects: campaigns.filter(isJsonObject).map((campaign) => toCampaignObject(campaign)),
        nextCursor:
          nextOffset < total ? encodeCursor({ listIndex: 0, offset: nextOffset }) : null,
        cursorExpired: false,
      };
    }

    if (input.objectType !== MAILCHIMP_MEMBER_OBJECT) throw this.unknownObject(input.objectType);
    const listIndex = cursor?.listIndex ?? 0;
    if (listIndex >= listIds.length) return { objects: [], nextCursor: null, cursorExpired: false };
    const listId = listIds[listIndex] ?? '';
    const offset = cursor?.offset ?? 0;
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(this.baseUrl(input.context), `/lists/${encodeURIComponent(listId)}/members`, {
        count: this.clampPageSize(input.pageSize),
        offset,
      }),
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const members = Array.isArray(body['members']) ? (body['members'] as unknown[]) : [];
    const total = readNumber(body, 'total_items') ?? members.length;
    const nextOffset = offset + members.length;
    const nextCursor =
      nextOffset < total
        ? encodeCursor({ listIndex, offset: nextOffset })
        : listIndex + 1 < listIds.length
          ? encodeCursor({ listIndex: listIndex + 1, offset: 0 })
          : null;
    return {
      objects: members.filter(isJsonObject).map((member) => toMemberObject(member, listId)),
      nextCursor,
      cursorExpired: false,
    };
  }

  /**
   * Create or update one audience member.
   *
   * A write that would **resubscribe** a suppressed member is refused unless the mapped fields
   * carry explicit consent evidence. The rule is checked against the provider's current state, so
   * a stale CRM record cannot undo a suppression that the provider already knows about.
   */
  async upsertObject(input: UpsertObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== MAILCHIMP_MEMBER_OBJECT) throw this.unknownObject(input.objectType);
    const http = this.httpFactory(input.context.connectionId);
    const listId = input.externalParentId ?? this.audienceIds(input.context)[0] ?? '';
    if (listId === '') {
      throw new ProviderError('CONFIGURATION_INVALID', 'The connection names no audience to sync.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_audience',
      });
    }
    const status = typeof input.fields['status'] === 'string' ? input.fields['status'] : null;
    if (status === 'subscribed') {
      await this.assertResubscribeIsAllowed(http, input.context, listId, input.externalId, input.fields);
    }
    const body = toMemberBody(input.fields);
    const path = `/lists/${encodeURIComponent(listId)}/members`;
    const url =
      input.externalId === null
        ? buildUrl(this.baseUrl(input.context), path)
        : buildUrl(this.baseUrl(input.context), `${path}/${encodeURIComponent(input.externalId)}`);
    const payload = await http.json<unknown>({
      method: input.externalId === null ? 'POST' : 'PATCH',
      url,
      headers: { ...this.authHeaders(input.context), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = isJsonObject(payload) ? payload : {};
    return {
      externalId: readString(answer, 'id') ?? input.externalId ?? '',
      version: null,
      updatedAt: null,
      created: input.externalId === null,
    };
  }

  /** Remove one audience member. */
  async deleteObject(input: DeleteObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== MAILCHIMP_MEMBER_OBJECT) throw this.unknownObject(input.objectType);
    const http = this.httpFactory(input.context.connectionId);
    const listId = input.externalParentId ?? this.audienceIds(input.context)[0] ?? '';
    await http.raw({
      method: 'DELETE',
      url: buildUrl(
        this.baseUrl(input.context),
        `/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(input.externalId)}`,
      ),
      headers: this.authHeaders(input.context),
    });
    return { externalId: input.externalId, version: null, updatedAt: null, created: false };
  }

  /**
   * Verify a Mailchimp webhook.
   *
   * Mailchimp's documented scheme is a digest of the raw body and the webhook secret; the
   * comparison is constant-time. The scheme is the vendor's, and the platform compensates by
   * requiring a per-connection secret rather than a shared one.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const verification = verifyMailchimpStyleSignature({
      rawBody: input.rawBody,
      secret: input.context.credential.webhookSecret,
      header: readHeader(input.headers, 'x-mailchimp-signature'),
    });
    return { valid: verification.valid, reason: verification.reason, challenge: null };
  }

  /**
   * Turn a Mailchimp webhook into normalized events.
   *
   * The event types are the ones the consent bridge understands: an unsubscribe, a complaint and
   * a hard bounce are three different facts and must not be collapsed into one.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    if (!isJsonObject(body)) return [];
    const type = readString(body, 'type') ?? '';
    const data = isJsonObject(body['data']) ? body['data'] : {};
    const firedAt = readString(body, 'fired_at');
    const listId = readString(data, 'list_id') ?? '';
    const memberId = readString(data, 'id') ?? '';
    const email = readString(data, 'email') ?? '';
    const reason = readString(data, 'unsubscribe_reason') ?? '';

    let eventType = `${MAILCHIMP_MEMBER_OBJECT}.updated`;
    if (type === 'unsubscribe') {
      eventType = /complaint|spam/i.test(reason)
        ? `${MAILCHIMP_MEMBER_OBJECT}.complained`
        : `${MAILCHIMP_MEMBER_OBJECT}.unsubscribed`;
    } else if (type === 'cleaned') {
      eventType = `${MAILCHIMP_MEMBER_OBJECT}.bounced`;
    } else if (type === 'subscribe') {
      eventType = `${MAILCHIMP_MEMBER_OBJECT}.subscribed`;
    } else if (type === 'campaign_sent') {
      eventType = `${MAILCHIMP_CAMPAIGN_OBJECT}.sent`;
    }

    const deliveryId = memberId === '' ? '' : `${listId}:${memberId}:${type}:${firedAt ?? ''}`;
    if (deliveryId === '') return [];
    return [
      {
        deliveryId,
        objectType: type === 'campaign_sent' ? MAILCHIMP_CAMPAIGN_OBJECT : MAILCHIMP_MEMBER_OBJECT,
        externalId: memberId === '' ? null : memberId,
        eventType,
        occurredAt: firedAt,
        fields: { listId, memberId, email, reason, type },
        deleted: false,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Refuse a resubscribe that has no consent evidence.
   *
   * The provider's current state is read first, so a CRM record that is out of date cannot undo a
   * suppression the provider already applied.
   */
  private async assertResubscribeIsAllowed(
    http: ConnectorHttp,
    context: ConnectorContext,
    listId: string,
    externalId: string | null,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const evidence = fields['consentEvidence'];
    const hasEvidence = typeof evidence === 'string' && evidence.trim() !== '';
    if (hasEvidence) return;
    if (externalId === null) return;
    const current = await this.readMemberStatus(http, context, listId, externalId);
    if (current === null) return;
    if (!MAILCHIMP_SUPPRESSED_MEMBER_STATUSES.includes(current as (typeof MAILCHIMP_SUPPRESSED_MEMBER_STATUSES)[number])) {
      return;
    }
    throw new ProviderError(
      'CONFLICT',
      `The member is "${current}" at the provider. A profile sync may not resubscribe them without explicit consent evidence.`,
      { category: 'conflict', retryable: false, detail: `member_${current}` },
    );
  }

  /** The member's current status at the provider, or `null` when it cannot be read. */
  private async readMemberStatus(
    http: ConnectorHttp,
    context: ConnectorContext,
    listId: string,
    externalId: string,
  ): Promise<string | null> {
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(
          this.baseUrl(context),
          `/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(externalId)}`,
        ),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      return readString(body, 'status');
    } catch {
      // A member that cannot be read is not treated as suppressed: the write is then allowed, and
      // the provider itself remains the authority on what it accepts.
      return null;
    }
  }

  /** The API base URL of the connection's data centre. */
  private baseUrl(context: ConnectorContext): string {
    const dataCenter = (context.tenantRef ?? '').trim();
    if (!/^[a-z]{2,3}\d{1,2}$/.test(dataCenter)) {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        'The connection does not name a Mailchimp data centre. Set the provider account to a value such as "us21".',
        { category: 'configuration_invalid', retryable: false, detail: 'no_data_center' },
      );
    }
    return `https://${dataCenter}.api.mailchimp.com/${MAILCHIMP_API_VERSION}`;
  }

  /** The audiences this connection syncs. */
  private audienceIds(context: ConnectorContext): readonly string[] {
    return readStringList(context.options, 'audienceIds');
  }

  private authHeaders(context: ConnectorContext): Record<string, string> {
    const token = context.credential.accessToken;
    if (token === null) {
      throw new ProviderError('TOKEN_EXPIRED', 'The connection holds no access token.', {
        category: 'authorization',
        retryable: false,
        detail: 'no_access_token',
      });
    }
    return { authorization: `Bearer ${token}` };
  }

  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return MAILCHIMP_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), MAILCHIMP_MAX_PAGE_SIZE);
  }

  private unknownObject(objectType: string): ProviderError {
    return new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  private failure(error: unknown): ConnectionValidationResult {
    if (error instanceof ProviderError) {
      return { ok: false, code: error.code, message: error.message, accountRef: null, grantedScopes: [] };
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Mailchimp could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The external shape of one audience member. */
function toMemberObject(member: Record<string, unknown>, listId: string): ExternalObject {
  const id = readString(member, 'id') ?? '';
  const tags = Array.isArray(member['tags']) ? (member['tags'] as unknown[]) : [];
  return {
    objectType: MAILCHIMP_MEMBER_OBJECT,
    externalId: id,
    externalParentId: listId,
    fields: {
      id,
      email_address: readString(member, 'email_address') ?? '',
      status: readString(member, 'status') ?? '',
      unsubscribe_reason: readString(member, 'unsubscribe_reason') ?? '',
      merge_fields: isJsonObject(member['merge_fields']) ? member['merge_fields'] : {},
      tags: tags.map((tag) => (isJsonObject(tag) ? readString(tag, 'name') : '')).filter((name) => name !== ''),
      timestamp_opt: readString(member, 'timestamp_opt') ?? '',
      list_id: readString(member, 'list_id') ?? listId,
    },
    updatedAt: readString(member, 'timestamp_opt'),
    version: null,
    deleted: false,
  };
}

/** The external shape of one campaign. */
function toCampaignObject(campaign: Record<string, unknown>): ExternalObject {
  const id = readString(campaign, 'id') ?? '';
  return {
    objectType: MAILCHIMP_CAMPAIGN_OBJECT,
    externalId: id,
    externalParentId: readString(campaign, 'list_id'),
    fields: {
      id,
      type: readString(campaign, 'type') ?? '',
      status: readString(campaign, 'status') ?? '',
      subject_line: readString(campaign, 'subject_line') ?? '',
      send_time: readString(campaign, 'send_time') ?? '',
      emails_sent: readNumber(campaign, 'emails_sent') ?? 0,
      list_id: readString(campaign, 'list_id') ?? '',
    },
    updatedAt: readString(campaign, 'send_time'),
    version: null,
    deleted: false,
  };
}

/** The Mailchimp body of a member, built from a mapped field set. */
function toMemberBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['email_address'] === 'string') body['email_address'] = fields['email_address'];
  if (typeof fields['status'] === 'string') body['status'] = fields['status'];
  if (isJsonObject(fields['merge_fields'])) body['merge_fields'] = fields['merge_fields'];
  return body;
}

/** Read a header in a case-insensitive way. */
function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
