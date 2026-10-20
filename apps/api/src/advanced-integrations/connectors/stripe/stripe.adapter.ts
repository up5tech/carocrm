import type {
  ConnectionValidationResult,
  ConnectorContext,
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
import { AbstractConnectorAdapter, type ConnectorOperationFlags } from '../kit/base-adapter.js';
import {
  buildUrl,
  ConnectorHttp,
  decodeCursor,
  encodeCursor,
  isJsonObject,
  readNumber,
  readString,
} from '../kit/connector-kit.js';
import { verifyStripeStyleSignature } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.19 — the Stripe connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4; `19-INT.19`).
 *
 * This is the most sensitive connector in the module, so the design is deliberately **narrow**.
 *
 *  - **It cannot write.** Every object it declares is read-only and inbound-only. A generic sync
 *    path therefore *cannot* create a Stripe charge, a refund or a payment link, and it cannot
 *    write a CRM payment either — which is exactly how the plan's requirement is met
 *    (*"Verify no generic sync path bypasses Sales financial invariants"*). The financial
 *    transition happens in `PaymentService.ingestProviderEvent`, which is idempotent, audited and
 *    refuses a payload that looks like card data.
 *  - **The signature is verified over the raw body.** Stripe signs `<timestamp>.<raw body>`; a
 *    re-serialized body has a different signature, so the raw bytes are mandatory and the ingress
 *    is configured to capture them for this provider.
 *  - **The provider's own event id is the idempotency key.** Stripe's `event.id` is unique and
 *    stable, so a duplicate delivery is recognised without inventing a hash.
 *  - **Test mode and live mode are separated by the credential, not by a second database.** The
 *    mode is read from the key prefix and reported to the operator; there is exactly one CRM.
 *  - **No card data is ever stored.** The connector exposes amounts, currencies and states — never
 *    a card number, a CVC or a client secret.
 */

export const STRIPE_PROVIDER_KEY = 'stripe';

/** The provider's API version, pinned deliberately. */
export const STRIPE_API_VERSION = 'v1';

/** The maximum page size Stripe honours. */
export const STRIPE_MAX_PAGE_SIZE = 100;

/** The object types this connector offers. */
export const STRIPE_PAYMENT_INTENT_OBJECT = 'paymentIntent';
export const STRIPE_CUSTOMER_OBJECT = 'customer';
export const STRIPE_CHECKOUT_SESSION_OBJECT = 'checkoutSession';

const PAYMENT_INTENT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Payment intent ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'amount', label: 'Amount', type: 'number', required: true, unique: false, identifier: false, sensitive: true },
  { name: 'currency', label: 'Currency', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'customer', label: 'Customer', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created', label: 'Created at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'description', label: 'Description', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
];

const CUSTOMER_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Customer ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'email', label: 'Email', type: 'string', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'name', label: 'Name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created', label: 'Created at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
];

const CHECKOUT_SESSION_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Session ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'amount_total', label: 'Total', type: 'number', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'currency', label: 'Currency', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'customer', label: 'Customer', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'payment_intent', label: 'Payment intent', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created', label: 'Created at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Stripe connector. */
export function stripeCapabilities(): ConnectorCapabilities {
  const readOnly = {
    read: true,
    create: false,
    update: false,
    delete: false,
    upsert: false,
    webhook: true,
    // Inbound only: a provider record is read into the CRM, never written back.
    syncDirections: ['inbound'] as const,
    fullSync: true,
    incrementalSync: false,
    requiredScopes: [] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: STRIPE_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    deletionVisibility: 'not_synchronized' as const,
    transactional: false,
  };
  const paymentIntent = {
    ...readOnly,
    objectType: STRIPE_PAYMENT_INTENT_OBJECT,
    label: 'Payment intent',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'financial' as const,
  };
  const customer = {
    ...readOnly,
    objectType: STRIPE_CUSTOMER_OBJECT,
    label: 'Customer',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'personal' as const,
  };
  const checkoutSession = {
    ...readOnly,
    objectType: STRIPE_CHECKOUT_SESSION_OBJECT,
    label: 'Checkout session',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'financial' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'api_key',
    objects: [paymentIntent, customer, checkoutSession],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  };
}

/** The cursor the connector writes. */
interface StripeCursor {
  readonly startingAfter: string | null;
}

/** The mode a Stripe key belongs to. */
export const STRIPE_KEY_MODES = ['test', 'live', 'restricted', 'unknown'] as const;
export type StripeKeyMode = (typeof STRIPE_KEY_MODES)[number];

