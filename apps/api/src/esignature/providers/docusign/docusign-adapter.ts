import { ProviderError } from '../../../advanced-integrations/provider-error.js';
import { PROVIDER_KEY_DOCUSIGN } from '../../esignature-domain.js';
import { NotSupportedByProviderError } from '../signature-provider.errors.js';
import {
  BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  type PreparedEnvelope,
  type PrepareEnvelopeInput,
  type ProviderAccountContext,
  type ProviderArtifact,
  type ProviderConnectionStatus,
  type ProviderEnvelopeStatus,
  type ProviderRecipientStatus,
  type ProviderTemplateDetail,
  type ProviderTemplateField,
  type ProviderTemplateRole,
  type ProviderTemplateSummary,
  type ProviderWebhookNotification,
  type SendEnvelopeInput,
  type SentEnvelope,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderContext,
  type SignatureProviderOperation,
  type VerifyWebhookInput,
} from '../signature-provider.port.js';
import { parseDocuSignUserinfo, selectDocuSignAccount } from './docusign-oauth.js';
import { type DocuSignTransport,parseJson } from './docusign-transport.js';

/**
 * Phase 19-ES.4 — the DocuSign adapter that answers in production
 * (`PLAN_Phase_19_ESignature.md` §5.1, §5.2, §6.1, §9.3, §18 `19-ES.4`).
 *
 * This is the **first real adapter**, and it is deliberately partial. ES.4's task list is the
 * connection: prove the credential, resolve the account, report health. Envelope creation, sending,
 * recipient status, artifact download and Connect verification are the operations ES.9, ES.11 and ES.15
 * deliver, and until they exist this adapter declares them `false`.
 *
 * That distinction is load-bearing in two places:
 *
 * 1. `capabilities` is the honest answer the gate reads (`ESignatureConnectionGate.supportedOnProvider`
 *    asks the *bound* adapter), so a production installation refuses a send with
 *    `NOT_SUPPORTED_BY_PROVIDER` rather than admitting an operation whose code does not exist yet
 *    (plan §5.2: no silent no-op).
 * 2. The unimplemented methods are present because the port requires them, and every one throws
 *    `NotSupportedByProviderError`. It is a fence, not a door: the registry refuses before dispatch, so
 *    reaching that body means a caller bypassed the gate — and a caller that did gets a refusal, not a
 *    request that half-happened.
 *
 * Nothing in this file knows what a CRM request, a recipient row or a permission is. It receives a
 * `SignatureProviderContext` — account id, base URI, short-lived bearer — and returns normalized
 * results. Vendor payload shapes stop here (plan §1.2).
 */

/** The eSignature REST version the adapter speaks (audit §4: v2.1 only). */
export const DOCUSIGN_REST_VERSION = 'v2.1';

/** What this adapter can do today: the connection, and only the connection. */
export const DOCUSIGN_ES4_CAPABILITIES: SignatureProviderCapabilities = Object.freeze({
  ...BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  // ES.7 — the template catalog, read-only (plan §6.7 forbids updating a provider template).
  listTemplates: true,
  templateDetails: true,
  // Delivered by their own sub-phases. Declaring them false is what makes the gate's refusal precise.
  prepareEnvelope: false,
  sendEnvelope: false,
  envelopeStatus: false,
  listRecipients: false,
  downloadCompletedDocuments: false,
  downloadCompletionEvidence: false,
  verifyWebhook: false,
});

/** A stable code for the health view. Never a provider body, never a token. */
export const DOCUSIGN_DETAIL_CODES = [
  'ok',
  'token_expired',
  'access_denied',
  'account_not_found',
  'rate_limited',
  'provider_outage',
  'unreachable',
  'destination_refused',
  'response_invalid',
] as const;
export type DocuSignDetailCode = (typeof DOCUSIGN_DETAIL_CODES)[number];

export class DocuSignAdapter implements SignatureProviderAdapter {
  readonly providerKey = PROVIDER_KEY_DOCUSIGN;
  readonly adapterVersion = '1.0.0';
  readonly providerApiVersion = DOCUSIGN_REST_VERSION;
  /** A live integration. It can only act on a credential the platform resolved from the vault. */
  readonly mode = 'live' as const;
  readonly capabilities = DOCUSIGN_ES4_CAPABILITIES;

  constructor(private readonly transport: DocuSignTransport) {}

