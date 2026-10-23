import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hmacSha256Hex } from '../src/advanced-integrations/connectors/kit/webhook-signatures.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import { DropboxSignAdapter } from '../src/esignature/providers/dropbox-sign/dropbox-sign-adapter.js';
import { DROPBOX_SIGN_TRANSPORT, type DropboxSignHttpRequest, type DropboxSignHttpResponse, type DropboxSignTransport,encodeMultipart } from '../src/esignature/providers/dropbox-sign/dropbox-sign-transport.js';
import { isNotSupportedByProviderError, isSendOutcomeUnknownError } from '../src/esignature/providers/signature-provider.errors.js';
import type {
  PrepareEnvelopeInput,
  ProviderWebhookNotification,
  SignatureProviderContext,
  VerifyWebhookInput,
} from '../src/esignature/providers/signature-provider.port.js';

/**
 * Dropbox Sign adapter — the second live provider, without a socket.
 *
 * Pure unit tests over the transport seam (plan §17.3): every assertion about the wire is an
 * assertion about the bytes the adapter really builds, and nothing here touches a database, a
 * network or a clock. The suite covers the three things that make this provider different from the
 * reference one — direct send (no unsent draft), multipart document upload, and `event_hash`
 * verification over `event_time + event_type`.
 */

const API_KEY = 'agent-test-dropbox-api-key';
const ACCOUNT_ID = 'agent-test-account-1';
const CLIENT_ID = 'agent-test-app-client';

const context: SignatureProviderContext = {
  connectionId: 'connection-1',
  providerKey: 'dropbox_sign',
  environment: 'demo',
  accountId: ACCOUNT_ID,
  baseUri: 'https://api.hellosign.com/v3',
  grantedScopes: [],
  accessToken: API_KEY,
  clientId: CLIENT_ID,
  correlationId: 'agent-test-correlation',
  timeoutMs: 5_000,
};

interface StubState {
  calls: DropboxSignHttpRequest[];
  response: { status: number; body: unknown; bytes?: Uint8Array } | null;
}

const stub: StubState = { calls: [], response: null };

const transport: DropboxSignTransport = {
  async request(input: DropboxSignHttpRequest): Promise<DropboxSignHttpResponse> {
    stub.calls.push(input);
    const answer = stub.response ?? { status: 200, body: {} };
    const bytes = answer.bytes ?? new TextEncoder().encode(JSON.stringify(answer.body));
    return { status: answer.status, headers: {}, body: bytes, text: Buffer.from(bytes).toString('utf8') };
  },
};

function reset(answer: StubState['response'] = { status: 200, body: {} }): void {
  stub.calls = [];
  stub.response = answer;
}

function adapter(): DropboxSignAdapter {
  return new DropboxSignAdapter(transport);
}

/**
 * The webhook verifier, through the port's optional method.
 *
 * The method is optional because an adapter that cannot verify does not declare the capability; the
 * adapter under test does declare it, so a missing method is a broken fixture, not a test outcome.
 */
async function verify(input: VerifyWebhookInput): Promise<ProviderWebhookNotification> {
  const live = adapter();
  const verifyMethod = live.verifyAndParseWebhook;
  if (verifyMethod === undefined) throw new Error('The Dropbox Sign adapter must verify webhooks.');
  return verifyMethod.call(live, input);
}

function requestInput(overrides: Partial<PrepareEnvelopeInput> = {}): PrepareEnvelopeInput {
  return {
    signatureRequestId: 'request-1',
    idempotencyKey: 'agent-test-idempotency-key',
    correlationId: 'agent-test-correlation',
    templateId: null,
    subject: 'AGENT_TEST Service Agreement',
    emailBlurb: 'Please sign.',
    expiresAt: '2026-12-01T00:00:00.000Z',
    documents: [
      {
        documentSnapshotId: 'document-1',
        displayName: 'agreement.pdf',
        mimeType: 'application/pdf',
        documentOrder: 1,
        bytes: new TextEncoder().encode('%PDF-1.4\n% agent test\n%%EOF\n'),
        contentHashSha256: createHash('sha256').update('agent-test-document').digest('hex'),
      },
    ],
    recipients: [
      {
        recipientId: 'recipient-1',
        name: 'Agent Test Signer',
        email: 'agent-test-signer@example.test',
        recipientType: 'signer',
        routingOrder: 1,
        roleName: null,
        authenticationMethod: null,
        clientUserId: null,
      },
    ],
    mappedFields: [],
    ...overrides,
  };
}

function signatureRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signature_request_id: 'provider-request-1',
    created_at: 1_800_000_000,
    is_complete: false,
    is_declined: false,
    test_mode: true,
    signatures: [
      {
        signature_id: 'provider-signature-1',
        signer_email_address: 'agent-test-signer@example.test',
        signer_name: 'Agent Test Signer',
        order: 0,
        status_code: 'awaiting_signature',
        signed_at: null,
        last_viewed_at: null,
        decline_reason: null,
      },
    ],
    ...overrides,
  };
}

