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
import { readChallenge } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.21 — the Meta Lead Ads connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.6; `19-INT.21`).
 *
 * Lead form submissions, imported into CRM Leads.
 *
 * The rules that shape this connector:
 *
 *  1. **The submission id is the identity.** Meta's lead id is stable and unique per submission,
 *     so the same submission imported twice resolves to the same CRM record. The form id is carried
 *     as the *parent*, so a submission is scoped to the form it came from.
 *  2. **Only the fields the administrator selected leave the provider.** The connector's schema
 *     lists the fields a form may hold; a mapping decides which of them are imported. Nothing is
 *     invented, and a field the provider did not return is absent rather than empty.
 *  3. **Consent provenance is carried, not inferred.** The form's consent fields travel with the
 *     submission, so a CRM Lead can answer where its consent evidence came from.
 *  4. **A missing or revoked permission pauses the connector instead of retrying.** A `403` from
 *     Graph is an authorization failure, which the platform classifies as permanent: it moves the
 *     connection to `reauthorization_required` rather than consuming quota on a request that can
 *     never succeed.
 */

export const META_LEAD_ADS_PROVIDER_KEY = 'meta-lead-ads';

/** The Graph API version, pinned deliberately. */
export const META_GRAPH_API_VERSION = 'v21.0';

/** The maximum page size the Graph API honours for a lead listing. */
export const META_MAX_PAGE_SIZE = 100;

/** The object types this connector offers. */
export const META_LEAD_OBJECT = 'lead';
export const META_LEAD_FORM_OBJECT = 'leadForm';

const LEAD_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Submission ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'form_id', label: 'Form ID', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'page_id', label: 'Page ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created_time', label: 'Submitted at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'field_data', label: 'Answers', type: 'object', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'campaign_id', label: 'Campaign ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'ad_id', label: 'Ad ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'consent', label: 'Consent evidence', type: 'object', required: false, unique: false, identifier: false, sensitive: true },
];

const LEAD_FORM_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Form ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'name', label: 'Form name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'page_id', label: 'Page ID', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Meta Lead Ads connector. */
export function metaLeadAdsCapabilities(): ConnectorCapabilities {
  const lead = {
    objectType: META_LEAD_OBJECT,
    label: 'Lead form submission',
    read: true,
    create: false,
    update: false,
    delete: false,
    upsert: false,
    webhook: true,
    syncDirections: ['inbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: ['ads_read'] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: META_MAX_PAGE_SIZE,
    rateLimitStrategy: 'provider_header' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'not_synchronized' as const,
    transactional: false,
    dataSensitivity: 'personal' as const,
  };
  const leadForm = {
    ...lead,
    objectType: META_LEAD_FORM_OBJECT,
    label: 'Lead form',
    webhook: false,
    incrementalSync: false,
    dataSensitivity: 'business' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [lead, leadForm],
    webhook: { supported: true, requiresRawBody: false, requiresEndpointValidation: true },
  };
}

/** The OAuth 2.0 configuration of the Meta Lead Ads connector. */
export const META_LEAD_ADS_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: META_LEAD_ADS_PROVIDER_KEY,
  authorizationEndpoint: `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`,
  tokenEndpoint: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
  scopeSeparator: ',',
  supportsPkce: true,
  tokenAuthMethod: 'client_secret_post',
  reportsGrantedScopes: true,
};

/** The cursor the connector writes. */
interface MetaCursor {
  readonly formIndex: number;
  readonly after: string | null;
}