  /**
   * Test Connection (plan §13.4 "verify the connection, selected account, environment").
   *
   * The cheapest authenticated read that proves all three things at once: the bearer token is accepted,
   * the account id resolves, and the account-specific base URI actually answers. A one-item envelope
   * listing is used rather than `GET /accounts/{id}` because the account record requires administrator
   * rights, and the `signature` scope this module requests does not grant them.
   *
   * It performs **no write**. A failed test is a result, not an exception, so the admin screen can show
   * which link in the chain broke.
   */
  async connectionStatus(context: SignatureProviderContext): Promise<ProviderConnectionStatus> {
    const url = `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/envelopes?count=1`;
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.transport.request({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${context.accessToken}` },
        timeoutMs: context.timeoutMs,
      });
      if (response.status >= 400) {
        return { reachable: false, checkedAt: checkedAt, detailCode: detailCodeForStatus(response.status) };
      }
      // A 2xx whose body is not a JSON object is not a healthy answer: an HTML error page served by a
      // proxy would otherwise look like success to a caller that only read the status.
      const body = parseJson(response.body);
      const shaped = Object.keys(body).length > 0;
      return { reachable: shaped, checkedAt: checkedAt, detailCode: shaped ? 'ok' : 'response_invalid' };
    } catch (error) {
      return { reachable: false, checkedAt: checkedAt, detailCode: detailCodeForError(error) };
    }
  }

  /**
   * Re-read the account context through the REST host.
   *
   * `GET /restapi/v2.1/userinfo` returns the accounts the token reaches, each with its own
   * `base_uri`. That is what lets an operator see that a connection's stored account still exists, and
   * it is the same call that resolved the account at authorization time — so a drift between the two is
   * a `reauthorization_required` signal, not a silent success (plan §9.2).
   */
  async accountContext(context: SignatureProviderContext): Promise<ProviderAccountContext> {
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/userinfo`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const info = parseDocuSignUserinfo(parseJson(response.body));
    // The connection already named an account; re-reading must not silently move it to another one.
    const account = selectDocuSignAccount(info, context.accountId);
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      baseUri: account.baseUri,
      userId: info.subjectUserId,
      // DocuSign's userinfo does not echo scopes; the granted set the connection recorded stands.
      grantedScopes: context.grantedScopes,
    };
  }

  /**
   * The account's template catalog.
   *
   * `count=100` is the page size the plan's admin screen can use; DocuSign caps a single page and
   * reports `totalSetSize`, which this method returns nothing about on purpose — the screen refreshes
   * the first page and ES.7 keeps the catalog read-only, so pagination is a later concern, not a
   * silent truncation of a mapping (this method never decides *which* template is valid; the detail
   * call does).
   */
  async listTemplates(context: SignatureProviderContext): Promise<readonly ProviderTemplateSummary[]> {
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/templates?count=100&order_by=name&order=asc`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) throw providerErrorForStatus(response.status);
    const body = parseJson(response.body);
    const entries = Array.isArray(body['templates']) ? body['templates'] : [];
    const templates: ProviderTemplateSummary[] = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const template = entry as Record<string, unknown>;
      const templateId = stringOf(template['templateId']);
      if (templateId === null) continue;
      templates.push({
        templateId,
        name: stringOf(template['name']) ?? templateId,
        description: stringOf(template['description']),
        shared: template['shared'] === 'true' || template['shared'] === true,
        status: stringOf(template['status']),
      });
    }
    return templates;
  }

  /**
   * One template's roles and tabs.
   *
   * A mapping is validated against this answer, so it is read as data and never as instructions: roles
   * come from `recipients.signers` / `recipients.carbonCopies`, and tabs from each document's
   * `tabs.<kind>Tabs` collection, with the role resolved through the tab's `recipientId`. A tab whose
   * recipient is unknown keeps `roleName: null` rather than being guessed into a role.
   */
  async templateDetails(context: SignatureProviderContext, templateId: string): Promise<ProviderTemplateDetail> {
    const id = templateId.trim();
    if (id === '') {
      throw new ProviderError('INVALID_REQUEST', 'A template id is required.', { category: 'permanent_validation', retryable: false });
    }
    const response = await this.transport.request({
      method: 'GET',
      url: `${restBase(context.baseUri)}/accounts/${encodeURIComponent(context.accountId)}/templates/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${context.accessToken}` },
      timeoutMs: context.timeoutMs,
    });
    if (response.status >= 400) {
      if (response.status === 404) {
        throw new ProviderError('NOT_FOUND', 'The signature provider has no such template in this account.', {
          category: 'not_found',
          retryable: false,
          detail: 'template_not_found',
          status: 404,
        });
      }
      throw providerErrorForStatus(response.status);
    }
    const body = parseJson(response.body);
    const recipients = asObject(body['recipients']);
    const roles: ProviderTemplateRole[] = [];
    const roleByRecipientId = new Map<string, string>();
    for (const [key, recipientType] of [
      ['signers', 'signer'],
      ['carbonCopies', 'carbon_copy'],
    ] as const) {
      const list = Array.isArray(recipients[key]) ? (recipients[key] as unknown[]) : [];
      for (const entry of list) {
        const recipient = asObject(entry);
        const roleName = stringOf(recipient['roleName']);
        if (roleName === null) continue;
        const routingOrder = Number(recipient['routingOrder']);
        roles.push({
          roleName,
          recipientType,
          routingOrder: Number.isFinite(routingOrder) && routingOrder > 0 ? routingOrder : null,
          // A template role is a slot the sender must fill; DocuSign has no "optional role" flag.
          required: true,
        });
        const recipientId = stringOf(recipient['recipientId']);
        if (recipientId !== null) roleByRecipientId.set(recipientId, roleName);
      }
    }

    const fields: ProviderTemplateField[] = [];
    const documents = Array.isArray(body['documents']) ? (body['documents'] as unknown[]) : [];
    for (const entry of documents) {
      const document = asObject(entry);
      const documentId = stringOf(document['documentId']);
      const tabs = asObject(document['tabs']);
      for (const kind of DOCUSIGN_TAB_KINDS) {
        const list = Array.isArray(tabs[kind]) ? (tabs[kind] as unknown[]) : [];
        for (const raw of list) {
          const tab = asObject(raw);
          const tabLabel = stringOf(tab['tabLabel']) ?? stringOf(tab['name']);
          if (tabLabel === null) continue;
          const recipientId = stringOf(tab['recipientId']);
          fields.push({
            tabLabel,
            roleName: recipientId === null ? null : roleByRecipientId.get(recipientId) ?? null,
            documentId,
            fieldType: kind.replace(/Tabs$/, ''),
            required: tab['required'] === 'true' || tab['required'] === true,
          });
        }
      }
    }

    return {
      templateId: stringOf(body['templateId']) ?? id,
      name: stringOf(body['name']) ?? id,
      description: stringOf(body['description']),
      shared: body['shared'] === 'true' || body['shared'] === true,
      status: stringOf(body['status']),
      roles,
      fields,
    };
  }

  async prepareEnvelope(_context: SignatureProviderContext, _input: PrepareEnvelopeInput): Promise<PreparedEnvelope> {
    throw this.refuse('prepareEnvelope');
  }

  async sendEnvelope(_context: SignatureProviderContext, _input: SendEnvelopeInput): Promise<SentEnvelope> {
    throw this.refuse('sendEnvelope');
  }

  async envelopeStatus(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<ProviderEnvelopeStatus> {
    throw this.refuse('envelopeStatus');
  }

  async listRecipients(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<readonly ProviderRecipientStatus[]> {
    throw this.refuse('listRecipients');
  }

  async downloadCompletedDocuments(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    throw this.refuse('downloadCompletedDocuments');
  }

  async downloadCompletionEvidence(_context: SignatureProviderContext, _providerEnvelopeId: string): Promise<readonly ProviderArtifact[]> {
    throw this.refuse('downloadCompletionEvidence');
  }

  async verifyAndParseWebhook(_input: VerifyWebhookInput): Promise<ProviderWebhookNotification> {
    throw this.refuse('verifyWebhook');
  }

  private refuse(operation: SignatureProviderOperation): NotSupportedByProviderError {
    // Reaching this line means the caller did not ask the registry first. The refusal is the same one
    // the registry would have produced, so the observable contract does not depend on the path taken.
    return new NotSupportedByProviderError(operation, this.providerKey);
  }
}

/**
 * The DocuSign REST root for a connection.
 *
 * `base_uri` comes from `userinfo` and already names the data center, so nothing here infers a host
 * (audit §4: "never hard-code a data center host"). A trailing slash is normalized away rather than
 * producing `//restapi`.
 */
export function restBase(baseUri: string): string {
  const trimmed = baseUri.trim().replace(/\/+$/, '');
  return `${trimmed}/restapi/${DOCUSIGN_REST_VERSION}`;
}

/** The safe one-word reason a health check failed, for the connection view and the audit detail. */
export function detailCodeForStatus(status: number): DocuSignDetailCode {
  if (status === 401) return 'token_expired';
  if (status === 403) return 'access_denied';
  if (status === 404) return 'account_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_outage';
  return 'response_invalid';
}

/** The DocuSign tab collections a template can carry, as they appear in `documents[].tabs`. */
const DOCUSIGN_TAB_KINDS = [
  'textTabs',
  'fullNameTabs',
  'emailTabs',
  'dateTabs',
  'dateSignedTabs',
  'numberTabs',
  'ssnTabs',
  'zipTabs',
  'companyTabs',
  'titleTabs',
  'checkboxTabs',
  'radioGroupTabs',
  'listTabs',
  'noteTabs',
  'signHereTabs',
  'initialHereTabs',
] as const;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function providerErrorForStatus(status: number): ProviderError {
  const code = status === 401 || status === 403 ? 'TOKEN_EXPIRED' : status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'UNKNOWN';
  const category = status === 401 || status === 403 ? 'authorization' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_outage' : 'permanent_validation';
  return new ProviderError(code, `DocuSign answered the account request with HTTP ${String(status)}.`, {
    category,
    retryable: status === 429 || status >= 500,
    detail: detailCodeForStatus(status),
    status,
  });
}

function detailCodeForError(error: unknown): DocuSignDetailCode {
  if (error instanceof ProviderError) {
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return 'unreachable';
    if (error.category === 'authorization') return 'token_expired';
    if (error.category === 'rate_limited') return 'rate_limited';
    if (error.category === 'provider_outage') return 'provider_outage';
    return 'unreachable';
  }
  // The SSRF gate refused the destination before any socket opened. That is a configuration fact about
  // the stored base URI, and it is reported as itself.
  if (error instanceof Error && error.name === 'DocuSignDestinationError') return 'destination_refused';
  return 'unreachable';
}
