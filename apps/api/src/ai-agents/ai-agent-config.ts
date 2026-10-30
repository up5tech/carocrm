import { createHash } from 'node:crypto';

import { z } from 'zod';

import { DATA_CLASSES, EFFECT_CLASSES } from './ai-agents-module.js';

/**
 * Phase 19-AI.5 — the typed agent configuration
 * (PLAN_Phase_19_AI_Agents.md §5.1, §5.3, §20 `19-AI.5`).
 *
 * An agent's draft is free-form JSON in the database but **never** free-form policy: every value a
 * run depends on is parsed by this schema, bounded, and given a safe default. A draft that fails
 * here cannot be published, and the values a published version captured are the values the runtime
 * reads — nothing is re-read from the mutable definition.
 *
 * The output schema is deliberately a small, explicit subset of JSON Schema instead of the whole
 * specification: a bounded object/array/scalar tree is something this module can validate itself
 * without a second schema library, and it keeps a model's structured answer inside a known shape.
 */

export const MAX_SYSTEM_PROMPT_CHARS = 12_000;
export const MAX_CONFIG_BYTES = 32_768;
export const MAX_TOOLS = 8;
export const MAX_JSON_SCHEMA_DEPTH = 4;
export const MAX_JSON_SCHEMA_NODES = 100;

/** Limits an administrator sets globally; a published agent may not exceed them (§8.3). */
export const HARD_LIMIT_CEILINGS = {
  maxSteps: 16,
  maxModelCalls: 16,
  maxToolCalls: 32,
  maxTokens: 200_000,
  maxCostUsd: 100,
  maxElapsedSeconds: 600,
  maxRetries: 5,
  maxOutputTokens: 8_192,
} as const;

export const DEFAULT_AGENT_LIMITS = {
  maxSteps: 6,
  maxModelCalls: 6,
  maxToolCalls: 4,
  maxTokens: 12_000,
  maxCostUsd: 0.5,
  maxElapsedSeconds: 60,
  maxRetries: 1,
  maxOutputTokens: 1_024,
  temperature: 0.2,
} as const;

export type BoundedJsonSchema =
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, BoundedJsonSchema>>;
      readonly required?: readonly string[] | undefined;
      readonly additionalProperties: false;
    }
  | { readonly type: 'array'; readonly items: BoundedJsonSchema; readonly maxItems?: number | undefined }
  | { readonly type: 'string'; readonly enum?: readonly string[] | undefined; readonly maxLength?: number | undefined }
  | {
      readonly type: 'number' | 'integer';
      readonly minimum?: number | undefined;
      readonly maximum?: number | undefined;
    }
  | { readonly type: 'boolean' };

const BoundedJsonSchemaSchema: z.ZodType<BoundedJsonSchema> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string().trim().min(1).max(64), BoundedJsonSchemaSchema),
        required: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
        additionalProperties: z.literal(false),
      })
      .strict(),
    z
      .object({
        type: z.literal('array'),
        items: BoundedJsonSchemaSchema,
        maxItems: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('string'),
        enum: z.array(z.string().max(200)).min(1).max(50).optional(),
        maxLength: z.number().int().min(1).max(20_000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(['number', 'integer']),
        minimum: z.number().min(-1_000_000).max(1_000_000).optional(),
        maximum: z.number().min(-1_000_000).max(1_000_000).optional(),
      })
      .strict(),
    z.object({ type: z.literal('boolean') }).strict(),
  ]),
);

