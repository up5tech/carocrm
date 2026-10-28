import { describe, expect, it } from 'vitest';

import { createFakeProviderAdapter } from '../src/advanced-integrations/connectors/fake/fake-provider.adapter.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import { DocuSignAdapter } from '../src/esignature/providers/docusign/docusign-adapter.js';
import type { DocuSignHttpRequest, DocuSignHttpResponse, DocuSignTransport } from '../src/esignature/providers/docusign/docusign-transport.js';
import { DropboxSignAdapter } from '../src/esignature/providers/dropbox-sign/dropbox-sign-adapter.js';
import type { DropboxSignHttpRequest, DropboxSignHttpResponse, DropboxSignTransport } from '../src/esignature/providers/dropbox-sign/dropbox-sign-transport.js';
import { createFakeSignatureProviderAdapter } from '../src/esignature/providers/fake-signature-provider.adapter.js';
import { assertSignatureProviderContract, runSignatureProviderContract } from '../src/esignature/providers/signature-provider.contract.js';
import { classifyAdapterError, toModuleError } from '../src/esignature/providers/signature-provider.errors.js';
import type { SignatureProviderAdapter, SignatureProviderContext } from '../src/esignature/providers/signature-provider.port.js';

/**
 * Phase 22.6 — the shared provider contract suite and the provider failure matrix
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 tasks 7 and 10; acceptance: "fake providers
 * simulate success, validation failures, timeout, rate-limit response, authentication expiry").
 *
 * Pure unit tests: no database, no HTTP, no clock. What they prove is a fact about the *contracts*:
 *
 *  - every adapter this build ships — the fake, DocuSign, Dropbox Sign — honours the same rules, so
 *    "a correct signature provider" means one thing and not one thing per vendor;
 *  - a broken adapter is **reported** with a stable rule name and **refused** at registration, so it
 *    cannot reach an operator as a working integration;
 *  - the failures a provider causes by accident (a timeout, a rate-limit answer, an expired
 *    credential) have one stable answer each, and the fake can produce every one of them on demand.
 */

const context: SignatureProviderContext = {
  connectionId: 'conn-1',
  providerKey: 'docusign',
  environment: 'demo',
  accountId: 'acct-1',
  baseUri: 'https://demo.docusign.net',
  grantedScopes: ['signature'],
  accessToken: 'agent-test-token-never-logged',
  clientId: null,
  correlationId: 'agent-test-correlation',
  timeoutMs: 10_000,
};

function docuSignTransport(): DocuSignTransport {
  return {
    async request(_input: DocuSignHttpRequest): Promise<DocuSignHttpResponse> {
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }), bytes: new Uint8Array() };
    },
  };
}

function dropboxSignTransport(): DropboxSignTransport {
  return {
    async request(_input: DropboxSignHttpRequest): Promise<DropboxSignHttpResponse> {
      const bytes = new TextEncoder().encode(JSON.stringify({ ok: true }));
      return { status: 200, headers: {}, body: bytes, text: Buffer.from(bytes).toString('utf8') };
    },
  };
}

/** A minimal adapter, used to build the broken ones. */
function adapterOf(overrides: Partial<SignatureProviderAdapter>): SignatureProviderAdapter {
  const base = createFakeSignatureProviderAdapter();
  return { ...base, ...overrides } as SignatureProviderAdapter;
}

describe('the shared signature provider contract', () => {
  it('is honoured by every adapter this build ships', () => {
    const adapters: readonly SignatureProviderAdapter[] = [
      createFakeSignatureProviderAdapter(),
      new DocuSignAdapter(docuSignTransport()),
      new DropboxSignAdapter(dropboxSignTransport()),
    ];
    for (const adapter of adapters) {
      expect({ providerKey: adapter.providerKey, failures: runSignatureProviderContract(adapter) }).toEqual({
        providerKey: adapter.providerKey,
        failures: [],
      });
    }
  });

  it('reports a broken adapter instead of throwing, so a test can name the rule that failed', () => {
    const broken = adapterOf({ sendEnvelope: undefined as never });
    const failures = runSignatureProviderContract(broken);
    expect(failures.map((failure) => failure.check)).toContain('capabilities.sendEnvelope');
    expect(failures.every((failure) => failure.message.trim() !== '')).toBe(true);
  });

  it('refuses a broken adapter at registration, with every failure listed', () => {
    const broken = adapterOf({
      providerKey: 'docusign',
      adapterVersion: '',
      sendEnvelope: undefined as never,
    });
    expect(() => assertSignatureProviderContract(broken)).toThrow(/does not honour the provider contract/);
    try {
      assertSignatureProviderContract(broken);
    } catch (error: unknown) {
      const details = (error as { details?: { failures?: { check: string }[] } }).details;
      const checks = (details?.failures ?? []).map((failure) => failure.check);
      expect(checks).toContain('adapterVersion');
      expect(checks).toContain('capabilities.sendEnvelope');
    }
  });

  it('requires a capability declaration that answers for every operation', () => {
    const partial = adapterOf({
      capabilities: { connectionStatus: true } as never,
    });
    const failures = runSignatureProviderContract(partial);
    expect(failures.map((failure) => failure.check)).toContain('capabilities.operations');
  });

  it('requires a direct sender to declare the operation the request service will ask for', () => {
    const direct = adapterOf({
      envelopeDrafting: 'direct',
      capabilities: { ...createFakeSignatureProviderAdapter().capabilities, sendNewEnvelope: false },
    });
    const failures = runSignatureProviderContract(direct);
    expect(failures.map((failure) => failure.check)).toContain('envelopeDrafting.direct');
  });

  it('requires a draft provider to be able to send the draft it prepares', () => {
    const draft = adapterOf({
      envelopeDrafting: 'draft',
      capabilities: { ...createFakeSignatureProviderAdapter().capabilities, sendEnvelope: false },
    });
    const failures = runSignatureProviderContract(draft);
    expect(failures.map((failure) => failure.check)).toContain('envelopeDrafting.draft');
  });
});

