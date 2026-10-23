import { describe, expect, it } from 'vitest';

import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import {
  detailCodeForStatus,
  DOCUSIGN_ES4_CAPABILITIES,
  DocuSignAdapter,
  restBase,
} from '../src/esignature/providers/docusign/docusign-adapter.js';
import {
  DOCUSIGN_AUTH_HOSTS,
  DOCUSIGN_REQUIRED_SCOPES,
  docusignAuthorizeUrl,
  DocuSignOAuthClient,
  hashOAuthState,
  parseDocuSignUserinfo,
  pkceChallengeFor,
  resolveScopes,
  selectDocuSignAccount,
  statusError,
} from '../src/esignature/providers/docusign/docusign-oauth.js';
import {
  createDocuSignTransport,
  DocuSignDestinationError,
  type DocuSignHttpRequest,
  type DocuSignHttpResponse,
  type DocuSignTransport,
  formBody,
} from '../src/esignature/providers/docusign/docusign-transport.js';
import type { SignatureProviderContext } from '../src/esignature/providers/signature-provider.port.js';
import { connectSignature } from '../src/esignature/providers/signature-provider-signature.js';

/**
 * Phase 19-ES.4 — the DocuSign wire mapping, proved without a network
 * (`PLAN_Phase_19_ESignature.md` §9.2, §9.3, §17.3; `19-ES.4` acceptance
 * "no test needs production provider credentials").
 *
 * Every case here drives a **stub transport** — an in-process object that answers like DocuSign —
 * because the plan forbids an automated test from reaching the provider (§17.3) and because the
 * behaviours under test are the ones a live call would make hard to observe reliably: which host each
 * environment uses, what an `invalid_grant` means, that a token never appears in a thrown message, and
 * that a stored base URI pointing at a private address is refused before a socket opens.
 */

const TOKENS = {
  access: 'agent-test-access-token-never-logged',
  refresh: 'agent-test-refresh-token-never-logged',
  secret: 'agent-test-client-secret-never-logged',
  code: 'agent-test-authorization-code',
};

interface Stubbed extends DocuSignTransport {
  readonly calls: DocuSignHttpRequest[];
  bodies: string[];
  statuses: number[];
  binaryBodies: Uint8Array[];
}

function stubTransport(): Stubbed {
  const calls: DocuSignHttpRequest[] = [];
  return {
    calls,
    bodies: [],
    statuses: [],
    binaryBodies: [],
    // The platform transport answers with the status and the body rather than throwing on 4xx, because
    // DocuSign puts the OAuth error *name* in the body and the caller has to read it (plan §9.2).
    async request(input: DocuSignHttpRequest): Promise<DocuSignHttpResponse> {
      calls.push(input);
      const index = calls.length - 1;
      if (input.binary === true) {
        return { status: this.statuses[index] ?? 200, headers: {}, body: '', bytes: this.binaryBodies[index] ?? new Uint8Array() };
      }
      return { status: this.statuses[index] ?? 200, headers: {}, body: this.bodies[index] ?? JSON.stringify({ ok: true }) };
    },
  };
}