const ToolGrantSchema = z
  .object({
    /** The registered tool key. A key no registry knows is refused at publish time. */
    key: z.string().trim().min(1).max(120),
    /** Per-grant narrowing; the tool validator still enforces its own hard bounds. */
    constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const AgentLimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(HARD_LIMIT_CEILINGS.maxSteps).default(DEFAULT_AGENT_LIMITS.maxSteps),
    maxModelCalls: z.number().int().min(1).max(HARD_LIMIT_CEILINGS.maxModelCalls).default(DEFAULT_AGENT_LIMITS.maxModelCalls),
    maxToolCalls: z.number().int().min(0).max(HARD_LIMIT_CEILINGS.maxToolCalls).default(DEFAULT_AGENT_LIMITS.maxToolCalls),
    maxTokens: z.number().int().min(1).max(HARD_LIMIT_CEILINGS.maxTokens).default(DEFAULT_AGENT_LIMITS.maxTokens),
    maxCostUsd: z.number().min(0).max(HARD_LIMIT_CEILINGS.maxCostUsd).default(DEFAULT_AGENT_LIMITS.maxCostUsd),
    maxElapsedSeconds: z
      .number()
      .int()
      .min(1)
      .max(HARD_LIMIT_CEILINGS.maxElapsedSeconds)
      .default(DEFAULT_AGENT_LIMITS.maxElapsedSeconds),
    maxRetries: z.number().int().min(0).max(HARD_LIMIT_CEILINGS.maxRetries).default(DEFAULT_AGENT_LIMITS.maxRetries),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(HARD_LIMIT_CEILINGS.maxOutputTokens)
      .default(DEFAULT_AGENT_LIMITS.maxOutputTokens),
    temperature: z.number().min(0).max(2).default(DEFAULT_AGENT_LIMITS.temperature),
  })
  .strict()
  .prefault({});

const AgentOutputSchema = z
  .object({
    mode: z.enum(['text', 'json']).default('text'),
    schema: BoundedJsonSchemaSchema.optional(),
  })
  .strict()
  .prefault({});

export const AgentProviderSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(200),
    /** Same data class only; the gateway refuses a model that cannot serve it (§6.3). */
    fallbackModels: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
  })
  .strict();

export const AgentConfigSchema = z
  .object({
    /**
     * Optional while the agent is a draft, so an administrator can write a prompt before choosing a
     * connection. Publication refuses a draft without one (§5.3).
     */
    provider: AgentProviderSchema.optional(),
    dataClass: z.enum(DATA_CLASSES).default('internal'),
    prompt: z
      .object({
        /** Empty is allowed in a draft; publication requires a non-empty instruction. */
        system: z.string().trim().max(MAX_SYSTEM_PROMPT_CHARS).default(''),
        /** Shown to the SPA and used as the run input placeholder; never sent as a system message. */
        inputHint: z.string().trim().max(500).optional(),
      })
      .strict()
      .prefault({}),
    input: z
      .object({
        mode: z.enum(['text', 'record']).default('text'),
        /** Required when `mode` is `record`; validated against registered entities. */
        entity: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .prefault({}),
    tools: z.array(ToolGrantSchema).max(MAX_TOOLS).default([]),
    limits: AgentLimitsSchema,
    output: AgentOutputSchema,
    /**
     * Memory is opt-in (§10.1). `none` isolates every run; `conversation` keeps one owner-scoped
     * thread; `checkpoint` stores only the resumable state of the same run. Long-term curated facts
     * are never inferred automatically.
     */
    memory: z
      .object({
        mode: z.enum(['none', 'conversation', 'checkpoint']).default('none'),
        /** How many prior messages are put in the prompt; older ones become a rolling summary. */
        maxMessages: z.number().int().min(2).max(40).default(12),
        /** Retention the conversation inherits; the instance setting is the ceiling. */
        retentionDays: z.number().int().min(1).max(3650).default(30),
      })
      .strict()
      .prefault({}),
    triggers: z
      .object({
        manual: z.boolean().default(true),
        record: z.boolean().default(false),
        event: z.boolean().default(false),
        schedule: z.boolean().default(false),
        integration: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    approval: z
      .object({
        requireFor: z.array(z.enum(EFFECT_CLASSES)).default(['material_write', 'high_impact']),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.input.mode === 'record' && (config.input.entity ?? '') === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input', 'entity'],
        message: 'A record-context agent must name the entity it reads.',
      });
    }
    if (config.output.mode === 'json' && config.output.schema === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'schema'],
        message: 'A structured-output agent must declare its output schema.',
      });
    }
    if (config.output.mode === 'text' && config.output.schema !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['output', 'schema'],
        message: 'An output schema is only meaningful when output.mode is "json".',
      });
    }
    if (config.limits.maxModelCalls > config.limits.maxSteps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limits', 'maxModelCalls'],
        message: 'maxModelCalls cannot exceed maxSteps: a model call is a step.',
      });
    }
    const unique = new Set(config.tools.map((tool) => tool.key));
    if (unique.size !== config.tools.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools'],
        message: 'A tool may be granted only once.',
      });
    }
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentProviderConfig = z.infer<typeof AgentProviderSchema>;

