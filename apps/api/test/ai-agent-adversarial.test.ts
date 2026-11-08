import { describe, expect, it } from 'vitest';

import { assertSafeProviderBaseUrl, isPrivateAddress } from '../src/ai-agents/ai-provider-url.js';

/**
 * Phase 19-AI.27 — the named adversarial suite for AI Agents (§11.2/§17.2/§17.3).
 *
 * One place to find the security-boundary evidence, without duplicating coverage:
 *
 *  - **SSRF / provider URL safety** — the `provider URL safety` describe below, moved verbatim from
 *    `ai-providers.test.ts` (which keeps the adapter-contract tests).
 *  - **Prompt injection** — `ai-agent-runs.test.ts` → `describe('adversarial prompt injection')`:
 *    ungranted tool, invented tool name, unknown argument fields, indirect injection through
 *    retrieved CRM data.
 *  - **Cross-user / cross-scope** — `ai-agent-runs.test.ts` (private agent hidden, owner-scoped
 *    memory, per-user admission cap), `crm-chat-intelligence-tools.test.ts` (own-scope read cannot
 *    reach another user's records through the intelligence tools and, below, the core read tools),
 *    and `phase22-security-injection.test.ts` (SQLi payloads, non-disclosure).
 *  - **MCP direct path** — `ai-agent-mcp-idempotency.test.ts`: replayed writes cannot duplicate an
 *    effect and approval-class tools stay refused.
 *
 * The `high_impact` effect class is reserved and intentionally has no registered tool; this suite
 * must not register a fake one to inflate coverage (19-AI.27).
 */

describe('provider URL safety', () => {
  it('allows http and https and rejects credentials and cloud metadata', async () => {
    await expect(assertSafeProviderBaseUrl('http://example.com', { allowLoopback: false })).resolves.toBeDefined();
    await expect(assertSafeProviderBaseUrl('https://example.com', { allowLoopback: false })).resolves.toBeDefined();
    await expect(assertSafeProviderBaseUrl('https://user:pass@example.com', { allowLoopback: false })).rejects.toThrow(
      /credentials/,
    );    await expect(
      assertSafeProviderBaseUrl('https://169.254.169.254/latest', { allowLoopback: false }),
    ).rejects.toThrow(/metadata/);
  });

  it('rejects loopback unless the connection explicitly allows it', async () => {
    await expect(assertSafeProviderBaseUrl('https://127.0.0.1', { allowLoopback: false })).rejects.toThrow(/loopback/);
    const allowed = await assertSafeProviderBaseUrl('https://127.0.0.1:11434', { allowLoopback: true });
    expect(allowed.loopback).toBe(true);
  });

  it('classifies private and public addresses', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

