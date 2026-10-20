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
import {
  decimalString,
  ECOMMERCE_CUSTOMER_FIELDS,
  ECOMMERCE_ORDER_FIELDS,
  ECOMMERCE_PRODUCT_FIELDS,
  ecommerceSourceMetadata,
} from '../ecommerce/ecommerce-framework.js';
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
import { verifyBase64HmacSha256 } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.22 — the Shopify connector, the first ecommerce provider
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.7; `19-INT.22`).
 *
 * **Why Shopify and not WooCommerce.** The provider matrix (§1) lists Shopify first in tier 3, and
 * Shopify publishes a documented Admin API with a stable versioned endpoint scheme, a signed
 * webhook scheme and a per-webhook event id. WooCommerce's REST API is a WordPress plugin whose
 * availability depends on the site's configuration, which makes a "framework plus one provider"
 * release less verifiable. The selection is recorded in
 * `docs/compatibility/advanced-integrations/provider-matrix.md`.
 *
 * **No sandbox was available for this delivery.** The connector is therefore verified by the
 * connector contract suite and by unit tests against recorded provider shapes — never against a
 * live store, and never with a store credential in the repository. The limitation is recorded in
 * the compatibility document rather than hidden.
 *
 * The rules the ecommerce framework imposes, and how they show up here:
 *
 *  - **inbound by default** — the objects are declared inbound-only;
 *  - **a store delete is not a CRM delete** — the webhook marks the object as deleted and the
 *    mapping's deletion policy decides what happens to the CRM record;
 *  - **money is a decimal string** — the totals are carried as the store's own decimal text;
 *  - **identifiers are kept** — the store id and the webhook event id travel with the object.
 */

export const SHOPIFY_PROVIDER_KEY = 'shopify';

/** The Admin API version, pinned deliberately. */
export const SHOPIFY_API_VERSION = '2024-10';

/** The maximum page size the Admin API honours. */
export const SHOPIFY_MAX_PAGE_SIZE = 250;

/** The object types this connector offers. */
export const SHOPIFY_ORDER_OBJECT = 'order';
export const SHOPIFY_CUSTOMER_OBJECT = 'customer';
export const SHOPIFY_PRODUCT_OBJECT = 'product';

const ORDER_FIELDS: readonly ExternalFieldSchema[] = ECOMMERCE_ORDER_FIELDS;
const CUSTOMER_FIELDS: readonly ExternalFieldSchema[] = ECOMMERCE_CUSTOMER_FIELDS;
const PRODUCT_FIELDS: readonly ExternalFieldSchema[] = ECOMMERCE_PRODUCT_FIELDS;

/** The capability declaration of the Shopify connector. */
export function shopifyCapabilities(): ConnectorCapabilities {
  const store = {
    read: true,
    create: false,
    update: false,
    delete: false,
    upsert: false,
    webhook: true,
    // Inbound by default: the plan forbids pushing CRM edits back to a store unless it is a
    // deliberate, reviewed decision.
    syncDirections: ['inbound'] as const,
    fullSync: true,
    incrementalSync: false,
    requiredScopes: [] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: SHOPIFY_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
  };
  const order = {
    ...store,
    objectType: SHOPIFY_ORDER_OBJECT,
    label: 'Order',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'financial' as const,
  };
  const customer = {
    ...store,
    objectType: SHOPIFY_CUSTOMER_OBJECT,
    label: 'Customer',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'personal' as const,
  };
  const product = {
    ...store,
    objectType: SHOPIFY_PRODUCT_OBJECT,
    label: 'Product',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'business' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'api_key',
    objects: [order, customer, product],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  };
}

/** The cursor the connector writes. */
interface ShopifyCursor {
  readonly nextPageUrl: string | null;
}

export interface ShopifyAdapterOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Shopify connector.
 */