export interface MetaLeadAdsAdapterOptions {
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Meta Lead Ads connector.
 */
export class MetaLeadAdsAdapter extends OAuth2ConnectorBase {
  override readonly providerKey = META_LEAD_ADS_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = META_GRAPH_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = metaLeadAdsCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: MetaLeadAdsAdapterOptions) {
    super({
      config: META_LEAD_ADS_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: META_LEAD_ADS_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /me` reads the token's own identity and needs no business asset.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(), '/me', { fields: 'id,name' }),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      return {
        ok: true,
        code: null,
        message: null,
        accountRef: readString(body, 'id') ?? context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      {
        objectType: META_LEAD_OBJECT,
        label: 'Lead form submission',
        fields: LEAD_FIELDS,
        incremental: true,
        maxPageSize: META_MAX_PAGE_SIZE,
      },
      {
        objectType: META_LEAD_FORM_OBJECT,
        label: 'Lead form',
        fields: LEAD_FORM_FIELDS,
        incremental: false,
        maxPageSize: META_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === META_LEAD_OBJECT) return LEAD_FIELDS;
    if (objectType === META_LEAD_FORM_OBJECT) return LEAD_FORM_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of submissions or forms. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<MetaCursor>(input.cursor, META_LEAD_ADS_PROVIDER_KEY);
    if (input.objectType === META_LEAD_FORM_OBJECT) {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(), `/${encodeURIComponent(this.accountId(input.context))}/leadgen_forms`, {
          limit: this.clampPageSize(input.pageSize),
        }),
        headers: this.authHeaders(input.context),
      });
      const body = isJsonObject(payload) ? payload : {};
      const forms = Array.isArray(body['data']) ? (body['data'] as unknown[]) : [];
      return {
        objects: forms.filter(isJsonObject).map((form) => toLeadFormObject(form)),
        nextCursor: null,
        cursorExpired: false,
      };
    }
    if (input.objectType !== META_LEAD_OBJECT) throw this.unknownObject(input.objectType);

    const formIds = this.formIds(input.context);
    const formIndex = cursor?.formIndex ?? 0;
    if (formIndex >= formIds.length) return { objects: [], nextCursor: null, cursorExpired: false };
    const formId = formIds[formIndex] ?? '';
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(this.baseUrl(), `/${encodeURIComponent(formId)}/leads`, {
        limit: this.clampPageSize(input.pageSize),
        ...(cursor?.after === null || cursor?.after === undefined ? {} : { after: cursor.after }),
        ...(input.since === null ? {} : { since: Math.floor(new Date(input.since).getTime() / 1000) }),
      }),
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const leads = Array.isArray(body['data']) ? (body['data'] as unknown[]) : [];
    const paging = isJsonObject(body['paging']) ? body['paging'] : {};
    const cursors = isJsonObject(paging['cursors']) ? paging['cursors'] : {};
    const after = readString(cursors, 'after');
    return {
      objects: leads.filter(isJsonObject).map((lead) => toLeadObject(lead, formId)),
      nextCursor:
        after === null || after === undefined
          ? formIndex + 1 < formIds.length
            ? encodeCursor({ formIndex: formIndex + 1, after: null })
            : null
          : encodeCursor({ formIndex, after }),
      cursorExpired: false,
    };
  }

  /**
   * Meta submissions are never written.
   *
   * A lead form submission is a fact the person made, not a record the CRM may edit at the
   * provider. The connector therefore declares no write operation.
   */
  async upsertObject(_input: UpsertObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError('CONFIGURATION_INVALID', 'The Meta connector is read-only.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'read_only',
    });
  }

  /** Meta submissions are never deleted at the provider. */
  async deleteObject(_input: DeleteObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError('CONFIGURATION_INVALID', 'The Meta connector is read-only.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'read_only',
    });
  }

  /**
   * Verify a Meta webhook.
   *
   * Meta validates an endpoint by calling it with a challenge and expecting it back. There is no
   * signature: the challenge **is** the verification.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const challenge = readChallenge(input.query, ['hub.challenge']);
    if (challenge !== null) return { valid: true, reason: null, challenge };
    const mode = readChallenge(input.query, ['hub.mode']);
    if (mode === 'subscribe') return { valid: true, reason: null, challenge: null };
    return { valid: false, reason: 'missing_challenge', challenge: null };
  }

  /**
   * Turn a Meta webhook into normalized events.
   *
   * The delivery id is derived from the entry id, the change field and the lead id, so the same
   * change delivered twice is processed once.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    if (!isJsonObject(body)) return [];
    const entries = Array.isArray(body['entry']) ? (body['entry'] as unknown[]) : [];
    const events: NormalizedProviderEvent[] = [];
    for (const entry of entries) {
      if (!isJsonObject(entry)) continue;
      const entryId = readString(entry, 'id') ?? '';
      const changes = Array.isArray(entry['changes']) ? (entry['changes'] as unknown[]) : [];
      for (const change of changes) {
        if (!isJsonObject(change)) continue;
        const field = readString(change, 'field') ?? 'lead';
        const value = isJsonObject(change['value']) ? change['value'] : {};
        const leadId = readString(value, 'lead_id') ?? readString(value, 'id');
        const formId = readString(value, 'form_id') ?? '';
        events.push({
          deliveryId: `${entryId}:${field}:${leadId ?? ''}`,
          objectType: META_LEAD_OBJECT,
          externalId: leadId ?? null,
          eventType: `lead.${field}`,
          occurredAt: null,
          fields: { ...value, formId },
          deleted: field === 'leadgen' && readString(value, 'action_type') === 'delete',
        });
      }
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private baseUrl(): string {
    return `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
  }

  /** The business account the connection acts for. */
  private accountId(context: ConnectorContext): string {
    const configured = (context.tenantRef ?? '').trim();
    if (configured === '') {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        'The connection does not name a Meta business account. Set the provider account to the ad account id.',
        { category: 'configuration_invalid', retryable: false, detail: 'no_account' },
      );
    }
    return configured;
  }

  /** The lead forms the connection imports. */
  private formIds(context: ConnectorContext): readonly string[] {
    return readStringList(context.options, 'leadFormIds');
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
    if (!Number.isFinite(pageSize) || pageSize <= 0) return META_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), META_MAX_PAGE_SIZE);
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
      message: 'Meta could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The external shape of one lead form. */
function toLeadFormObject(form: Record<string, unknown>): ExternalObject {
  const id = readString(form, 'id') ?? '';
  return {
    objectType: META_LEAD_FORM_OBJECT,
    externalId: id,
    externalParentId: null,
    fields: {
      id,
      name: readString(form, 'name') ?? '',
      page_id: readString(form, 'page_id') ?? '',
      status: readString(form, 'status') ?? '',
    },
    updatedAt: null,
    version: null,
    deleted: false,
  };
}

/** The external shape of one lead submission. */
function toLeadObject(lead: Record<string, unknown>, formId: string): ExternalObject {
  const id = readString(lead, 'id') ?? '';
  const answers = isJsonObject(lead['field_data']) ? lead['field_data'] : {};
  const createdTime = readString(lead, 'created_time');
  return {
    objectType: META_LEAD_OBJECT,
    externalId: id,
    externalParentId: readString(lead, 'form_id') ?? formId,
    fields: {
      id,
      form_id: readString(lead, 'form_id') ?? formId,
      page_id: readString(lead, 'page_id') ?? '',
      created_time: createdTime ?? '',
      field_data: answers,
      campaign_id: readString(lead, 'campaign_id') ?? '',
      ad_id: readString(lead, 'ad_id') ?? '',
      // The consent fields the form collected, kept as they arrived.
      consent: extractConsent(answers),
    },
    updatedAt: createdTime,
    version: null,
    deleted: false,
  };
}

/**
 * The consent answers of a submission.
 *
 * A form may name its consent field anything, so every answer whose name mentions consent, terms
 * or marketing is kept. Nothing is interpreted: the CRM receives the evidence, and the CRM's own
 * consent policy decides what it means.
 */
function extractConsent(answers: Record<string, unknown>): Record<string, unknown> {
  const consent: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!/consent|terms|marketing|privacy|opt_?in/i.test(key)) continue;
    consent[key] = value;
  }
  return consent;
}

/** The number of a value, when it is one. */
export function readLeadNumber(source: Record<string, unknown>, key: string): number | null {
  return readNumber(source, key);
}