function context(overrides: Partial<SignatureProviderContext> = {}): SignatureProviderContext {
  return {
    connectionId: 'conn-1',
    providerKey: 'docusign',
    environment: 'demo',
    accountId: 'acct-9',
    baseUri: 'https://demo.docusign.net',
    grantedScopes: ['signature', 'impersonation'],
    accessToken: TOKENS.access,
    correlationId: 'agent-test-correlation',
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('DocuSign OAuth endpoints (19-ES.4)', () => {
  it('uses the environment host for the authorization request, with PKCE and the minimum scopes', () => {
    const url = docusignAuthorizeUrl({
      environment: 'demo',
      clientId: 'integration-key-1',
      redirectUri: 'https://crm.example.invalid/api/v1/ESignature/oauth/callback',
      state: 'opaque-state-value',
      scopes: resolveScopes([]),
      codeChallenge: 'challenge-abc',
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe(DOCUSIGN_AUTH_HOSTS.demo);
    expect(parsed.pathname).toBe('/oauth/auth');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('integration-key-1');
    expect(parsed.searchParams.get('state')).toBe('opaque-state-value');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('signature impersonation');
    expect(parsed.protocol).toBe('https:');
  });

  it('keeps demo and production on different hosts, and never infers one from the other', () => {
    const production = new URL(
      docusignAuthorizeUrl({
        environment: 'production',
        clientId: 'key-2',
        redirectUri: 'https://crm.example.invalid/api/v1/ESignature/oauth/callback',
        state: 's',
        scopes: resolveScopes([]),
        codeChallenge: null,
      }),
    );
    expect(production.host).toBe(DOCUSIGN_AUTH_HOSTS.production);
    // No challenge, no challenge method: the pair is either both or neither.
    expect(production.searchParams.get('code_challenge')).toBeNull();
    expect(production.searchParams.get('code_challenge_method')).toBeNull();
  });

  it('requests only the minimum scopes, and refuses an administrative or unknown one', () => {
    expect(resolveScopes([])).toEqual([...DOCUSIGN_REQUIRED_SCOPES]);
    expect(resolveScopes(['extended'])).toEqual(['signature', 'impersonation', 'extended']);
    expect(() => resolveScopes(['agent'])).toThrow(/administrative/);
    expect(() => resolveScopes(['admin'])).toThrow(/administrative/);
    expect(() => resolveScopes(['signature.impersonation.all'])).toThrow(/Unknown DocuSign scope/);
    // Narrowing below the pair is refused rather than silently widened: the connection would not work.
    expect(() => resolveScopes(['signature'])).toThrow(/requires both/);
  });

  it('binds a state and a verifier to one hash, so a database read yields nothing usable', () => {
    const verifier = 'agent-test-verifier';
    expect(pkceChallengeFor(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallengeFor(verifier)).toBe(pkceChallengeFor(verifier));
    const hash = hashOAuthState('agent-test-state');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('agent-test-state');
  });

  it('sends the client credential in the Basic header, not in the form body', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ access_token: TOKENS.access, refresh_token: TOKENS.refresh, expires_in: 3600 })];
    const client = new DocuSignOAuthClient(transport);
    const tokens = await client.exchangeCode({
      environment: 'demo',
      clientId: 'key-1',
      clientSecret: TOKENS.secret,
      code: TOKENS.code,
      redirectUri: 'https://crm.example.invalid/api/v1/ESignature/oauth/callback',
      codeVerifier: 'verifier-1',
    });
    const call = transport.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`https://${DOCUSIGN_AUTH_HOSTS.demo}/oauth/token`);
    const body = formBody({ a: 'b' });
    expect(body).toContain('a=b');
    expect(String(call?.body)).toContain(`code=${TOKENS.code}`);
    expect(String(call?.body)).toContain('code_verifier=verifier-1');
    expect(String(call?.body)).not.toContain(TOKENS.secret);
    expect(String(call?.headers?.['authorization'])).toBe(`Basic ${Buffer.from('key-1:agent-test-client-secret-never-logged').toString('base64')}`);
    expect(tokens.accessToken).toBe(TOKENS.access);
    expect(tokens.refreshToken).toBe(TOKENS.refresh);
    expect(tokens.expiresAt).not.toBeNull();
    expect(tokens.grantedScopes).toEqual([...DOCUSIGN_REQUIRED_SCOPES]);
  });

  it('trusts an echoed scope over the request, so a narrowed grant is visible', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ access_token: 'a', scope: 'signature' })];
    const client = new DocuSignOAuthClient(transport);
    const tokens = await client.exchangeCode({ environment: 'demo', clientId: 'k', clientSecret: 's', code: 'c', redirectUri: 'r' });
    expect(tokens.grantedScopes).toEqual(['signature']);
  });

  it('reports a refused grant by its OAuth error name, never by the provider body', async () => {
    const transport = stubTransport();
    transport.statuses = [400];
    transport.bodies = [JSON.stringify({ error: 'invalid_grant', error_description: `token ${TOKENS.refresh} is expired` })];
    const client = new DocuSignOAuthClient(transport);
    const failure = await client
      .refresh({ environment: 'demo', clientId: 'k', clientSecret: 's', refreshToken: TOKENS.refresh })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    const providerError = failure as ProviderError;
    expect(providerError.category).toBe('authorization');
    expect(providerError.code).toBe('TOKEN_EXPIRED');
    expect(providerError.retryable).toBe(false);
    // The description quoted the refresh token. Nothing above the adapter may ever see that.
    expect(providerError.message).not.toContain(TOKENS.refresh);
    expect(providerError.detail).toBe('invalid_grant');
  });

  it('separates a revoked consent from a wrong installed secret', () => {
    expect(statusError(400, { error: 'invalid_grant' }).category).toBe('authorization');
    expect(statusError(401, { error: 'invalid_client' }).category).toBe('configuration_invalid');
    expect(statusError(429, {}).retryable).toBe(true);
    expect(statusError(503, {}).category).toBe('provider_outage');
    expect(statusError(400, {}).category).toBe('permanent_validation');
  });

  it('resolves the account and the account-specific base URI from userinfo', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        sub: 'user-77',
        email: 'agent-test@example.invalid',
        accounts: [
          { account_id: 'acct-1', organization: { account_name: 'Second Account' }, base_uri: 'https://na2.docusign.net', is_default: 'false' },
          { account_id: 'acct-2', organization: { account_name: 'Default Account' }, base_uri: 'https://na1.docusign.net', is_default: 'true' },
        ],
      }),
    ];
    const client = new DocuSignOAuthClient(transport);
    const info = await client.userinfo('demo', TOKENS.access);
    expect(transport.calls[0]?.url).toBe(`https://${DOCUSIGN_AUTH_HOSTS.demo}/oauth/userinfo`);
    expect(transport.calls[0]?.headers?.['authorization']).toBe(`Bearer ${TOKENS.access}`);
    expect(info.subjectUserId).toBe('user-77');
    expect(info.accounts).toHaveLength(2);
    const chosen = selectDocuSignAccount(info, null);
    expect(chosen.accountId).toBe('acct-2');
    expect(chosen.baseUri).toBe('https://na1.docusign.net');
    // A connection that already named an account must not be moved by a re-authorization.
    expect(selectDocuSignAccount(info, 'acct-1').accountId).toBe('acct-1');
  });

  it('refuses to guess when the account list is empty or ambiguous', () => {
    const empty = parseDocuSignUserinfo({ accounts: [] });
    expect(() => selectDocuSignAccount(empty, null)).toThrow(/no account/);
    const ambiguous = parseDocuSignUserinfo({
      accounts: [
        { account_id: 'a', base_uri: 'https://x.invalid' },
        { account_id: 'b', base_uri: 'https://y.invalid' },
      ],
    });
    expect(() => selectDocuSignAccount(ambiguous, null)).toThrow(/no default/);
    // An entry without the two fields the platform needs is dropped, not invented.
    expect(parseDocuSignUserinfo({ accounts: [{ account_id: 'a' }] }).accounts).toEqual([]);
  });
});