export class ShopifyAdapter extends AbstractConnectorAdapter {
  override readonly providerKey = SHOPIFY_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = SHOPIFY_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = shopifyCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: ShopifyAdapterOptions = {}) {
    super();
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: SHOPIFY_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /shop.json` names the shop and costs nothing.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(context), '/shop.json'),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      const shop = isJsonObject(body['shop']) ? body['shop'] : {};
      return {
        ok: true,
        code: null,
        message: null,
        accountRef: readString(shop, 'domain') ?? context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      { objectType: SHOPIFY_ORDER_OBJECT, label: 'Order', fields: ORDER_FIELDS, incremental: false, maxPageSize: SHOPIFY_MAX_PAGE_SIZE },
      { objectType: SHOPIFY_CUSTOMER_OBJECT, label: 'Customer', fields: CUSTOMER_FIELDS, incremental: false, maxPageSize: SHOPIFY_MAX_PAGE_SIZE },
      { objectType: SHOPIFY_PRODUCT_OBJECT, label: 'Product', fields: PRODUCT_FIELDS, incremental: false, maxPageSize: SHOPIFY_MAX_PAGE_SIZE },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === SHOPIFY_ORDER_OBJECT) return ORDER_FIELDS;
    if (objectType === SHOPIFY_CUSTOMER_OBJECT) return CUSTOMER_FIELDS;
    if (objectType === SHOPIFY_PRODUCT_OBJECT) return PRODUCT_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /**
   * Enumerate one page.
   *
   * Shopify paginates with a `Link` header, so the connector reads the header rather than the
   * body. The next page URL is **re-validated** against the store's own host before it is
   * requested, so a tampered cursor cannot redirect the connector somewhere else.
   */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    const path = this.pathFor(input.objectType);
    if (path === null) throw this.unknownObject(input.objectType);
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<ShopifyCursor>(input.cursor, SHOPIFY_PROVIDER_KEY);
    const url =
      cursor?.nextPageUrl === null || cursor?.nextPageUrl === undefined
        ? buildUrl(this.baseUrl(input.context), path, { limit: this.clampPageSize(input.pageSize) })
        : this.assertStoreUrl(input.context, cursor.nextPageUrl);
    const answer = await http.jsonWithHeaders<unknown>({
      method: 'GET',
      url,
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(answer.body) ? answer.body : {};
    const entries = this.readEntries(body, input.objectType);
    const nextPageUrl = readNextPageUrl(answer.headers['link']);
    return {
      objects: entries,
      nextCursor: nextPageUrl === null ? null : encodeCursor({ nextPageUrl }),
      cursorExpired: false,
    };
  }

  /** Store records are not written back by this connector. */
  async upsertObject(_input: UpsertObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError(
      'CONFIGURATION_INVALID',
      'The Shopify connector is inbound only. A store is not a mirror of the CRM.',
      { category: 'configuration_invalid', retryable: false, detail: 'inbound_only' },
    );
  }

  /** Store records are not deleted through this connector. */
  async deleteObject(_input: DeleteObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError('CONFIGURATION_INVALID', 'The Shopify connector is inbound only.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'inbound_only',
    });
  }

  /**
   * Verify a Shopify webhook.
   *
   * The `X-Shopify-Hmac-Sha256` header carries the base64 HMAC of the **raw** body. A body that
   * was re-serialized has a different digest, which is why the raw bytes are mandatory.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const verification = verifyBase64HmacSha256({
      rawBody: input.rawBody,
      secret: input.context.credential.webhookSecret,
      header: readHeader(input.headers, 'x-shopify-hmac-sha256'),
    });
    return { valid: verification.valid, reason: verification.reason, challenge: null };
  }

  /**
   * Turn a Shopify webhook into normalized events.
   *
   * Shopify sends a unique `X-Shopify-Event-Id` per delivery, so the deduplication needs no
   * invented key.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    if (!isJsonObject(body)) return [];
    const topic = readString(body, 'topic') ?? '';
    const objectType = this.objectTypeFor(topic);
    if (objectType === null) return [];
    const eventId = readHeader(input.headers, 'x-shopify-event-id');
    const id = readString(body, 'id') ?? '';
    const deliveryId = eventId === undefined ? '' : eventId;
    if (deliveryId === '') return [];
    return [
      {
        deliveryId,
        objectType,
        externalId: id === '' ? null : id,
        eventType: topic.toLowerCase(),
        occurredAt: null,
        fields: { ...body },
        deleted: topic.endsWith('/delete'),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private pathFor(objectType: string): string | null {
    if (objectType === SHOPIFY_ORDER_OBJECT) return '/orders.json';
    if (objectType === SHOPIFY_CUSTOMER_OBJECT) return '/customers.json';
    if (objectType === SHOPIFY_PRODUCT_OBJECT) return '/products.json';
    return null;
  }

  private objectTypeFor(topic: string): string | null {
    if (topic.startsWith('orders/')) return SHOPIFY_ORDER_OBJECT;
    if (topic.startsWith('customers/')) return SHOPIFY_CUSTOMER_OBJECT;
    if (topic.startsWith('products/')) return SHOPIFY_PRODUCT_OBJECT;
    return null;
  }

  /** The entries of a Shopify answer, as external objects. */
  private readEntries(body: Record<string, unknown>, objectType: string): readonly ExternalObject[] {
    const key =
      objectType === SHOPIFY_ORDER_OBJECT
        ? 'orders'
        : objectType === SHOPIFY_CUSTOMER_OBJECT
          ? 'customers'
          : 'products';
    const entries = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    return entries
      .filter(isJsonObject)
      .map((entry) =>
        objectType === SHOPIFY_ORDER_OBJECT
          ? toOrderObject(entry, this.storeIdOf(entry))
          : objectType === SHOPIFY_CUSTOMER_OBJECT
            ? toCustomerObject(entry, this.storeIdOf(entry))
            : toProductObject(entry, this.storeIdOf(entry)),
      );
  }

  /** The store id an entry carries, when the provider names one. */
  private storeIdOf(entry: Record<string, unknown>): string {
    return readString(entry, 'store_id') ?? '';
  }

  /**
   * The API base URL of the connection's store.
   *
   * The shop domain is the connection's `tenantRef` — it is not secret, and it is the only thing
   * that identifies which store the token belongs to.
   */
  private baseUrl(context: ConnectorContext): string {
    const shop = (context.tenantRef ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        'The connection does not name a Shopify store. Set the provider account to a value such as "example.myshopify.com".',
        { category: 'configuration_invalid', retryable: false, detail: 'no_shop' },
      );
    }
    return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}`;
  }

  /**
   * Refuse a page URL that does not point at the connection's own store.
   *
   * The `Link` header comes from the provider, but the cursor is data the platform stores, so the
   * URL is checked again before it is requested.
   */
  private assertStoreUrl(context: ConnectorContext, raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderError('INVALID_REQUEST', 'The store answered with an unreadable page link.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'malformed_link',
      });
    }
    const expected = new URL(this.baseUrl(context));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== expected.hostname.toLowerCase()) {
      throw new ProviderError('INVALID_REQUEST', 'The store answered with a page link that points somewhere else.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'foreign_link',
      });
    }
    return url.toString();
  }

  private authHeaders(context: ConnectorContext): Record<string, string> {
    const token = context.credential.apiKey;
    if (token === null || token === '') {
      throw new ProviderError('CONFIGURATION_INVALID', 'The connection holds no Shopify access token.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'no_api_key',
      });
    }
    return { 'x-shopify-access-token': token };
  }

  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return SHOPIFY_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), SHOPIFY_MAX_PAGE_SIZE);
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
      message: 'The store could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The `rel="next"` URL of a `Link` header, or `null`. */