describe('the provider failure matrix', () => {
  it('answers a timeout with a retryable outage, not with a refusal', () => {
    const timeout = new ProviderError('TIMEOUT', 'The provider did not answer in time.', {
      category: 'transient',
      retryable: true,
      detail: 'timeout',
    });
    expect(classifyAdapterError(timeout)).toBe('transient');
    const mapped = toModuleError(timeout, 'docusign');
    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe('SIGNATURE_CONNECTION_NOT_AVAILABLE');
    expect(mapped.details).toEqual({ providerCode: 'TIMEOUT', category: 'transient' });
  });

  it('answers a rate limit with 429 and a retry hint', () => {
    const rateLimited = new ProviderError('RATE_LIMITED', 'Slow down.', {
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 5_000,
      detail: 'rate_limited',
    });
    const mapped = toModuleError(rateLimited, 'docusign');
    expect(mapped.statusCode).toBe(429);
    expect(mapped.details).toEqual({ providerCode: 'RATE_LIMITED', retryAfterMs: 5_000 });
  });

  it('answers an expired credential with a refusal to use the connection', () => {
    const expired = new ProviderError('TOKEN_EXPIRED', 'The token expired.', {
      category: 'authorization',
      retryable: false,
      detail: 'token_expired',
    });
    const mapped = toModuleError(expired, 'docusign');
    expect(mapped.statusCode).toBe(409);
    expect(mapped.code).toBe('SIGNATURE_CONNECTION_NOT_AVAILABLE');
    expect(mapped.details).toEqual({ providerCode: 'TOKEN_EXPIRED', category: 'authorization' });
  });

  it('answers a validation failure with an invalid request state', () => {
    const invalid = new ProviderError('INVALID_REQUEST', 'The envelope is closed.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'envelope_closed',
    });
    const mapped = toModuleError(invalid, 'docusign');
    expect(mapped.statusCode).toBe(409);
    expect(mapped.code).toBe('SIGNATURE_REQUEST_INVALID_STATE');
  });
});

describe('the fake signature provider', () => {
  it('raises a scripted timeout on the operation it was scripted for', async () => {
    const fake = createFakeSignatureProviderAdapter();
    fake.failNextCall(
      'sendEnvelope',
      new ProviderError('TIMEOUT', 'The provider did not answer in time.', {
        category: 'transient',
        retryable: true,
        detail: 'timeout',
      }),
    );
    const failure = await fake
      .sendEnvelope(context, {
        signatureRequestId: 'esr-1',
        providerEnvelopeId: 'fake-env-1',
        idempotencyKey: 'key-1',
        correlationId: 'agent-test-correlation',
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).code).toBe('TIMEOUT');
    expect((failure as ProviderError).category).toBe('transient');
  });

  it('raises a scripted rate limit and a scripted expired credential', async () => {
    const fake = createFakeSignatureProviderAdapter();
    fake.failNextCall(
      'envelopeStatus',
      new ProviderError('RATE_LIMITED', 'Slow down.', {
        category: 'rate_limited',
        retryable: true,
        retryAfterMs: 1_000,
        detail: 'rate_limited',
      }),
    );
    fake.failNextCall(
      'listRecipients',
      new ProviderError('TOKEN_EXPIRED', 'The token expired.', {
        category: 'authorization',
        retryable: false,
        detail: 'token_expired',
      }),
    );
    const rateLimited = await fake.envelopeStatus(context, 'fake-env-1').catch((error: unknown) => error);
    expect((rateLimited as ProviderError).category).toBe('rate_limited');
    const expired = await fake.listRecipients(context, 'fake-env-1').catch((error: unknown) => error);
    expect((expired as ProviderError).category).toBe('authorization');
  });

  it('consumes a scripted failure once, so the retry that follows can succeed', async () => {
    const fake = createFakeSignatureProviderAdapter();
    fake.failNextCall(
      'connectionStatus',
      new ProviderError('PROVIDER_UNAVAILABLE', 'The provider is down.', {
        category: 'provider_outage',
        retryable: true,
        detail: 'outage',
      }),
    );
    const first = await fake.connectionStatus(context).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ProviderError);
    const second = await fake.connectionStatus(context);
    expect(second.reachable).toBe(true);
  });
});

describe('the fake connector provider', () => {
  it('raises the scripted failure on the matching operation only', async () => {
    const fake = createFakeProviderAdapter();
    fake.failNextCall(
      'fetchPage',
      new ProviderError('TIMEOUT', 'The provider did not answer in time.', {
        category: 'transient',
        retryable: true,
        detail: 'timeout',
      }),
    );
    const failure = await fake
      .fetchPage({ objectType: 'contact', cursor: null, pageSize: 10 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).category).toBe('transient');
    // The scripted failure was bound to one operation, so the next read is unaffected.
    const page = await fake.fetchPage({ objectType: 'contact', cursor: null, pageSize: 10 });
    expect(page.objects.length).toBeGreaterThan(0);
  });

  it('drops a scripted failure when the fake is reset', async () => {
    const fake = createFakeProviderAdapter();
    fake.failNextCall(
      'listFields',
      new ProviderError('RATE_LIMITED', 'Slow down.', {
        category: 'rate_limited',
        retryable: true,
        retryAfterMs: 500,
        detail: 'rate_limited',
      }),
    );
    fake.reset();
    const fields = await fake.listFields({ credential: { apiKey: 'agent-test' } } as never, 'contact');
    expect(fields.length).toBeGreaterThan(0);
  });
});