describe('the live DocuSign adapter (19-ES.4)', () => {
  it('speaks to the stored base URI only, and never infers a data center host', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ envelopes: [] })];
    const adapter = new DocuSignAdapter(transport);
    const status = await adapter.connectionStatus(context({ baseUri: 'https://na3.docusign.net/' }));
    expect(transport.calls[0]?.url).toBe('https://na3.docusign.net/restapi/v2.1/accounts/acct-9/envelopes?count=1');
    expect(status).toMatchObject({ reachable: true, detailCode: 'ok' });
    expect(restBase('https://x.invalid')).toBe('https://x.invalid/restapi/v2.1');
  });

  it('names the reason a test failed, with a stable code and no provider body', async () => {
    const cases: [number, string][] = [
      [401, 'token_expired'],
      [403, 'access_denied'],
      [404, 'account_not_found'],
      [429, 'rate_limited'],
      [500, 'provider_outage'],
      [400, 'response_invalid'],
    ];
    for (const [status, expected] of cases) {
      const transport = stubTransport();
      transport.statuses = [status];
      transport.bodies = [JSON.stringify({ message: `bearer ${TOKENS.access} refused` })];
      const result = await new DocuSignAdapter(transport).connectionStatus(context());
      expect(result.reachable, String(status)).toBe(false);
      expect(result.detailCode, String(status)).toBe(expected);
      expect(JSON.stringify(result)).not.toContain(TOKENS.access);
      expect(detailCodeForStatus(status)).toBe(expected);
    }
  });

  it('treats a non-JSON success and an unreachable provider as failures', async () => {
    const html = stubTransport();
    html.statuses = [200];
    html.bodies = ['<html>proxy error</html>'];
    expect(await new DocuSignAdapter(html).connectionStatus(context())).toMatchObject({ reachable: false, detailCode: 'response_invalid' });

    const throwing: DocuSignTransport = {
      request: () => {
        throw new ProviderError('TIMEOUT', 'The provider did not answer.', { category: 'transient', retryable: true });
      },
    };
    expect(await new DocuSignAdapter(throwing).connectionStatus(context())).toMatchObject({ reachable: false, detailCode: 'unreachable' });

    const refused: DocuSignTransport = {
      request: () => {
        throw new DocuSignDestinationError('The provider URL must use https.');
      },
    };
    expect(await new DocuSignAdapter(refused).connectionStatus(context())).toMatchObject({ reachable: false, detailCode: 'destination_refused' });
  });

  it('re-reads the account context through the REST host without moving the connection', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        user_id: 'user-77',
        accounts: [
          { account_id: 'acct-9', organization: { account_name: 'Named' }, base_uri: 'https://demo.docusign.net', is_default: true },
          { account_id: 'acct-other', organization: { account_name: 'Other' }, base_uri: 'https://na1.docusign.net', is_default: false },
        ],
      }),
    ];
    const account = await new DocuSignAdapter(transport).accountContext(context());
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/userinfo');
    expect(account).toMatchObject({ accountId: 'acct-9', accountName: 'Named', userId: 'user-77' });
  });

  it('declares the implemented operations, including status, artifacts and Connect, and refuses correction', async () => {
    const adapter = new DocuSignAdapter(stubTransport());
    expect(adapter.mode).toBe('live');
    expect(adapter.capabilities.connectionStatus).toBe(true);
    expect(adapter.capabilities.accountContext).toBe(true);
    for (const operation of [
      'listTemplates',
      'templateDetails',
      'prepareEnvelope',
      'sendEnvelope',
      'envelopeStatus',
      'listRecipients',
      'recipientView',
      'resendNotifications',
      'voidEnvelope',
      'downloadCompletedDocuments',
      'downloadCompletionEvidence',
      'verifyWebhook',
    ] as const) {
      expect(DOCUSIGN_ES4_CAPABILITIES[operation], operation).toBe(true);
    }
    expect(DOCUSIGN_ES4_CAPABILITIES.correctEnvelope).toBe(false);
    // With no signature configured, a delivery is refused by name rather than thrown: the inbox is
    // the record of the attempt, and the endpoint must still answer.
    const parsed = await adapter.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: null,
      expectedAccountId: null,
      rawBody: new TextEncoder().encode('{"event":"envelope-completed"}'),
      headers: {},
      contentType: 'application/json',
      signingSecret: null,
      requireSignature: true,
      maxPayloadBytes: 1024,
    });
    expect(parsed.verified).toBe(false);
    expect(parsed.refusalReason).toBe('no_secret');
  });
});