export function readNextPageUrl(link: string | undefined): string | null {
  if (link === undefined || link.trim() === '') return null;
  for (const part of link.split(',')) {
    const segments = part.split(';');
    const url = (segments[0] ?? '').trim();
    const isNext = segments.slice(1).some((segment) => segment.trim().toLowerCase() === 'rel="next"');
    if (isNext && url !== '') return url;
  }
  return null;
}

/** The external shape of one order. */
function toOrderObject(entry: Record<string, unknown>, storeId: string): ExternalObject {
  const id = readString(entry, 'id') ?? '';
  const customer = isJsonObject(entry['customer']) ? entry['customer'] : {};
  const fields: Record<string, unknown> = {
    id,
    name: readString(entry, 'name') ?? '',
    store_id: storeId,
    created_at: readString(entry, 'created_at') ?? '',
    updated_at: readString(entry, 'updated_at') ?? '',
    currency: readString(entry, 'currency') ?? '',
    total_price: decimalString(entry['total_price']) ?? '0.00',
    subtotal_price: decimalString(entry['subtotal_price']),
    tax_total: decimalString(entry['total_tax']),
    shipping_total: decimalString(entry['total_shipping']),
    discount_total: decimalString(entry['total_discounts']),
    financial_status: readString(entry, 'financial_status') ?? '',
    fulfillment_status: readString(entry, 'fulfillment_status') ?? '',
    customer_id: readString(customer, 'id') ?? readString(entry, 'customer_id') ?? '',
    email: readString(entry, 'email') ?? readString(customer, 'email') ?? '',
    line_items: Array.isArray(entry['line_items']) ? entry['line_items'] : [],
    source_metadata: ecommerceSourceMetadata(SHOPIFY_PROVIDER_KEY, storeId),
  };
  return {
    objectType: SHOPIFY_ORDER_OBJECT,
    externalId: id,
    externalParentId: storeId === '' ? null : storeId,
    fields,
    updatedAt: readString(entry, 'updated_at'),
    version: null,
    deleted: false,
  };
}

