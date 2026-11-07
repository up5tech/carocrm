import { describe, expect, it } from 'vitest';

import { parseAgentConfig } from '../src/ai-agents/ai-agent-config.js';

/**
 * Legacy draft shape (pre-typed-schema): `{ model: { provider, model }, instructions, tools }`.
 * Rows written in that shape still live in `ai_agents.draft_config`; the strict schema used to
 * reject them with "Unrecognized keys", surfacing as a bare "Validation failed" on
 * validate/publish. `parseAgentConfig` normalises the legacy keys instead, while still
 * rejecting genuinely unknown keys.
 */
describe('parseAgentConfig legacy shape', () => {
  const legacySalesCopilot = {
    model: { model: 'gpt-4o-mini', provider: 'openai' },
    tools: [],
    instructions:
      'You help account executives summarize opportunities, draft follow-up emails and prepare for customer calls. Never invent customer facts.',
  };

  it('normalises the legacy Sales Copilot draft into the current shape', () => {
    const parsed = parseAgentConfig(legacySalesCopilot);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.provider).toEqual({ key: 'openai', model: 'gpt-4o-mini', fallbackModels: [] });
    expect(parsed.config.prompt.system).toContain('Never invent customer facts.');
    expect(parsed.config.tools).toEqual([]);
    expect(parsed.config.limits.maxSteps).toBe(6);
  });

  it('lets the current shape win when both shapes are present', () => {
    const parsed = parseAgentConfig({
      ...legacySalesCopilot,
      provider: { key: 'freellm', model: 'auto' },
      prompt: { system: 'Current instructions.' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.provider?.key).toBe('freellm');
    expect(parsed.config.prompt.system).toBe('Current instructions.');
  });

  it('still rejects genuinely unknown keys', () => {
    const parsed = parseAgentConfig({ ...legacySalesCopilot, totallyUnknown: true });
    expect(parsed.ok).toBe(false);
  });

  it('still rejects a legacy model block without a model name', () => {
    const parsed = parseAgentConfig({ model: { provider: 'openai' }, tools: [], instructions: 'x' });
    expect(parsed.ok).toBe(false);
  });
});

describe('parseAgentConfig tool ceiling', () => {
  const grant = (n: number) => ({ tools: Array.from({ length: n }, (_, i) => ({ key: `tool_${String(i)}` })) });

  it('accepts the full 25-key catalogue (24 chat tools + omnichannel.send_message)', () => {
    expect(parseAgentConfig(grant(25)).ok).toBe(true);
  });

  it('accepts up to the raised ceiling of 32', () => {
    expect(parseAgentConfig(grant(32)).ok).toBe(true);
  });

  it('rejects more than the ceiling', () => {
    const parsed = parseAgentConfig(grant(33));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.some((issue) => issue.path === 'tools')).toBe(true);
  });
});
