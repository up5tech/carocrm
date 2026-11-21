import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AIToolRegistry } from '../src/ai-agents/ai-agent-tools.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 25.9 — the chat promises the developer can keep
 * (`plans/PLAN_Phase_25_AI_Capability_Parity.md` §15, task 4).
 *
 * A suggestion chip is a promise the assistant makes on the deployment's behalf: "ask this and the
 * answer will come from this tool". The chip table in the SPA and the tool registry in the API are
 * two files in two projects, so nothing but a test keeps them in step — and a chip that names a tool
 * the registry does not have is a promise the product cannot keep.
 *
 * The same reasoning applies to the skill picker in the agent editor: it may only offer **published**
 * skill versions, because the server refuses to publish an agent version that binds a draft.
 *
 * The chip table is read as source, the same way `crm-chat-contract.test.ts` reads the prose
 * contract: the assertion is about the shipped declaration, not about a copy of it.
 */

const SUGGESTIONS_SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  'web',
  'src',
  'pages',
  'crm-chat',
  'CRMChatSuggestions.tsx',
);
const AGENT_EDITOR_SOURCE = join(
  import.meta.dirname,
  '..',
  '..',
  'web',
  'src',
  'pages',
  'ai-agents',
  'AIAgentsAgentsTab.tsx',
);

let ctx: ApiContext;

beforeAll(async () => {
  ctx = await bootApi();
});

afterAll(async () => {
  await shutdownApi();
});

describe('the chat promises the deployment can keep (25.9)', () => {
  it('never names a tool the registry does not have', () => {
    const source = readFileSync(SUGGESTIONS_SOURCE, 'utf8');
    const required = [...source.matchAll(/requiresTool:\s*'([^']+)'/g)].map((match) => match[1] ?? '');

    expect(required.length).toBeGreaterThan(0);
    const registry = ctx.app.get(AIToolRegistry);
    const known = new Set(registry.list().map((tool) => tool.key));
    for (const tool of required) {
      expect(known.has(tool), `the chip table promises "${tool}", which the registry does not have`).toBe(true);
    }
  });

  it('offers only published skills in the agent editor picker', () => {
    // The server refuses to publish an agent version that binds a draft skill, so the picker may
    // not offer one: a chip that cannot be kept is the same defect as a missing tool.
    const source = readFileSync(AGENT_EDITOR_SOURCE, 'utf8');
    expect(source).toContain("status: 'published'");
  });
});