/** The external shape of one customer. */
function toCustomerObject(entry: Record<string, unknown>, storeId: string): ExternalObject {
  const id = readString(entry, 'id') ?? '';
  return {
    objectType: SHOPIFY_CUSTOMER_OBJECT,
    externalId: id,
    externalParentId: storeId === '' ? null : storeId,
    fields: {
      id,
      store_id: storeId,
      email: readString(entry, 'email') ?? '',
      first_name: readString(entry, 'first_name') ?? '',
      last_name: readString(entry, 'last_name') ?? '',
      phone: readString(entry, 'phone') ?? '',
      created_at: readString(entry, 'created_at') ?? '',
      updated_at: readString(entry, 'updated_at') ?? '',
      source_metadata: ecommerceSourceMetadata(SHOPIFY_PROVIDER_KEY, storeId),
    },
    updatedAt: readString(entry, 'updated_at'),
    version: null,
    deleted: false,
  };
}

/** The external shape of one product. */
function toProductObject(entry: Record<string, unknown>, storeId: string): ExternalObject {
  const id = readString(entry, 'id') ?? '';
  const variants = Array.isArray(entry['variants']) ? (entry['variants'] as unknown[]) : [];
  return {
    objectType: SHOPIFY_PRODUCT_OBJECT,
    externalId: id,
    externalParentId: storeId === '' ? null : storeId,
    fields: {
      id,
      store_id: storeId,
      title: readString(entry, 'title') ?? '',
      handle: readString(entry, 'handle') ?? '',
      status: readString(entry, 'status') ?? '',
      vendor: readString(entry, 'vendor') ?? '',
      variants: variants.map((variant) =>
        isJsonObject(variant)
          ? {
              id: readString(variant, 'id') ?? '',
              title: readString(variant, 'title') ?? '',
              sku: readString(variant, 'sku') ?? '',
              price: decimalString(variant['price']) ?? '0.00',
              inventory: readNumber(variant, 'inventory_quantity') ?? 0,
            }
          : {},
      ),
      created_at: readString(entry, 'created_at') ?? '',
      updated_at: readString(entry, 'updated_at') ?? '',
    },
    updatedAt: readString(entry, 'updated_at'),
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