/** A config that passed publication validation: provider and prompt are present. */
export type PublishedAgentConfig = AgentConfig & {
  readonly provider: AgentProviderConfig;
};

/** The shape a fresh draft starts from; deliberately provider-less until an administrator chooses. */
export function blankAgentConfig(): AgentConfig {
  return {
    dataClass: 'internal',
    prompt: { system: '' },
    input: { mode: 'text' },
    tools: [],
    limits: { ...DEFAULT_AGENT_LIMITS },
    output: { mode: 'text' },
    memory: { mode: 'none', maxMessages: 12, retentionDays: 30 },
    triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

/** The §5.3 checks the schema alone cannot express; a draft may fail these and still be saved. */
export function publicationConfigIssues(config: AgentConfig): AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  if (config.provider === undefined) {
    issues.push({ path: 'provider', message: 'Choose an enabled provider connection and model.' });
  }
  if (config.prompt.system.trim() === '') {
    issues.push({ path: 'prompt.system', message: 'The agent needs system instructions before it can be published.' });
  }
  return issues;
}

export interface AgentConfigIssue {
  readonly path: string;
  readonly message: string;
}

/** Parse a draft or a stored snapshot. The caller decides whether an issue is fatal. */
export function parseAgentConfig(
  value: unknown,
): { ok: true; config: AgentConfig } | { ok: false; issues: AgentConfigIssue[] } {
  const parsed = AgentConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const schemaIssues =
    parsed.data.output.schema === undefined ? [] : checkBoundedJsonSchema(parsed.data.output.schema);
  if (schemaIssues.length > 0) return { ok: false, issues: schemaIssues };
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
  if (bytes > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      issues: [{ path: '(config)', message: `The configuration exceeds ${String(MAX_CONFIG_BYTES)} bytes.` }],
    };
  }
  return { ok: true, config: parsed.data };
}

