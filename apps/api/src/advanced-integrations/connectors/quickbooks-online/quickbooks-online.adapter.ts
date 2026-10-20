import type {
  ConnectionValidationResult,
  ConnectorContext,
  DeleteObjectInput,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchChangesInput,
  FetchChangesResult,
  FetchPageInput,
  FetchPageResult,
  UpsertObjectInput,
} from '../../connector-adapter.port.js';
import { CONNECTOR_CAPABILITY_SCHEMA_VERSION, type ConnectorCapabilities } from '../../provider-capabilities.js';
import { ProviderError } from '../../provider-error.js';
import {
  ACCOUNTING_CUSTOMER_FIELDS,
  ACCOUNTING_INVOICE_FIELDS,
  ACCOUNTING_PAYMENT_FIELDS,
  accountingDecimal,
  accountingDocumentState,
  accountingSourceMetadata,
} from '../accounting/accounting-framework.js';
import { type ConnectorOperationFlags,OAuth2ConnectorBase } from '../kit/base-adapter.js';
import {
  buildUrl,
  ConnectorHttp,
  decodeCursor,
  encodeCursor,
  isJsonObject,
  readString,
} from '../kit/connector-kit.js';
import type { OAuth2ProviderConfig } from '../kit/oauth2-base.js';

/**
 * Phase 19-INT.23 — the QuickBooks Online connector, the first accounting provider
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.8; `19-INT.23`).
 *
 * **Why QuickBooks Online and not Xero.** The provider matrix (§1) lists QuickBooks Online first
 * in tier 3. QBO publishes a documented query endpoint that returns a company's customers,
 * invoices and payments with a per-record `LastUpdatedTime`, which is exactly the watermark the
 * platform's checkpoint model needs. The selection is recorded in
 * `docs/compatibility/advanced-integrations/provider-matrix.md`.
 *
 * **The first release is read-only for documents.** The plan requires that a financial operation
 * is never triggered automatically, that CRM Sales keeps ownership of its own document lifecycle,
 * and that an issued or posted document is not an ordinary editable object. So this connector
 * reads customers, invoices and payments; it does **not** create an invoice, post one, or record a
 * payment at the provider. Doing that requires the Sales accounting contract, which is delivered in
 * 19-INT.25.
 *
 * **Sandbox by default.** The environment is a property of the connection, not of a second CRM.
 * A connection that does not name an environment talks to the **sandbox**, so a half-configured
 * installation can never post anything to a production ledger.
 *
 * No webhook is implemented: a QBO app registers one notification URL for the whole app, so a
 * per-connection endpoint cannot be expressed without a proxy. The connector therefore uses the
 * `LastUpdatedTime` watermark, and the limitation is recorded in the compatibility document.
 */

export const QUICKBOOKS_ONLINE_PROVIDER_KEY = 'quickbooks-online';

/** The QBO minor version, pinned deliberately. */
export const QUICKBOOKS_MINOR_VERSION = 75;

/** The maximum page size a QBO query honours. */
export const QUICKBOOKS_MAX_PAGE_SIZE = 1000;

/** The object types this connector offers. */
export const QUICKBOOKS_CUSTOMER_OBJECT = 'customer';
export const QUICKBOOKS_INVOICE_OBJECT = 'invoice';
export const QUICKBOOKS_PAYMENT_OBJECT = 'payment';

/** The environments a connection may address. */
export const QUICKBOOKS_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type QuickbooksEnvironment = (typeof QUICKBOOKS_ENVIRONMENTS)[number];

const CUSTOMER_FIELDS: readonly ExternalFieldSchema[] = ACCOUNTING_CUSTOMER_FIELDS;
const INVOICE_FIELDS: readonly ExternalFieldSchema[] = ACCOUNTING_INVOICE_FIELDS;
const PAYMENT_FIELDS: readonly ExternalFieldSchema[] = ACCOUNTING_PAYMENT_FIELDS;