describe('the Dropbox Sign adapter contract', () => {
  it('declares direct send and refuses the draft operations it does not have', async () => {
    const live = adapter();
    expect(live.envelopeDrafting).toBe('direct');
    expect(live.capabilities.sendNewEnvelope).toBe(true);
    expect(live.capabilities.prepareEnvelope).toBe(false);
    expect(live.capabilities.recipientView).toBe(false);
    expect(live.capabilities.downloadCompletionEvidence).toBe(false);

    await expect(live.prepareEnvelope(context, requestInput())).rejects.toSatisfy(isNotSupportedByProviderError);
    await expect(
      live.sendEnvelope(context, {
        signatureRequestId: 'request-1',
        providerEnvelopeId: 'provider-request-1',
        idempotencyKey: 'key',
        correlationId: 'correlation',
      }),
    ).rejects.toSatisfy(isNotSupportedByProviderError);
    await expect(
      live.recipientView(context, {
        providerEnvelopeId: 'provider-request-1',
        recipientProviderId: 'provider-signature-1',
        recipientId: 'recipient-1',
        email: 'agent-test-signer@example.test',
        name: 'Agent Test Signer',
        returnUrl: 'https://crm.example.test/esignature',
        cancelUrl: null,
        correlationId: 'correlation',
      }),
    ).rejects.toSatisfy(isNotSupportedByProviderError);
  });

  it('creates and sends a document request in one multipart call', async () => {
    reset({ status: 200, body: { signature_request: signatureRequest() } });
    const result = await adapter().sendNewEnvelope(context, requestInput());

    expect(result.providerEnvelopeId).toBe('provider-request-1');
    expect(result.providerStatusRaw).toBe('sent');
    expect(result.sentAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(result.recipients).toEqual([
      expect.objectContaining({ providerRecipientId: 'provider-signature-1', recipientId: 'recipient-1', email: 'agent-test-signer@example.test', status: 'sent' }),
    ]);

    const call = stub.calls[0];
    expect(call).toBeDefined();
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://api.hellosign.com/v3/signature_request/send');
    // Basic auth: the API key as the username and an empty password.
    expect(call?.headers?.['authorization']).toBe(`Basic ${Buffer.from(`${API_KEY}:`, 'utf8').toString('base64')}`);
    expect(call?.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.from(call?.body ?? new Uint8Array()).toString('utf8');
    expect(body).toContain('name="files[0]"; filename="agreement.pdf"');
    expect(body).toContain('Content-Type: application/pdf');
    expect(body).toContain('%PDF-1.4');
    expect(body).toContain('name="signers[0][email_address]"');
    expect(body).toContain('name="metadata[crm_signature_request_id]"');
    expect(body).toContain('name="test_mode"');
    expect(body).toContain('name="allow_decline"');
    expect(body).toContain('name="client_id"');
  });

  it('sends a template request as JSON with roles, CC recipients and mapped values', async () => {
    reset({ status: 200, body: { signature_request: signatureRequest() } });
    const result = await adapter().sendNewEnvelope(
      context,
      requestInput({
        templateId: 'template-1',
        documents: [],
        recipients: [
          {
            recipientId: 'recipient-1',
            name: 'Agent Test Signer',
            email: 'agent-test-signer@example.test',
            recipientType: 'signer',
            routingOrder: 1,
            roleName: 'Signer 1',
            authenticationMethod: null,
            clientUserId: null,
          },
          {
            recipientId: 'recipient-2',
            name: 'Agent Test CC',
            email: 'agent-test-cc@example.test',
            recipientType: 'carbon_copy',
            routingOrder: 2,
            roleName: 'CC 1',
            authenticationMethod: null,
            clientUserId: null,
          },
        ],
        mappedFields: [{ tabLabel: 'Company', roleName: 'Signer 1', value: 'CaroCRM' }],
      }),
    );

    expect(result.providerEnvelopeId).toBe('provider-request-1');
    const call = stub.calls[0];
    expect(call?.url).toBe('https://api.hellosign.com/v3/signature_request/send_with_template');
    expect(call?.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(Buffer.from(call?.body ?? new Uint8Array()).toString('utf8')) as Record<string, unknown>;
    expect(body['template_ids']).toEqual(['template-1']);
    expect(body['signers']).toEqual([{ role: 'Signer 1', name: 'Agent Test Signer', email_address: 'agent-test-signer@example.test' }]);
    expect(body['ccs']).toEqual([{ role: 'CC 1', email_address: 'agent-test-cc@example.test' }]);
    expect(body['custom_fields']).toEqual([{ name: 'Company', value: 'CaroCRM' }]);
    expect(body['metadata']).toMatchObject({ crm_signature_request_id: 'request-1' });
    expect(body['client_id']).toBe(CLIENT_ID);
  });

  it('refuses a template recipient with no role, before any provider call', async () => {
    reset();
    await expect(
      adapter().sendNewEnvelope(
        context,
        requestInput({
          templateId: 'template-1',
          documents: [],
          recipients: [
            {
              recipientId: 'recipient-1',
              name: 'Agent Test Signer',
              email: 'agent-test-signer@example.test',
              recipientType: 'signer',
              routingOrder: 1,
              roleName: null,
              authenticationMethod: null,
              clientUserId: null,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ category: 'permanent_validation', detail: 'template_role_required' });
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses embedded signing instead of sending an email-only request', async () => {
    reset();
    await expect(
      adapter().sendNewEnvelope(
        context,
        requestInput({
          recipients: [
            {
              recipientId: 'recipient-1',
              name: 'Agent Test Signer',
              email: 'agent-test-signer@example.test',
              recipientType: 'signer',
              routingOrder: 1,
              roleName: null,
              authenticationMethod: 'embedded',
              clientUserId: 'recipient-1',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ category: 'permanent_validation', detail: 'embedded_signing_unsupported' });
    expect(stub.calls).toHaveLength(0);
  });

  it('treats a 2xx without a request id as an unknown outcome, not a success', async () => {
    reset({ status: 200, body: { signature_request: {} } });
    await expect(adapter().sendNewEnvelope(context, requestInput())).rejects.toSatisfy(isSendOutcomeUnknownError);
  });

  it('classifies a refused send without echoing the provider message', async () => {
    reset({ status: 400, body: { error: { error_name: 'invalid_request', error_msg: 'The value agent-test-secret is wrong' } } });
    const failure = await adapter()
      .sendNewEnvelope(context, requestInput())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ category: 'permanent_validation', code: 'INVALID_REQUEST', detail: 'invalid_request' });
    expect(String((failure as Error).message)).not.toContain('agent-test-secret');
  });
});

describe('reading provider state', () => {
  it('maps a completed request and its signers, keeping the raw status words', async () => {
    reset({
      status: 200,
      body: {
        signature_request: signatureRequest({
          is_complete: true,
          signatures: [
            {
              signature_id: 'provider-signature-1',
              signer_email_address: 'agent-test-signer@example.test',
              signer_name: 'Agent Test Signer',
              order: 0,
              status_code: 'signed',
              signed_at: 1_800_000_100,
              last_viewed_at: 1_800_000_050,
              decline_reason: null,
            },
          ],
        }),
      },
    });
    const status = await adapter().envelopeStatus(context, 'provider-request-1');
    expect(status.status).toBe('completed');
    expect(status.providerStatusRaw).toBe('completed');
    expect(status.recipients[0]).toMatchObject({
      providerRecipientId: 'provider-signature-1',
      status: 'completed',
      providerStatusRaw: 'signed',
      email: 'agent-test-signer@example.test',
      routingOrder: 1,
    });
  });

  it('reports a deleted request as unknown rather than inventing a state', async () => {
    reset({ status: 404, body: { error: { error_name: 'not_found' } } });
    const status = await adapter().envelopeStatus(context, 'provider-request-1');
    expect(status).toMatchObject({ status: 'unknown', providerStatusRaw: 'not_found' });
  });

  it('lists templates and their roles and fields', async () => {
    reset({
      status: 200,
      body: {
        template: {
          template_id: 'template-1',
          title: 'AGENT_TEST Service Agreement',
          message: 'Please review.',
          is_creator: true,
          is_locked: false,
          signer_roles: [{ name: 'Signer 1', order: 0 }],
          cc_roles: [{ name: 'CC 1' }],
          documents: [
            {
              index: 0,
              form_fields: [{ name: 'Company', type: 'text', required: true, signer: 'Signer 1' }],
              custom_fields: [],
            },
          ],
        },
      },
    });
    const detail = await adapter().templateDetails(context, 'template-1');
    expect(detail).toMatchObject({ templateId: 'template-1', name: 'AGENT_TEST Service Agreement', shared: false });
    expect(detail.roles).toEqual([
      { roleName: 'Signer 1', recipientType: 'signer', routingOrder: 1, required: true },
      { roleName: 'CC 1', recipientType: 'carbon_copy', routingOrder: null, required: false },
    ]);
    expect(detail.fields).toEqual([
      { tabLabel: 'Company', roleName: 'Signer 1', documentId: '0', fieldType: 'text', required: true },
    ]);
  });

  it('downloads the signed documents as one PDF artifact', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 signed');
    reset({ status: 200, body: {}, bytes: pdf });
    const artifacts = await adapter().downloadCompletedDocuments(context, 'provider-request-1');
    expect(stub.calls[0]?.url).toContain('/signature_request/files/provider-request-1?file_type=pdf');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ artifactKind: 'provider_signed_document', mimeType: 'application/pdf', providerDocumentId: 'provider-request-1' });
    expect(Buffer.from(artifacts[0]?.bytes ?? new Uint8Array()).toString('utf8')).toBe('%PDF-1.4 signed');
  });
});

describe('callback verification', () => {
  function multipartBody(payload: unknown, boundary = 'agent-test-boundary'): { rawBody: Uint8Array; contentType: string } {
    return {
      rawBody: encodeMultipart([{ name: 'json', value: JSON.stringify(payload) }], boundary),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function event(overrides: { time?: string; type?: string; hash?: string } = {}): Record<string, unknown> {
    const time = overrides.time ?? '1800000000';
    const type = overrides.type ?? 'signature_request_all_signed';
    return {
      event: {
        event_time: time,
        event_type: type,
        event_hash: overrides.hash ?? hmacSha256Hex(API_KEY, `${time}${type}`),
        event_metadata: { related_signature_id: 'provider-signature-1', reported_for_account_id: ACCOUNT_ID },
      },
      signature_request: { signature_request_id: 'provider-request-1' },
    };
  }

  it('verifies the documented event hash and normalizes a completion', async () => {
    const { rawBody, contentType } = multipartBody(event());
    const notification = await verify({
      providerKey: 'dropbox_sign',
      connectionId: 'connection-1',
      expectedAccountId: ACCOUNT_ID,
      rawBody,
      headers: {},
      contentType,
      signingSecret: API_KEY,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(notification).toMatchObject({
      verified: true,
      refusalReason: null,
      providerEnvelopeId: 'provider-request-1',
      eventTypeNormalized: 'completed',
      providerAccountId: ACCOUNT_ID,
      recipientProviderId: 'provider-signature-1',
    });
  });

  it('refuses a tampered payload and exposes no envelope id', async () => {
    const payload = event();
    (payload['event'] as Record<string, unknown>)['event_hash'] = 'f'.repeat(64);
    const { rawBody, contentType } = multipartBody(payload);
    const notification = await verify({
      providerKey: 'dropbox_sign',
      connectionId: 'connection-1',
      expectedAccountId: ACCOUNT_ID,
      rawBody,
      headers: {},
      contentType,
      signingSecret: API_KEY,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(notification).toMatchObject({ verified: false, refusalReason: 'invalid_signature', providerEnvelopeId: null, minimized: {} });
  });

  it('refuses a delivery with no stored key, a mismatched account, and an oversized body', async () => {
    const { rawBody, contentType } = multipartBody(event());
    const base = {
      providerKey: 'dropbox_sign',
      connectionId: 'connection-1',
      expectedAccountId: ACCOUNT_ID,
      rawBody,
      headers: {},
      contentType,
      signingSecret: API_KEY,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    } as const;
    await expect(verify({ ...base, signingSecret: null })).resolves.toMatchObject({ refusalReason: 'no_secret' });
    await expect(verify({ ...base, expectedAccountId: 'another-account' })).resolves.toMatchObject({
      refusalReason: 'account_mismatch',
    });
    await expect(verify({ ...base, maxPayloadBytes: 10 })).resolves.toMatchObject({ refusalReason: 'too_large' });
  });

  it('accepts a JSON body and a form-encoded json field', async () => {
    const json = event({ type: 'signature_request_sent' });
    const asJson = await verify({
      providerKey: 'dropbox_sign',
      connectionId: 'connection-1',
      expectedAccountId: ACCOUNT_ID,
      rawBody: new TextEncoder().encode(JSON.stringify(json)),
      headers: {},
      contentType: 'application/json',
      signingSecret: API_KEY,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(asJson).toMatchObject({ verified: true, eventTypeNormalized: 'sent' });

    const asForm = await verify({
      providerKey: 'dropbox_sign',
      connectionId: 'connection-1',
      expectedAccountId: ACCOUNT_ID,
      rawBody: new TextEncoder().encode(`json=${encodeURIComponent(JSON.stringify(json))}`),
      headers: {},
      contentType: 'application/x-www-form-urlencoded',
      signingSecret: API_KEY,
      requireSignature: true,
      maxPayloadBytes: 262_144,
    });
    expect(asForm).toMatchObject({ verified: true, eventTypeNormalized: 'sent' });
  });
});

// A compile-time reminder that the transport token is the one the module binds; a test that stubs
// this object in the API suite must inject the same token.
void DROPBOX_SIGN_TRANSPORT;