/**
 * The mode a Stripe API key belongs to.
 *
 * The mode is a property of the **credential**, which is how the plan requires test and live to be
 * separated. There is no second CRM database and no second connector.
 */
export function stripeKeyMode(apiKey: string | null): StripeKeyMode {
  if (apiKey === null) return 'unknown';
  if (apiKey.startsWith('sk_test_')) return 'test';
  if (apiKey.startsWith('sk_live_')) return 'live';
  if (apiKey.startsWith('rk_test_')) return 'test';
  if (apiKey.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

export interface StripeAdapterOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Stripe connector.
 */
export class StripeAdapter extends AbstractConnectorAdapter {
  override readonly providerKey = STRIPE_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = STRIPE_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = stripeCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    // The connector cannot write. A charge, a refund or a payment link is never created here.
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: StripeAdapterOptions = {}) {
    super();
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: STRIPE_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /v1/account` is read-only, free of charge and free of side effects.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl('https://api.stripe.com', `/${STRIPE_API_VERSION}/account`),
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
        objectType: STRIPE_PAYMENT_INTENT_OBJECT,
        label: 'Payment intent',
        fields: PAYMENT_INTENT_FIELDS,
        incremental: false,
        maxPageSize: STRIPE_MAX_PAGE_SIZE,
      },
      {
        objectType: STRIPE_CUSTOMER_OBJECT,
        label: 'Customer',
        fields: CUSTOMER_FIELDS,
        incremental: false,
        maxPageSize: STRIPE_MAX_PAGE_SIZE,
      },
      {
        objectType: STRIPE_CHECKOUT_SESSION_OBJECT,
        label: 'Checkout session',
        fields: CHECKOUT_SESSION_FIELDS,
        incremental: false,
        maxPageSize: STRIPE_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === STRIPE_PAYMENT_INTENT_OBJECT) return PAYMENT_INTENT_FIELDS;
    if (objectType === STRIPE_CUSTOMER_OBJECT) return CUSTOMER_FIELDS;
    if (objectType === STRIPE_CHECKOUT_SESSION_OBJECT) return CHECKOUT_SESSION_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of the object set. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    const path = this.pathFor(input.objectType);
    if (path === null) throw this.unknownObject(input.objectType);
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<StripeCursor>(input.cursor, STRIPE_PROVIDER_KEY);
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl('https://api.stripe.com', `/${STRIPE_API_VERSION}${path}`, {
        limit: this.clampPageSize(input.pageSize),
        ...(cursor?.startingAfter === null || cursor === null ? {} : { starting_after: cursor.startingAfter }),
      }),
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const data = Array.isArray(body['data']) ? (body['data'] as unknown[]) : [];
    const hasMore = body['has_more'] === true;
    const last = data.length > 0 ? data[data.length - 1] : null;
    const lastId = isJsonObject(last) ? readString(last, 'id') : null;
    return {
      objects: data.filter(isJsonObject).map((entry) => toExternalObject(input.objectType, entry)),
      nextCursor:
        hasMore && lastId !== null ? encodeCursor({ startingAfter: lastId }) : null,
      cursorExpired: false,
    };
  }

  /**
   * Stripe objects are never written.
   *
   * The method exists only to refuse clearly: a caller that asks the connector to write gets a
   * precise, permanent answer rather than a `TypeError` from deep inside the adapter.
   */
  async upsertObject(_input: UpsertObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError(
      'CONFIGURATION_INVALID',
      'The Stripe connector is read-only. A payment transition is applied through the Sales domain service.',
      { category: 'configuration_invalid', retryable: false, detail: 'read_only' },
    );
  }

  /**
   * Verify a Stripe webhook.
   *
   * The signature covers `<timestamp>.<raw body>` and the timestamp must be inside the tolerance
   * window, so a captured delivery cannot be replayed later.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const verification = verifyStripeStyleSignature({
      rawBody: input.rawBody,
      secret: input.context.credential.webhookSecret,
      header: readHeader(input.headers, 'stripe-signature'),
    });
    return { valid: verification.valid, reason: verification.reason, challenge: null };
  }

  /**
   * Turn a Stripe event into a normalized event.
   *
   * The delivery id is Stripe's own `event.id`, which is unique and stable — the deduplication
   * needs no invented key.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    if (!isJsonObject(body)) return [];
    const deliveryId = readString(body, 'id');
    const eventType = readString(body, 'type') ?? '';
    if (deliveryId === null || deliveryId === '') return [];
    const data = isJsonObject(body['data']) ? body['data'] : {};
    const object = isJsonObject(data['object']) ? data['object'] : {};
    const created = readNumber(body, 'created');
    return [
      {
        deliveryId,
        objectType: objectTypeFor(eventType),
        externalId: readString(object, 'id'),
        eventType,
        occurredAt: created === null ? null : new Date(created * 1000).toISOString(),
        fields: { ...object },
        deleted: false,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private pathFor(objectType: string): string | null {
    if (objectType === STRIPE_PAYMENT_INTENT_OBJECT) return '/payment_intents';
    if (objectType === STRIPE_CUSTOMER_OBJECT) return '/customers';
    if (objectType === STRIPE_CHECKOUT_SESSION_OBJECT) return '/checkout/sessions';
    return null;
  }

  private authHeaders(context: ConnectorContext): Record<string, string> {
    const key = context.credential.apiKey;
    if (key === null || key === '') {
      throw new ProviderError('CONFIGURATION_INVALID', 'The connection holds no Stripe API key.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_api_key',
      });
    }
    return { authorization: `Bearer ${key}` };
  }

  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return STRIPE_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), STRIPE_MAX_PAGE_SIZE);
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
      message: 'Stripe could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The object type a Stripe event type belongs to. */
export function objectTypeFor(eventType: string): string {
  if (eventType.startsWith('payment_intent.')) return STRIPE_PAYMENT_INTENT_OBJECT;
  if (eventType.startsWith('customer.')) return STRIPE_CUSTOMER_OBJECT;
  if (eventType.startsWith('checkout.session.')) return STRIPE_CHECKOUT_SESSION_OBJECT;
  return 'stripeEvent';
}

/**
 * The **summary** of a Stripe event that may be handed to a domain service.
 *
 * It deliberately contains no card data, no client secret and no payment method — only the facts
 * a payment transition needs. The domain service refuses a payload that looks like card data, and
 * this keeps the connector on the right side of that rule as well.
 */
export function stripeEventSummary(eventType: string, object: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: readString(object, 'id') ?? '',
    status: readString(object, 'status') ?? '',
    currency: readString(object, 'currency') ?? '',
  };
  const amount = readNumber(object, 'amount');
  if (amount !== null) summary['amount'] = amount;
  const amountTotal = readNumber(object, 'amount_total');
  if (amountTotal !== null) summary['amountTotal'] = amountTotal;
  const customer = readString(object, 'customer');
  if (customer !== null) summary['customer'] = customer;
  const paymentIntent = readString(object, 'payment_intent');
  if (paymentIntent !== null) summary['paymentIntent'] = paymentIntent;
  const description = readString(object, 'description');
  if (description !== null) summary['description'] = description;
  const metadata = isJsonObject(object['metadata']) ? object['metadata'] : null;
  const paymentRequestId =
    metadata === null ? null : readString(metadata, 'crm_payment_request_id') ?? readString(metadata, 'paymentRequestId');
  if (paymentRequestId !== null) summary['paymentRequestId'] = paymentRequestId;
  summary['eventType'] = eventType;
  return summary;
}

/** The external shape of one Stripe object. */
function toExternalObject(objectType: string, entry: Record<string, unknown>): ExternalObject {
  const id = readString(entry, 'id') ?? '';
  const created = readNumber(entry, 'created');
  const fields: Record<string, unknown> = { id };
  if (objectType === STRIPE_PAYMENT_INTENT_OBJECT) {
    fields['amount'] = readNumber(entry, 'amount') ?? 0;
    fields['currency'] = readString(entry, 'currency') ?? '';
    fields['status'] = readString(entry, 'status') ?? '';
    fields['customer'] = readString(entry, 'customer') ?? '';
    fields['created'] = created === null ? '' : new Date(created * 1000).toISOString();
    fields['description'] = readString(entry, 'description') ?? '';
  } else if (objectType === STRIPE_CUSTOMER_OBJECT) {
    fields['email'] = readString(entry, 'email') ?? '';
    fields['name'] = readString(entry, 'name') ?? '';
    fields['created'] = created === null ? '' : new Date(created * 1000).toISOString();
  } else {
    fields['amount_total'] = readNumber(entry, 'amount_total') ?? 0;
    fields['currency'] = readString(entry, 'currency') ?? '';
    fields['status'] = readString(entry, 'status') ?? '';
    fields['customer'] = readString(entry, 'customer') ?? '';
    fields['payment_intent'] = readString(entry, 'payment_intent') ?? '';
    fields['created'] = created === null ? '' : new Date(created * 1000).toISOString();
  }
  return {
    objectType,
    externalId: id,
    externalParentId: null,
    fields,
    updatedAt: typeof fields['created'] === 'string' ? (fields['created'] as string) : null,
    version: null,
    deleted: false,
  };
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