/** The capability declaration of the QuickBooks Online connector. */
export function quickbooksCapabilities(): ConnectorCapabilities {
  const reference = {
    read: true,
    // A financial document is never created or changed at the provider by this release.
    create: false,
    update: false,
    delete: false,
    upsert: false,
    webhook: false,
    syncDirections: ['inbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: QUICKBOOKS_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    deletionVisibility: 'not_synchronized' as const,
    transactional: false,
  };
  const customer = {
    ...reference,
    objectType: QUICKBOOKS_CUSTOMER_OBJECT,
    label: 'Customer',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'personal' as const,
  };
  const invoice = {
    ...reference,
    objectType: QUICKBOOKS_INVOICE_OBJECT,
    label: 'Invoice',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'financial' as const,
  };
  const payment = {
    ...reference,
    objectType: QUICKBOOKS_PAYMENT_OBJECT,
    label: 'Payment',
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    dataSensitivity: 'financial' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [customer, invoice, payment],
    webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
  };
}

/** The OAuth 2.0 configuration of the QuickBooks Online connector. */
export const QUICKBOOKS_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: QUICKBOOKS_ONLINE_PROVIDER_KEY,
  authorizationEndpoint: 'https://appcenter.intuit.com/connect/oauth2',
  tokenEndpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  scopeSeparator: ' ',
  supportsPkce: false,
  tokenAuthMethod: 'client_secret_post',
  reportsGrantedScopes: true,
};

/** The cursor the connector writes. */
interface QuickbooksCursor {
  readonly startPosition: number;
  readonly watermark: string | null;
}