describe('the DocuSign template catalog (19-ES.7, plan §6.7)', () => {
  it('reads the account catalog from the stored base URI and skips entries without an id', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        templates: [
          { templateId: 'tpl-1', name: 'Service Agreement', description: 'Standard', shared: 'true', status: 'active' },
          { templateId: 'tpl-2', name: 'NDA', shared: false },
          { name: 'no id' },
          'not-an-object',
        ],
      }),
    ];
    const templates = await new DocuSignAdapter(transport).listTemplates(context({ baseUri: 'https://na3.docusign.net' }));
    expect(transport.calls[0]?.url).toBe('https://na3.docusign.net/restapi/v2.1/accounts/acct-9/templates?count=100&order_by=name&order=asc');
    expect(transport.calls[0]?.headers?.['authorization']).toBe(`Bearer ${TOKENS.access}`);
    expect(templates.map((template) => template.templateId)).toEqual(['tpl-1', 'tpl-2']);
    expect(templates[0]).toMatchObject({ name: 'Service Agreement', description: 'Standard', shared: true, status: 'active' });
    expect(templates[1]).toMatchObject({ name: 'NDA', description: null, shared: false, status: null });
  });

  it('reads a template\'s roles and tabs, resolving each tab to the role that fills it', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        templateId: 'tpl-1',
        name: 'Service Agreement',
        shared: 'false',
        status: 'active',
        recipients: {
          signers: [
            { roleName: 'Signer 1', recipientId: '1', routingOrder: '1' },
            { roleName: 'Signer 2', recipientId: '2', routingOrder: 2 },
          ],
          carbonCopies: [{ roleName: 'CC 1', recipientId: '3', routingOrder: 3 }],
        },
        documents: [
          {
            documentId: 'doc-1',
            tabs: {
              textTabs: [
                { tabLabel: 'Full Name', recipientId: '1', required: 'true' },
                { tabLabel: 'Company', recipientId: '2', required: false },
              ],
              signHereTabs: [{ tabLabel: 'Sign Here', recipientId: '1', required: 'true' }],
              unknownTabs: [{ tabLabel: 'Ignored', recipientId: '1' }],
            },
          },
        ],
      }),
    ];
    const detail = await new DocuSignAdapter(transport).templateDetails(context(), 'tpl-1');
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/templates/tpl-1');
    expect(detail.roles).toEqual([
      { roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, required: true },
      { roleName: 'Signer 2', recipientType: 'signer', routingOrder: 2, required: true },
      { roleName: 'CC 1', recipientType: 'carbon_copy', routingOrder: 3, required: true },
    ]);
    expect(detail.fields.map((field) => [field.tabLabel, field.roleName, field.fieldType, field.required])).toEqual([
      ['Full Name', 'Signer 1', 'text', true],
      ['Company', 'Signer 2', 'text', false],
      ['Sign Here', 'Signer 1', 'signHere', true],
    ]);
    // The unknown tab collection is not a template field this module understands; it is not guessed into one.
    expect(detail.fields.map((field) => field.tabLabel)).not.toContain('Ignored');
  });

  it('reports an unknown template as a not-found provider failure, and refuses an empty id', async () => {
    const transport = stubTransport();
    transport.statuses = [404];
    transport.bodies = [JSON.stringify({ errorCode: 'TEMPLATE_NOT_FOUND' })];
    const failure = await new DocuSignAdapter(transport)
      .templateDetails(context(), 'missing-template')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).category).toBe('not_found');
    expect((failure as ProviderError).code).toBe('NOT_FOUND');

    await expect(new DocuSignAdapter(stubTransport()).templateDetails(context(), '   ')).rejects.toMatchObject({ category: 'permanent_validation' });
  });

  it('leaves a tab whose recipient is not a template role unattached rather than guessing', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        templateId: 'tpl-1',
        name: 'Dangling tab',
        recipients: { signers: [{ roleName: 'Signer 1', recipientId: '1', routingOrder: '1' }] },
        documents: [{ documentId: 'doc-1', tabs: { textTabs: [{ tabLabel: 'Orphan', recipientId: '9', required: false }] } }],
      }),
    ];
    const detail = await new DocuSignAdapter(transport).templateDetails(context(), 'tpl-1');
    expect(detail.fields).toEqual([{ tabLabel: 'Orphan', roleName: null, documentId: 'doc-1', fieldType: 'text', required: false }]);
  });
});