/** Structural checks JSON Schema parsing alone cannot express (depth, fan-out, total size). */
export function checkBoundedJsonSchema(schema: BoundedJsonSchema): AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  let nodes = 0;

  const walk = (node: BoundedJsonSchema, path: string, depth: number): void => {
    nodes += 1;
    if (depth > MAX_JSON_SCHEMA_DEPTH) {
      issues.push({ path, message: `Nested deeper than ${String(MAX_JSON_SCHEMA_DEPTH)} levels.` });
      return;
    }
    if (nodes > MAX_JSON_SCHEMA_NODES) {
      if (nodes === MAX_JSON_SCHEMA_NODES + 1) {
        issues.push({ path, message: `The schema has more than ${String(MAX_JSON_SCHEMA_NODES)} nodes.` });
      }
      return;
    }
    if (node.type === 'object') {
      const keys = Object.keys(node.properties);
      if (keys.length === 0) issues.push({ path, message: 'An object schema needs at least one property.' });
      if (keys.length > 20) issues.push({ path, message: 'An object schema may declare at most 20 properties.' });
      for (const required of node.required ?? []) {
        if (!keys.includes(required)) {
          issues.push({ path: `${path}.required`, message: `"${required}" is not a declared property.` });
        }
      }
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}.${key}`, depth + 1);
    } else if (node.type === 'array') {
      walk(node.items, `${path}[]`, depth + 1);
    }
  };

  walk(schema, 'output.schema', 0);
  return issues;
}

/**
 * Validate a model's structured answer against the bounded schema. Returns human-readable issues
 * rather than throwing, so the run engine can decide between a repair turn and a failure.
 */
export function validateBoundedJsonSchema(value: unknown, schema: BoundedJsonSchema): string[] {
  const issues: string[] = [];
  const walk = (node: BoundedJsonSchema, current: unknown, path: string): void => {
    switch (node.type) {
      case 'object': {
        if (typeof current !== 'object' || current === null || Array.isArray(current)) {
          issues.push(`${path} must be an object.`);
          return;
        }
        const record = current as Record<string, unknown>;
        for (const [key, child] of Object.entries(node.properties)) {
          if (record[key] === undefined) {
            if ((node.required ?? []).includes(key)) issues.push(`${path}.${key} is required.`);
            continue;
          }
          walk(child, record[key], `${path}.${key}`);
        }
        for (const key of Object.keys(record)) {
          if (!(key in node.properties)) issues.push(`${path}.${key} is not allowed.`);
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(current)) {
          issues.push(`${path} must be an array.`);
          return;
        }
        if (node.maxItems !== undefined && current.length > node.maxItems) {
          issues.push(`${path} has more than ${String(node.maxItems)} items.`);
        }
        current.forEach((entry, index) => walk(node.items, entry, `${path}[${String(index)}]`));
        return;
      }
      case 'string': {
        if (typeof current !== 'string') {
          issues.push(`${path} must be a string.`);
          return;
        }
        if (node.enum !== undefined && !node.enum.includes(current)) {
          issues.push(`${path} must be one of: ${node.enum.join(', ')}.`);
        }
        if (node.maxLength !== undefined && current.length > node.maxLength) {
          issues.push(`${path} is longer than ${String(node.maxLength)} characters.`);
        }
        return;
      }
      case 'number':
      case 'integer': {
        if (typeof current !== 'number' || !Number.isFinite(current)) {
          issues.push(`${path} must be a number.`);
          return;
        }
        if (node.type === 'integer' && !Number.isInteger(current)) {
          issues.push(`${path} must be an integer.`);
        }
        if (node.minimum !== undefined && current < node.minimum) {
          issues.push(`${path} must be at least ${String(node.minimum)}.`);
        }
        if (node.maximum !== undefined && current > node.maximum) {
          issues.push(`${path} must be at most ${String(node.maximum)}.`);
        }
        return;
      }
      case 'boolean': {
        if (typeof current !== 'boolean') issues.push(`${path} must be a boolean.`);
        return;
      }
      default: {
        const exhaustive: never = node;
        issues.push(`${path} uses an unsupported schema node ${String(exhaustive)}.`);
      }
    }
  };
  walk(schema, value, '$');
  return issues;
}

/** Deterministic JSON: object keys sorted at every level, so a checksum is stable across writers. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/** SHA-256 of the canonical configuration; stored on the version and verified before a run. */
export function agentConfigChecksum(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

/** The system prompt is versioned with the rest of the configuration, never read live. */
export function agentSystemPrompt(config: AgentConfig): string {
  return config.prompt.system;
}

/** A short description of the expected structured answer for the model's instruction block. */
export function describeOutputSchema(schema: BoundedJsonSchema): string {
  const lines: string[] = [];
  const walk = (node: BoundedJsonSchema, path: string, indent: string): void => {
    switch (node.type) {
      case 'object': {
        const required = new Set(node.required ?? []);
        for (const [key, child] of Object.entries(node.properties)) {
          lines.push(`${indent}${key}${required.has(key) ? '' : '?'}: ${child.type}`);
          if (child.type === 'object' || child.type === 'array') walk(child, `${path}.${key}`, `${indent}  `);
        }
        return;
      }
      case 'array': {
        lines.push(`${indent}items: ${node.items.type}`);
        walk(node.items, `${path}[]`, `${indent}  `);
        return;
      }
      case 'string': {
        lines.push(`${indent}one of ${(node.enum ?? []).join(' | ')}`);
        return;
      }
      case 'number':
      case 'integer':
      case 'boolean':
        return;
      default:
        return;
    }
  };
  walk(schema, '$', '  ');
  return lines.join('\n');
}