export interface QuickbooksOnlineAdapterOptions {
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The QuickBooks Online connector.
 */
export class QuickbooksOnlineAdapter extends OAuth2ConnectorBase {
  override readonly providerKey = QUICKBOOKS_ONLINE_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = `minorversion=${String(QUICKBOOKS_MINOR_VERSION)}`;
  override readonly capabilities: ConnectorCapabilities = quickbooksCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: false,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: QuickbooksOnlineAdapterOptions) {
    super({
      config: QUICKBOOKS_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: QUICKBOOKS_ONLINE_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /companyinfo/{realmId}` names the company and needs no object.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(this.baseUrl(context), `/companyinfo/${encodeURIComponent(this.realmId(context))}`),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      const info = isJsonObject(body['CompanyInfo']) ? body['CompanyInfo'] : {};
      return {
        ok: true,
        code: null,
        message: null,
        accountRef: readString(info, 'CompanyName') ?? context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      { objectType: QUICKBOOKS_CUSTOMER_OBJECT, label: 'Customer', fields: CUSTOMER_FIELDS, incremental: true, maxPageSize: QUICKBOOKS_MAX_PAGE_SIZE },
      { objectType: QUICKBOOKS_INVOICE_OBJECT, label: 'Invoice', fields: INVOICE_FIELDS, incremental: true, maxPageSize: QUICKBOOKS_MAX_PAGE_SIZE },
      { objectType: QUICKBOOKS_PAYMENT_OBJECT, label: 'Payment', fields: PAYMENT_FIELDS, incremental: true, maxPageSize: QUICKBOOKS_MAX_PAGE_SIZE },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === QUICKBOOKS_CUSTOMER_OBJECT) return CUSTOMER_FIELDS;
    if (objectType === QUICKBOOKS_INVOICE_OBJECT) return INVOICE_FIELDS;
    if (objectType === QUICKBOOKS_PAYMENT_OBJECT) return PAYMENT_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of the object set. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    return this.runQuery(input.context, input.objectType, {
      startPosition: 1,
      watermark: null,
    }, input.pageSize);
  }

  /**
   * Read the incremental feed.
   *
   * The watermark is the highest `LastUpdatedTime` the previous run saw. A record whose timestamp
   * equals the watermark is included again, because a provider that stamps records with the same
   * second would otherwise be able to hide a change.
   */
  async fetchChanges(input: FetchChangesInput): Promise<FetchChangesResult> {
    const cursor = decodeCursor<QuickbooksCursor>(input.deltaToken, QUICKBOOKS_ONLINE_PROVIDER_KEY);
    const result = await this.runQuery(
      input.context,
      input.objectType,
      { startPosition: 1, watermark: cursor?.watermark ?? null },
      input.pageSize,
    );
    return { objects: result.objects, nextDeltaToken: result.nextCursor, cursorExpired: false };
  }

  /** Accounting documents are never created at the provider in this release. */
  async upsertObject(_input: UpsertObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError(
      'CONFIGURATION_INVALID',
      'The accounting connector is read-only. A financial operation runs through the Sales domain service.',
      { category: 'configuration_invalid', retryable: false, detail: 'read_only' },
    );
  }

  /** Accounting documents are never deleted at the provider. */
  async deleteObject(_input: DeleteObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError('CONFIGURATION_INVALID', 'The accounting connector is read-only.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'read_only',
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Run one QBO query and shape the answer. */
  private async runQuery(
    context: ConnectorContext,
    objectType: string,
    cursor: QuickbooksCursor,
    pageSize: number,
  ): Promise<FetchPageResult> {
    const entity = this.entityFor(objectType);
    if (entity === null) throw this.unknownObject(objectType);
    const http = this.httpFactory(context.connectionId);
    const statement =
      cursor.watermark === null
        ? `select * from ${entity}`
        : `select * from ${entity} where MetaData.LastUpdatedTime >= '${cursor.watermark.replace(/'/g, "''")}'`;
    const payload = await http.json<unknown>({
      method: 'POST',
      url: buildUrl(this.baseUrl(context), '/query', {
        minorversion: QUICKBOOKS_MINOR_VERSION,
        startPosition: cursor.startPosition,
        maxResults: this.clampPageSize(pageSize),
      }),
      headers: { ...this.authHeaders(context), 'content-type': 'text/plain' },
      body: statement,
    });
    const body = isJsonObject(payload) ? payload : {};
    const response = isJsonObject(body['QueryResponse']) ? body['QueryResponse'] : {};
    const rows = Array.isArray(response[entity]) ? (response[entity] as unknown[]) : [];
    const objects = rows
      .filter(isJsonObject)
      .map((row) => toExternalObject(objectType, row, this.realmId(context)));
    const watermark = objects.reduce<string | null>((latest, object) => {
      const value = typeof object.updatedAt === 'string' ? object.updatedAt : null;
      if (value === null) return latest;
      return latest === null || value > latest ? value : latest;
    }, cursor.watermark);
    const startPosition = cursor.startPosition + objects.length;
    const hasMore = objects.length >= this.clampPageSize(pageSize);
    return {
      objects,
      nextCursor: hasMore ? encodeCursor({ startPosition, watermark }) : null,
      cursorExpired: false,
    };
  }

  private entityFor(objectType: string): string | null {
    if (objectType === QUICKBOOKS_CUSTOMER_OBJECT) return 'Customer';
    if (objectType === QUICKBOOKS_INVOICE_OBJECT) return 'Invoice';
    if (objectType === QUICKBOOKS_PAYMENT_OBJECT) return 'Payment';
    return null;
  }

  /** The realm (company) id of the connection. */
  private realmId(context: ConnectorContext): string {
    const realm = (context.tenantRef ?? '').trim();
    if (!/^\d{6,}$/.test(realm)) {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        'The connection does not name a QuickBooks company. Set the provider account to the company id.',
        { category: 'configuration_invalid', retryable: false, detail: 'no_realm' },
      );
    }
    return realm;
  }

  /** The environment the connection addresses. The sandbox is the default. */
  private environment(context: ConnectorContext): QuickbooksEnvironment {
    const raw = context.options['environment'];
    if (raw === undefined || raw === null) return 'sandbox';
    if (raw !== 'sandbox' && raw !== 'production') {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        'The connection option "environment" must be "sandbox" or "production".',
        { category: 'configuration_invalid', retryable: false, detail: 'bad_environment' },
      );
    }
    return raw;
  }

  /** The API base URL of the connection's company. */
  private baseUrl(context: ConnectorContext): string {
    const host =
      this.environment(context) === 'production'
        ? 'https://quickbooks.api.intuit.com'
        : 'https://sandbox-quickbooks.api.intuit.com';
    return `${host}/v3/company/${this.realmId(context)}`;
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
    return { authorization: `Bearer ${token}`, accept: 'application/json' };
  }

  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return QUICKBOOKS_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), QUICKBOOKS_MAX_PAGE_SIZE);
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
      message: 'QuickBooks Online could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The external shape of one accounting object. */
