/**
 * Shared run types and pure helpers for the AI agent run engine (19-AI.25 split).
 * Extracted verbatim from `ai-agent-runs.service.ts`; no behaviour change.
 */

import { createHash } from 'node:crypto';

import { ValidationError } from '@carocrm/core/errors/index.js';

import type { MetadataStoreService } from '../../metadata/metadata-store.service.js';
import type { RunStatus, RunTrigger } from '../ai-agents-module.js';

export interface RunRecordRef {
  readonly entity: string;
  readonly id: string;
}

export interface RunCreateInput {
  readonly input?: {
    readonly text?: string | undefined;
    readonly record?: RunRecordRef | undefined;
    /**
     * 19-AI.28 — every record the run was started alongside (CRM Chat context refs). Additive:
     * `record` stays valid for single-reference callers; `records` carries the full list and is
     * what the prompt renders. Ignored — and refused — for record-mode agents.
     */
    readonly records?: readonly RunRecordRef[] | undefined;
  } | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly trigger?: RunTrigger | undefined;
  /** Continue an existing owner-scoped thread of the same agent (conversation memory only). */
  readonly conversationId?: string | undefined;
}

export interface AIAgentRunView {
  readonly id: string;
  readonly agentId: string;
  readonly agentKey: string;
  readonly agentName: string;
  readonly agentVersion: number;
  readonly agentVersionId: string;
  readonly status: RunStatus;
  readonly trigger: RunTrigger;
  readonly initiatedByUserId: string | null;
  readonly input: { readonly text: string | null; readonly recordEntity: string | null; readonly recordId: string | null };
  readonly result: unknown;
  readonly failureCategory: string | null;
  readonly failureMessage: string | null;
  readonly cancelRequested: boolean;
  readonly conversationId: string | null;
  readonly counters: {
    readonly steps: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number;
  };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface AIAgentRunEventView {
  readonly id: string;
  readonly seq: number;
  readonly category: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly summary: string;
  readonly payload: unknown;
  readonly visibility: string;
  readonly createdAt: string;
}

export interface RunListQuery {
  readonly offset?: number | undefined;
  readonly maxSize?: number | undefined;
  readonly status?: RunStatus | undefined;
  readonly agentId?: string | undefined;
  readonly scope?: 'mine' | 'all' | undefined;
}

export interface RunExecutionResult {
  readonly run: AIAgentRunView;
  readonly claimed: boolean;
  readonly waitingForApproval: boolean;
}

export function summaryFieldNames(metadata: MetadataStoreService, entity: string): string[] {
  const fields = metadata.registry.getFields(entity);
  const skip = new Set(['createdById', 'modifiedById', 'deletedAt', 'teams']);
  const names = ['name', 'description'];
  for (const [name, definition] of Object.entries(fields)) {
    if (names.length >= 12) break;
    if (skip.has(name) || names.includes(name)) continue;
    if (definition.inDetail === true) names.push(name);
  }
  return names.filter((name) => fields[name] !== undefined);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function parseRawArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (raw.trim() === '') return { ok: true, value: {} };
  if (Buffer.byteLength(raw, 'utf8') > 16_384) return { ok: false, message: 'The arguments exceeded 16 KiB.' };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, message: 'The arguments were not valid JSON.' };
  }
}

/** 19-AI.23 — exported so the MCP direct-call door hashes arguments identically. */
export function hashArguments(args: unknown): string {
  return hashText(stableJson(args));
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((entry) => canonical(entry));
    if (typeof input === 'object' && input !== null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        out[key] = canonical((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export function boundArguments(args: unknown): unknown {
  const json = safeJson(args, 8_192);
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { truncated: true };
  }
}

export function boundResult(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return { value, truncated: false };
  const text = safeJson(value, maxBytes - 200);
  return { value: { truncated: true, excerpt: text }, truncated: true };
}

export function safeJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = '"[unserializable]"';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function escapeAttribute(value: string): string {
  return value.replace(/["<>&]/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

export function isUniqueViolation(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '23505';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ValidationError(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


