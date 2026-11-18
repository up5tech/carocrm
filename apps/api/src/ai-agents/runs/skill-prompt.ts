/**
 * Phase 25.4 — run-time skill prompt composition, kept out of the already-large executor.
 *
 * The agent version pins exact skill versions. Resolution is therefore immutable: a later draft of
 * the same key cannot rewrite a running agent. Any failure here fails the run closed before a model
 * call, because a missing skill or an oversized prompt would otherwise silently change behaviour.
 */

import type { AIAgentActorContext } from '../ai-agent-actor.js';
import { systemPrompt } from '../ai-agent-actor.js';
import type { AgentConfig } from '../ai-agent-config.js';
import { MAX_SYSTEM_PROMPT_CHARS } from '../ai-agent-config.js';
import { assertPromptWithinLimit, type SkillBinding } from '../ai-agent-skills.js';
import type { AIAgentSkillService } from '../ai-agent-skills.service.js';
import type { RunStatus } from '../ai-agents-module.js';

export interface SkillPromptHooks {
  readonly appendEvent: (
    category: string,
    type: string,
    summary: string,
    payload: Record<string, unknown>,
    visibility: 'user' | 'operator' | 'admin',
  ) => Promise<void>;
  readonly finish: (
    status: RunStatus,
    options: {
      readonly failureCategory?: string | undefined;
      readonly failureMessage?: string | undefined;
    },
  ) => Promise<void>;
}

export async function composeRunSystemPrompt(
  skills: AIAgentSkillService,
  bindings: readonly SkillBinding[],
  agentName: string,
  config: AgentConfig,
  actor: AIAgentActorContext | undefined,
  hooks: SkillPromptHooks,
): Promise<string | undefined> {
  try {
    const resolved = await skills.resolvePinned(bindings);
    const prompt = systemPrompt(agentName, config, actor, resolved.skills);
    assertPromptWithinLimit(prompt, MAX_SYSTEM_PROMPT_CHARS);
    if (resolved.applied.length > 0) {
      await hooks.appendEvent(
        'policy',
        'skill.applied',
        `Applied ${String(resolved.applied.length)} shared skill version(s): ` +
          `${resolved.applied.map((skill) => `${skill.key}@${String(skill.version)}`).join(', ')}.`,
        { skills: resolved.applied },
        'user',
      );
    }
    return prompt;
  } catch (error) {
    await hooks.finish('blocked_by_policy', {
      failureCategory: 'skill_unavailable',
      failureMessage: error instanceof Error ? error.message : 'The pinned skills could not be resolved.',
    });
    return undefined;
  }
}