function toExternalObject(objectType: string, row: Record<string, unknown>, realmId: string): ExternalObject {
  const id = readString(row, 'Id') ?? '';
  const meta = isJsonObject(row['MetaData']) ? row['MetaData'] : {};
  const updatedAt = readString(meta, 'LastUpdatedTime');
  const source = accountingSourceMetadata(QUICKBOOKS_ONLINE_PROVIDER_KEY, realmId);
  if (objectType === QUICKBOOKS_CUSTOMER_OBJECT) {
    const primaryEmail = isJsonObject(row['PrimaryEmailAddr']) ? row['PrimaryEmailAddr'] : {};
    return {
      objectType,
      externalId: id,
      externalParentId: null,
      fields: {
        id,
        display_name: readString(row, 'DisplayName') ?? '',
        email: readString(primaryEmail, 'Address') ?? '',
        reference: readString(row, 'CompanyName') ?? '',
        currency: readString(row, 'CurrencyRef') ?? '',
        updated_at: updatedAt ?? '',
        source_metadata: source,
      },
      updatedAt,
      version: null,
      deleted: false,
    };
  }
  if (objectType === QUICKBOOKS_INVOICE_OBJECT) {
    const customerRef = isJsonObject(row['CustomerRef']) ? row['CustomerRef'] : {};
    const balance = accountingDecimal(row['Balance']);
    return {
      objectType,
      externalId: id,
      externalParentId: readString(customerRef, 'value'),
      fields: {
        id,
        doc_number: readString(row, 'DocNumber') ?? '',
        customer_id: readString(customerRef, 'value') ?? '',
        currency: readString(row, 'CurrencyRef') ?? '',
        total_amount: accountingDecimal(row['TotalAmt']) ?? '0.00',
        balance_amount: balance,
        tax_total: accountingDecimal(row['TotalTaxAmt']),
        // A QuickBooks invoice is posted the moment it exists; it is settled when nothing is
        // left to pay. A voided invoice is reported by the provider as a cancelled document.
        state: accountingDocumentState(documentStateOf(row, balance)),
        due_date: readString(row, 'DueDate') ?? '',
        updated_at: updatedAt ?? '',
        source_metadata: source,
      },
      updatedAt,
      version: null,
      deleted: false,
    };
  }
  const customerRef = isJsonObject(row['CustomerRef']) ? row['CustomerRef'] : {};
  return {
    objectType,
    externalId: id,
    externalParentId: readString(customerRef, 'value'),
    fields: {
      id,
      customer_id: readString(customerRef, 'value') ?? '',
      currency: readString(row, 'CurrencyRef') ?? '',
      total_amount: accountingDecimal(row['TotalAmt']) ?? '0.00',
      state: accountingDocumentState(readString(row, 'PaymentType')),
      payment_date: readString(row, 'TxnDate') ?? '',
      reference: readString(row, 'PaymentRefNum') ?? '',
      updated_at: updatedAt ?? '',
      source_metadata: source,
    },
    updatedAt,
    version: null,
    deleted: false,
  };
}

/**
 * The document state a QuickBooks invoice is in.
 *
 * A QuickBooks invoice is posted the moment it exists, and settled when nothing is left to pay.
 * A cancelled document is reported by the provider with a cancelled transaction status.
 */
function documentStateOf(row: Record<string, unknown>, balance: string | null): string {
  const status = readString(row, 'TxnStatus') ?? readString(row, 'Status') ?? '';
  if (/cancel|void|delete/i.test(status)) return 'void';
  if (balance !== null && Number(balance) === 0) return 'paid';
  return 'posted';
}