describe('the DocuSign envelope preparation (19-ES.9, plan §4.3)', () => {
  it('creates a draft envelope from the snapshotted documents and the routing', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ envelopeId: 'env-1', status: 'created', statusDateTime: '2026-01-02T03:04:05Z' })];
    const prepared = await new DocuSignAdapter(transport).prepareEnvelope(context(), {
      signatureRequestId: 'request-1',
      idempotencyKey: 'prepare-key-1',
      correlationId: 'corr-1',
      templateId: null,
      subject: 'Please sign',
      emailBlurb: 'Hello',
      expiresAt: null,
      documents: [
        { documentSnapshotId: 'snap-1', displayName: 'agreement.pdf', mimeType: 'application/pdf', documentOrder: 1, bytes: new TextEncoder().encode('%PDF-1.4'), contentHashSha256: 'a'.repeat(64) },
      ],
      recipients: [
        { recipientId: 'r1', name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1', authenticationMethod: null },
        { recipientId: 'r2', name: 'Copy', email: 'copy@example.invalid', recipientType: 'carbon_copy', routingOrder: 2, roleName: null, authenticationMethod: null },
      ],
      mappedFields: [{ tabLabel: 'Full Name', roleName: 'Signer 1', value: 'Agent Test' }],
    });
    const call = transport.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes');
    const body = JSON.parse(String(call?.body)) as Record<string, unknown>;
    expect(body['status']).toBe('created');
    expect(body['emailSubject']).toBe('Please sign');
    expect(String((body['documents'] as { documentBase64: string }[])[0]?.documentBase64)).toBe(Buffer.from('%PDF-1.4').toString('base64'));
    const recipients = body['recipients'] as { signers: { recipientId: string; routingOrder: number; tabs: { textTabs: { tabLabel: string; value: string }[] } }[]; carbonCopies: { recipientId: string }[] };
    expect(recipients.signers.map((signer) => signer.recipientId)).toEqual(['r1']);
    expect(recipients.signers[0]?.tabs.textTabs).toEqual([{ tabLabel: 'Full Name', value: 'Agent Test' }]);
    expect(recipients.carbonCopies.map((copy) => copy.recipientId)).toEqual(['r2']);
    expect(JSON.stringify(body)).toContain('CRMRequestId');
    expect(prepared).toMatchObject({ providerEnvelopeId: 'env-1', status: 'draft', idempotencyKey: 'prepare-key-1' });
    expect(prepared.providerDocumentIds).toEqual({ 'snap-1': '1' });
  });

  it('creates a template draft with the roles and tab values nested under them', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ envelopeId: 'env-2', status: 'created' })];
    await new DocuSignAdapter(transport).prepareEnvelope(context(), {
      signatureRequestId: 'request-2',
      idempotencyKey: 'prepare-key-2',
      correlationId: null,
      templateId: 'tpl-1',
      subject: 'Contract',
      emailBlurb: null,
      expiresAt: null,
      documents: [],
      recipients: [{ recipientId: 'r1', name: 'Signer One', email: 'one@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: 'Signer 1', authenticationMethod: null }],
      mappedFields: [
        { tabLabel: 'Full Name', roleName: 'Signer 1', value: 'Agent Test' },
        { tabLabel: 'Company', roleName: 'Signer 1', value: 'CaroCRM' },
      ],
    });
    const body = JSON.parse(String(transport.calls[0]?.body)) as Record<string, unknown>;
    expect(body['templateId']).toBe('tpl-1');
    expect(body['documents']).toBeUndefined();
    const roles = body['templateRoles'] as { roleName: string; email: string; tabs: { textTabs: { tabLabel: string; value: string }[] } }[];
    expect(roles).toHaveLength(1);
    expect(roles[0]?.roleName).toBe('Signer 1');
    expect(roles[0]?.tabs.textTabs.map((tab) => tab.tabLabel)).toEqual(['Full Name', 'Company']);
  });

  it('refuses a template envelope whose recipients do not name their roles', async () => {
    const transport = stubTransport();
    const failure = await new DocuSignAdapter(transport)
      .prepareEnvelope(context(), {
        signatureRequestId: 'request-3',
        idempotencyKey: 'k',
        correlationId: null,
        templateId: 'tpl-1',
        subject: null,
        emailBlurb: null,
        expiresAt: null,
        documents: [],
        recipients: [{ recipientId: 'r1', name: 'Signer', email: 's@example.invalid', recipientType: 'signer', routingOrder: 1, roleName: null, authenticationMethod: null }],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).detail).toBe('template_role_missing');
    expect(transport.calls).toHaveLength(0);
  });

  it('deletes a draft envelope and treats a missing one as already gone', async () => {
    const transport = stubTransport();
    transport.statuses = [204, 404];
    transport.bodies = ['', ''];
    const adapter = new DocuSignAdapter(transport);
    expect(await adapter.abandonDraftEnvelope(context(), 'env-1')).toEqual({ deleted: true });
    expect(transport.calls[0]?.method).toBe('DELETE');
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1');
    expect(await adapter.abandonDraftEnvelope(context(), 'env-2')).toEqual({ deleted: false });
  });
});

