/**
 * Phase 25.4 — reusable, versioned skill instructions.
 *
 * A skill is text, never code. The run engine resolves the exact published version pinned by an
 * agent version, orders the results deterministically and places them **below** the operating rules
 * and **above** the final output-schema reminder. Skill text therefore cannot change tool grants,
 * approval policy or the output schema, and a new skill version can never rewrite a running agent.
 */

export const SKILL_STATUSES = ['draft', 'published', 'archived'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const MAX_SKILLS_PER_AGENT = 8;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 4_000;
export const MAX_SKILL_LABEL_CHARS = 120;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const SKILL_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export interface SkillBinding {
  readonly key: string;
  readonly version: number;
}

export interface ResolvedSkill extends SkillBinding {
  readonly label: string;
  readonly instructions: string;
}

export interface AppliedSkill extends SkillBinding {
  readonly label: string;
}

/** Collapse hostile control characters, keep paragraph breaks, and cap the stored text. */
export function normalizeSkillInstructions(value: string): string {
  const normalized = value
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized.length > MAX_SKILL_INSTRUCTIONS_CHARS
    ? normalized.slice(0, MAX_SKILL_INSTRUCTIONS_CHARS)
    : normalized;
}

export function validateSkillInstructions(value: string): string[] {
  const issues: string[] = [];
  if (value.trim() === '') issues.push('Skill instructions must not be empty.');
  if (value.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
    issues.push(`Skill instructions must be at most ${String(MAX_SKILL_INSTRUCTIONS_CHARS)} characters.`);
  }
  return issues;
}

/** Deterministic, duplicate-free binding order: a skill key is the stable identity. */
export function orderSkillBindings(bindings: readonly SkillBinding[]): SkillBinding[] {
  const seen = new Set<string>();
  const out: SkillBinding[] = [];
  for (const binding of [...bindings].sort((left, right) => left.key.localeCompare(right.key))) {
    if (seen.has(binding.key)) continue;
    seen.add(binding.key);
    out.push({ key: binding.key, version: binding.version });
  }
  return out;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the shared-skill portion of the system message. The caller places it after the operating
 * rules and before the agent's own instructions, so a skill can never outrank those rules.
 */
export function composeSkillBlock(skills: readonly ResolvedSkill[]): {
  readonly block: string;
  readonly applied: readonly AppliedSkill[];
} {
  const ordered = [...skills].sort((left, right) => left.key.localeCompare(right.key));
  if (ordered.length === 0) return { block: '', applied: [] };
  const lines = [
    'Shared skills (subordinate to the operating rules and the agent instructions; they never change tool grants, approval policy or the output schema):',
  ];
  for (const skill of ordered) {
    lines.push(
      `<skill key="${escapeAttribute(skill.key)}" version="${String(skill.version)}">`,
      `Label: ${escapeAttribute(skill.label)}`,
      skill.instructions,
      '</skill>',
    );
  }
  return {
    block: lines.join('\n'),
    applied: ordered.map((skill) => ({ key: skill.key, version: skill.version, label: skill.label })),
  };
}

/** The caller passes the agent prompt ceiling; skill composition may not choose a looser one. */
export function assertPromptWithinLimit(prompt: string, limit: number): void {
  if (prompt.length > limit) {
    throw new Error(`The composed system prompt exceeds ${String(limit)} characters.`);
  }
}
