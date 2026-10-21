import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';

import { CRMChatController } from '../src/crm-chat/crm-chat.controller.js';
import {
  CRM_CHAT_BLOCKED_CAPABILITIES,
  CRM_CHAT_CONTRACT_VERSION,
  CRM_CHAT_ERROR_CODES,
  CRM_CHAT_ROUTES,
  CRM_CHAT_STREAM_EVENTS,
} from '../src/crm-chat/crm-chat-contract.js';
import { CRM_CHAT_CAPABILITIES, CRM_CHAT_FEATURES } from '../src/crm-chat/crm-chat-module.js';

/**
 * Phase 19-CHAT.1/19-CHAT.2 — the contract cannot drift from the code or from the document
 * (`PLAN_Phase_19_CRM_Chat.md` §17; deliverable "Versioned TypeScript/OpenAPI contract proposal").
 *
 * Three artifacts describe the same surface: the prose contract
 * (`docs/architecture/crm-chat-contract.md`), the route table in `crm-chat-contract.ts`, and the
 * controller that actually serves it. This suite compares all three, so adding a route in one place
 * fails a test instead of shipping an undocumented endpoint. It needs no database and no HTTP client.
 */

const CONTRACT_DOC = join(import.meta.dirname, '..', '..', '..', 'docs', 'architecture', 'crm-chat-contract.md');
const doc = readFileSync(CONTRACT_DOC, 'utf8');

const METHOD_NAMES: Record<number, string> = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH' };

/** Every route Nest actually mapped for `CRMChatController`, as `METHOD path` below the prefix. */
function servedRoutes(): string[] {
  const prefix = (Reflect.getMetadata(PATH_METADATA, CRMChatController) as string | undefined) ?? '';
  expect(prefix).toBe('api/v1/CRMChat');

  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(CRMChatController.prototype)) {
    if (name === 'constructor') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, CRMChatController.prototype[name] as object) as number | undefined;
    if (method === undefined) continue;
    const path = (Reflect.getMetadata(PATH_METADATA, CRMChatController.prototype[name] as object) as string | undefined) ?? '';
    const verb = METHOD_NAMES[method];
    expect(verb, `Unknown request method ${String(method)} on ${name}`).toBeDefined();
    out.push(`${verb ?? '?'} ${path}`);
  }
  return out.sort();
}

describe('CRMChat contract (19-CHAT.1)', () => {
  it('declares exactly the routes the controller serves, and nothing else', () => {
    const declared = CRM_CHAT_ROUTES.filter((route) => route.implemented)
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(declared).toEqual(servedRoutes());
  });

  it('keeps every route that is specified but not yet delivered inside a known phase', () => {
    // A route may be specified before its phase lands. When that happens the phase has to be one
    // the plan knows, so an undelivered route is always traceable to the work that owes it.
    const known = [
      '19-CHAT.0',
      '19-CHAT.1',
      '19-CHAT.2',
      '19-CHAT.3',
      '19-CHAT.4',
      '19-CHAT.5',
      '19-CHAT.6',
      '19-CHAT.7',
      '19-CHAT.8',
      '19-CHAT.9',
      '19-CHAT.10',
      '19-CHAT.11',
      '19-CHAT.12',
      '19-CHAT.13',
      '19-CHAT.14',
      '19-CHAT.15',
      '19-CHAT.16',
      '19-CHAT.17',
      '19-CHAT.18',
      '19-CHAT.19',
    ];
    for (const route of CRM_CHAT_ROUTES.filter((entry) => !entry.implemented)) {
      expect(known, `route ${route.method} ${route.path} names an unknown phase`).toContain(route.phase);
    }
  });

  it('documents every declared route in the prose contract', () => {
    for (const route of CRM_CHAT_ROUTES) {
      expect(doc, `route ${route.method} ${route.path} is not in the contract document`).toContain(`\`${route.path}\``);
    }
  });

  it('gates every route with a real capability and a real feature flag', () => {
    const capabilities = new Set<string>([...CRM_CHAT_CAPABILITIES.map((entry) => entry.key), 'none']);
    const features = new Set<string>(CRM_CHAT_FEATURES.map((entry) => entry.key));
    for (const route of CRM_CHAT_ROUTES) {
      expect(capabilities, `${route.path} names an unknown capability`).toContain(route.capability);
      if (route.feature !== null) {
        expect(features, `${route.path} names an unknown feature`).toContain(route.feature);
      }
    }
  });

  it('keeps the foundation routes reachable while the workspace flag is off', () => {
    // `capabilities` and `settings` are the two endpoints that must answer a disabled module: one
    // explains it, the other turns it back on. If either gains the flag, disabling becomes a trap.
    const mustAnswerWhileDisabled = CRM_CHAT_ROUTES.filter(
      (route) => route.implemented && (route.path === 'action/capabilities' || route.path.startsWith('action/settings')),
    );
    expect(mustAnswerWhileDisabled.length).toBe(3);
    for (const route of mustAnswerWhileDisabled) expect(route.feature).toBeNull();
  });

  it('keeps error codes unique, classified and documented', () => {
    const codes = CRM_CHAT_ERROR_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of CRM_CHAT_ERROR_CODES) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.meaning.length).toBeGreaterThan(10);
      expect(doc, `${entry.code} is not in the contract document`).toContain(`\`${entry.code}\``);
    }
  });

  it('never declares a streaming delta the provider contract cannot deliver', () => {
    // Audit §5: the provider interface is request/response, so a token-level delta would be a lie.
    expect(CRM_CHAT_STREAM_EVENTS).not.toContain('assistant.delta');
    expect(CRM_CHAT_STREAM_EVENTS).toContain('assistant.message');
    expect(CRM_CHAT_STREAM_EVENTS).toContain('heartbeat');
    expect(new Set(CRM_CHAT_STREAM_EVENTS).size).toBe(CRM_CHAT_STREAM_EVENTS.length);
  });

  it('lists the blocked action classes the plan forbids in every configuration', () => {
    for (const blocked of [
      'bulk-destructive-operations',
      'acl-and-role-changes',
      'credential-management',
      'payments',
      'invoice-issue-or-void',
      'campaign-sends',
      'external-messaging',
    ]) {
      expect(CRM_CHAT_BLOCKED_CAPABILITIES).toContain(blocked);
    }
  });

  it('carries a semver contract version the document agrees with', () => {
    expect(CRM_CHAT_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc).toContain(`**Contract version:** \`${CRM_CHAT_CONTRACT_VERSION}\``);
  });
});