describe('the transport destination gate (19-ES.4, plan §9.3)', () => {
  const resolveTo = (addresses: string[]) => async (): Promise<string[]> => addresses;

  it('refuses a plain http destination that is not loopback', async () => {
    const transport = createDocuSignTransport({ resolveHost: resolveTo(['93.184.216.34']) });
    await expect(transport.request({ method: 'GET', url: 'http://example.invalid/restapi' })).rejects.toBeInstanceOf(DocuSignDestinationError);
  });

  it('refuses a stored base URI that resolves to a private or metadata address', async () => {
    for (const addresses of [['127.0.0.1'], ['10.0.0.5'], ['169.254.169.254'], ['192.168.1.20']]) {
      const transport = createDocuSignTransport({ resolveHost: resolveTo(addresses) });
      await expect(transport.request({ method: 'GET', url: 'https://crm-internal.example/restapi/v2.1/accounts/1' })).rejects.toBeInstanceOf(
        DocuSignDestinationError,
      );
    }
  });

  it('refuses a URL that carries credentials in it', async () => {
    const transport = createDocuSignTransport({ resolveHost: resolveTo(['93.184.216.34']) });
    await expect(transport.request({ method: 'GET', url: 'https://user:pass@example.invalid/x' })).rejects.toThrow(/credentials/);
  });

  it('lets a loopback destination through only when the installation opted in', async () => {
    // The platform's own gate names the loopback *hosts* a plain http provider URL may use.
    const local = 'http://localhost:9443/restapi/v2.1/accounts/1';
    const closed = createDocuSignTransport({ resolveHost: resolveTo(['127.0.0.1']) });
    await expect(closed.request({ method: 'GET', url: local })).rejects.toThrow(/https/);

    const open = createDocuSignTransport({
      allowLoopback: true,
      resolveHost: resolveTo(['127.0.0.1']),
      fetchImpl: (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    });
    const response = await open.request({ method: 'GET', url: local });
    expect(response.status).toBe(200);
    expect(response.body).toContain('ok');
  });
});

describe('the DocuSign status, signing and artifact operations (19-ES.11–19-ES.16)', () => {
  it('reads the envelope status and recipients with the raw provider words preserved', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        status: 'completed',
        statusDateTime: '2026-01-01T09:20:00.000Z',
        recipients: { signers: [{ recipientId: '1', clientUserId: 'local-r1', status: 'completed', email: 's@example.com', name: 'Signer' }] },
      }),
      JSON.stringify({ signers: [{ recipientId: '1', clientUserId: 'local-r1', status: 'completed', email: 's@example.com', name: 'Signer' }] }),
    ];
    const adapter = new DocuSignAdapter(transport);
    const status = await adapter.envelopeStatus(context(), 'env-1');
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1');
    expect(status).toMatchObject({ status: 'completed', providerStatusRaw: 'completed', occurredAt: '2026-01-01T09:20:00.000Z' });
    expect(status.recipients[0]).toMatchObject({ providerRecipientId: '1', recipientId: 'local-r1', status: 'completed' });

    const recipients = await adapter.listRecipients(context(), 'env-1');
    expect(transport.calls[1]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1/recipients');
    expect(recipients[0]?.email).toBe('s@example.com');
  });

  it('asks for one recipient view with the client user id that was set at preparation', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ url: 'https://demo.docusign.net/signing/session-1' })];
    const view = await new DocuSignAdapter(transport).recipientView(context(), {
      providerEnvelopeId: 'env-1',
      recipientProviderId: '1',
      recipientId: 'local-r1',
      email: 's@example.com',
      name: 'Signer',
      returnUrl: 'https://crm.example.com/esignature',
      cancelUrl: null,
      correlationId: 'corr-1',
    });
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1/views/recipient');
    const body = JSON.parse(String(transport.calls[0]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ recipientId: '1', clientUserId: 'local-r1', returnUrl: 'https://crm.example.com/esignature' });
    expect(view.url).toContain('/signing/session-1');
    expect(view.expiresAt).not.toBeNull();
  });

  it('resends to the named recipients and voids with the recorded reason', async () => {
    const transport = stubTransport();
    transport.bodies = [JSON.stringify({ status: 'sent' }), JSON.stringify({ status: 'voided', statusDateTime: '2026-01-01T10:00:00.000Z' })];
    const adapter = new DocuSignAdapter(transport);
    await adapter.resendNotifications(context(), {
      providerEnvelopeId: 'env-1',
      recipientProviderIds: ['1'],
      idempotencyKey: 'key',
      correlationId: 'corr',
    });
    expect(transport.calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1/recipients');
    expect(JSON.parse(String(transport.calls[0]?.body))).toEqual({ resend_envelope: 'true', signers: [{ recipientId: '1' }] });

    const voided = await adapter.voidEnvelope(context(), {
      providerEnvelopeId: 'env-1',
      reason: 'wrong counterparty',
      idempotencyKey: 'key',
      correlationId: 'corr',
    });
    expect(transport.calls[1]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-9/envelopes/env-1');
    expect(JSON.parse(String(transport.calls[1]?.body))).toEqual({ status: 'voided', voidedReason: 'wrong counterparty' });
    expect(voided).toMatchObject({ providerStatusRaw: 'voided', voidedAt: '2026-01-01T10:00:00.000Z' });
  });

  it('downloads the signed documents and the certificate as bytes with content hashes', async () => {
    const transport = stubTransport();
    transport.bodies = [
      JSON.stringify({
        envelopeDocuments: [
          { documentId: '1', name: 'agreement.pdf' },
          { documentId: 'certificate', name: 'certificate.pdf' },
        ],
      }),
    ];
    transport.binaryBodies = [new TextEncoder().encode('%PDF-1.4 signed'), new TextEncoder().encode('%PDF-1.4 certificate')];
    const adapter = new DocuSignAdapter(transport);
    const documents = await adapter.downloadCompletedDocuments(context(), 'env-1');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ artifactKind: 'provider_signed_document', providerDocumentId: '1', displayName: 'agreement.pdf' });
    expect(documents[0]?.contentHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(transport.calls[1]?.binary).toBe(true);

    const evidence = await adapter.downloadCompletionEvidence(context(), 'env-1');
    expect(evidence[0]).toMatchObject({ artifactKind: 'completion_evidence', providerDocumentId: 'certificate' });
    expect(evidence[0]?.contentHashSha256).not.toBe(documents[0]?.contentHashSha256);
  });

  it('verifies a Connect delivery before parsing it, and refuses a different account', async () => {
    const secret = 'connect-secret';
    const raw = new TextEncoder().encode(
      JSON.stringify({
        event: 'envelope-completed',
        generatedDateTime: '2026-01-01T09:20:00.000Z',
        data: {
          accountId: 'acct-9',
          envelopeId: 'env-1',
          recipientId: '1',
          recipients: { signers: [{ recipientId: '1', status: 'completed', email: 's@example.com', name: 'Signer' }] },
        },
      }),
    );
    const adapter = new DocuSignAdapter(stubTransport());
    const parsed = await adapter.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: 'conn-1',
      expectedAccountId: 'acct-9',
      rawBody: raw,
      headers: { 'x-docusign-signature-1': connectSignature(secret, raw), 'content-type': 'application/json' },
      contentType: 'application/json',
      signingSecret: secret,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(parsed).toMatchObject({
      verified: true,
      providerEnvelopeId: 'env-1',
      providerAccountId: 'acct-9',
      eventTypeNormalized: 'completed',
      recipientProviderId: '1',
      recipientStatusRaw: 'completed',
    });
    expect(parsed.minimized).toEqual({ envelopeId: 'env-1', eventType: 'envelope-completed', recipientId: '1', recipientStatus: 'completed' });

    const misrouted = await adapter.verifyAndParseWebhook({
      providerKey: 'docusign',
      connectionId: 'conn-1',
      expectedAccountId: 'acct-other',
      rawBody: raw,
      headers: { 'x-docusign-signature-1': connectSignature(secret, raw) },
      contentType: 'application/json',
      signingSecret: secret,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(misrouted).toMatchObject({ verified: false, refusalReason: 'account_mismatch', providerEnvelopeId: null });
  });
});
