import { classifyAddress, isLoopbackHostname } from '@carocrm/core/net/address.js';
import { describe, expect, it } from 'vitest';

import { assertPublicUrl } from '../../../modules/webhook-integration/src/shared.js';
import { assertProviderUrl } from '../src/advanced-integrations/provider-http-client.js';
import { assertSafeProviderBaseUrl, isPrivateAddress } from '../src/ai-agents/ai-provider-url.js';
import { assertSafeMediaUrl } from '../src/voice-communications/media-url.js';

/**
 * Phase 23.5 — SSRF boundary (G86, plan §11 task 3; OWASP ASVS 5.2.6, API Top 10 API7:2023).
 *
 * G86 found four copies of one rule, and the copies disagreed about spellings of the same address:
 * `[::1]` kept its brackets, and `::ffff:7f00:1` was not recognised as 127.0.0.1. Each of those is a
 * complete bypass of the control, so the cases below are the spellings, not just the ranges.
 *
 * DB-free and deterministic: every host is an IP literal or a resolver the test injects, so nothing
 * here performs a DNS lookup or an outbound request.
 */

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';

describe('the shared address classification', () => {
  it('classifies IPv4 loopback, private, reserved and public ranges', () => {
    expect(classifyAddress('127.0.0.1')).toBe('loopback');
    expect(classifyAddress('127.255.255.254')).toBe('loopback');
    expect(classifyAddress('10.1.2.3')).toBe('private');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('192.168.1.1')).toBe('private');
    expect(classifyAddress('169.254.169.254')).toBe('private');
    expect(classifyAddress('100.64.0.1')).toBe('private');
    expect(classifyAddress('0.0.0.0')).toBe('private');
    expect(classifyAddress('224.0.0.1')).toBe('private');
    expect(classifyAddress('198.51.100.7')).toBe('private');
    expect(classifyAddress(PUBLIC_V4)).toBe('public');
  });

  it('classifies every spelling of IPv6 loopback and private space', () => {
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('::ffff:7f00:1')).toBe('loopback');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
    expect(classifyAddress('::ffff:a00:1')).toBe('private');
    expect(classifyAddress('fe80::1')).toBe('private');
    expect(classifyAddress('fd00::1')).toBe('private');
    expect(classifyAddress('fc00::1')).toBe('private');
    expect(classifyAddress('ff02::1')).toBe('private');
    expect(classifyAddress('2001:db8::1')).toBe('private');
    expect(classifyAddress('2002:7f00:1::')).toBe('private');
    expect(classifyAddress('2002:a00:1::')).toBe('private');
    expect(classifyAddress('64:ff9b::a00:1')).toBe('private');
    expect(classifyAddress('::')).toBe('private');
    expect(classifyAddress('not-an-address')).toBe('invalid');
    expect(classifyAddress(PUBLIC_V6)).toBe('public');
  });

  it('treats bracketed and trailing-dot hostnames consistently', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('app.localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('example.com.')).toBe(false);
  });

  it('keeps the AI validator’s historical predicate: loopback is not public', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('the AI provider validator', () => {
  it('refuses metadata, loopback and link-local literals', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/v1',
      'http://[::ffff:127.0.0.1]/v1',
      'http://[::ffff:7f00:1]/v1',
      'http://10.0.0.5/v1',
      'http://[fe80::1]/v1',
    ]) {
      await expect(assertSafeProviderBaseUrl(url, { allowLoopback: false }), url).rejects.toThrow();
    }
  });

  it('allows a public literal and an opted-in loopback provider', async () => {
    await expect(assertSafeProviderBaseUrl(`http://${PUBLIC_V4}/v1`, { allowLoopback: false })).resolves.toMatchObject({
      loopback: false,
    });
    await expect(assertSafeProviderBaseUrl('http://127.0.0.1:11434', { allowLoopback: true })).resolves.toMatchObject({
      loopback: true,
    });
  });
});

describe('the voice media allowlist (G86)', () => {
  it('refuses every fetch while the allowlist is empty', async () => {
    await expect(
      assertSafeMediaUrl(`https://${PUBLIC_V4}/recording.wav`, { allowedHosts: [], allowLoopback: false }),
    ).rejects.toThrow(/No media hosts are allowlisted/);
  });

  it('refuses a host outside the allowlist and plain http', async () => {
    await expect(
      assertSafeMediaUrl(`https://${PUBLIC_V4}/recording.wav`, { allowedHosts: ['media.example'], allowLoopback: false }),
    ).rejects.toThrow(/not on the configured media allowlist/);
    await expect(
      assertSafeMediaUrl(`http://${PUBLIC_V4}/recording.wav`, { allowedHosts: [PUBLIC_V4], allowLoopback: false }),
    ).rejects.toThrow(/must use https/);
  });

  it('accepts an allowlisted public host and still refuses a loopback one', async () => {
    await expect(
      assertSafeMediaUrl(`https://${PUBLIC_V4}/recording.wav`, { allowedHosts: [PUBLIC_V4], allowLoopback: false }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeMediaUrl('https://[::1]/recording.wav', { allowedHosts: ['::1'], allowLoopback: false }),
    ).rejects.toThrow();
  });
});

describe('the outbound webhook validator', () => {
  it('refuses bracketed IPv6 loopback, mapped private space and metadata', async () => {
    for (const url of [
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:7f00:1]/hook',
      'https://[::ffff:10.0.0.1]/hook',
      'https://[fe80::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/computeMetadata/v1',
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow();
    }
  });

  it('requires https and accepts a public address', async () => {
    await expect(assertPublicUrl(`http://${PUBLIC_V4}/hook`)).rejects.toThrow(/https/);
    await expect(assertPublicUrl(`https://${PUBLIC_V4}/hook`)).resolves.toBeInstanceOf(URL);
  });
});

describe('the connector validator', () => {
  it('refuses private, mapped and link-local resolver answers', async () => {
    const cases = [['::ffff:10.0.0.1'], ['::ffff:7f00:1'], ['fe80::1'], ['fd00::1']];
    for (const addresses of cases) {
      await expect(
        assertProviderUrl('https://provider.test/x', { allowLoopback: false, resolve: async () => addresses }),
        addresses.join(','),
      ).rejects.toThrow();
    }
  });

  it('accepts a public resolver answer and enforces the loopback opt-in', async () => {
    await expect(
      assertProviderUrl('https://provider.test/x', { allowLoopback: false, resolve: async () => [PUBLIC_V6] }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertProviderUrl('https://[::1]/x', { allowLoopback: false, resolve: async () => ['::1'] }),
    ).rejects.toThrow(/loopback/);
  });
});
