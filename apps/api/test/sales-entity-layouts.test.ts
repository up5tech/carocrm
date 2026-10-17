import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  documentDescriptor,
  IMPLEMENTED_DOCUMENT_KINDS,
} from '../src/sales/document/descriptors.js';
import { SALES_ENTITY_TYPES } from '../src/sales/sales-records.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 19-S.17 task 1 — the per-entity review, written as an audit that fails when it regresses.
 *
 * The plan asks for "a review of every entity's list, detail, edit, create, search, filter, sorting,
 * pagination, relationship panels and ACL-aware actions". A manual pass over 52 entity definitions
 * would be stale by the next migration, so the invariants that review actually checks are asserted
 * here instead:
 *
 *  - every Sales entity is registered, labelled, and carries typed fields;
 *  - every entity has a list and a detail layout, and **every field a layout names exists** — the
 *    class of bug that ships a blank column or a screen that renders nothing;
 *  - every link and every relation resolves to a registered entity, and a relation's `mappedBy`
 *    resolves to a real field on its target (the `source` → `sourceId` convention included);
 *  - a navigable entity has a `displayField` that exists;
 *  - each document kind's descriptor agrees with the metadata: the `status` enum is exactly the
 *    descriptor's `states`, and the child item entity exists with its parent field;
 *  - **every** entity is ACL-protected: a caller with no permission gets `403` on its list, while an
 *    administrator gets a `200` envelope.
 *
 * Runs against the configured primary database through the booted application (AGENTS.md §3.1). It
 * writes no business records — only the one throwaway user the ACL check needs, removed in `afterAll`.
 */

/**
 * Link targets that are **identity tables, not metadata entities** (`User`, `Team`). The Entity
 * Engine resolves them without a definition, so a link to one is correct even though `GET /Metadata`
 * has no entry for it — the same rule `sales-repository-audit.md` records for the ACL and the
 * assignment fields.
 */
const IDENTITY_LINK_TARGETS: ReadonlySet<string> = new Set(['User', 'Team']);

/**
 * The records a **command** writes, not a form (19-S.11 – 19-S.16). An edit screen for one of them
 * would offer fields the write guard refuses — a reservation's status, a ledger row, an allocation's
 * reversal trail, a period's invoice link — so they keep a list and a detail layout (you must be able
 * to *see* them) and deliberately have no edit layout. The set is asserted exactly, so an entity that
 * loses its edit layout by accident is a failure, and so is one that gains a form nobody may use.
 */
const COMMAND_OWNED_RECORDS: ReadonlySet<string> = new Set([
  'BillCreditAllocation',
  'CreditNoteAllocation',
  'PaymentAllocation',
  'PaymentTransferAllocation',
  'PaymentProviderEventLog',
  'InventoryTransaction',
  'InventoryAdjustment',
  'InventoryReservation',
  'TransferOrderItem',
  'InventorySerial',
  'SubscriptionPeriod',
]);

interface LayoutPanel {
  name?: string;
  label?: string;
  position?: number;
  fields?: string[];
}

interface LayoutDefinition {
  entity?: string;
  type?: string;
  panels?: LayoutPanel[];
}

interface FieldDefinition {
  type?: string;
  entityKey?: string;
  required?: boolean;
  values?: string[];
}

interface RelationDefinition {
  type?: string;
  target?: string;
  mappedBy?: string;
}

interface EntityDefinition {
  name?: string;
  label?: string;
  isEntity?: boolean;
  fields?: Record<string, FieldDefinition>;
  relations?: Record<string, RelationDefinition>;
  layouts?: Record<string, LayoutDefinition[]>;
  record?: { displayField?: string };
  client?: { web?: boolean };
}

let ctx: ApiContext;
let metadata: Record<string, EntityDefinition>;
const cleanupUsers: string[] = [];

beforeAll(async () => {
  ctx = await bootApi();
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/Metadata',
    headers: { authorization: `Bearer ${ctx.adminToken}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  metadata = response.json() as Record<string, EntityDefinition>;
}, 120_000);

afterAll(async () => {
  for (const id of cleanupUsers) {
    await ctx.database.db.deleteFrom('users').where('id', '=', id).execute().catch(() => undefined);
  }
  await shutdownApi();
}, 120_000);

describe('every Sales entity is registered and complete (19-S.17)', () => {
  it('registers all of them with a label and typed fields', () => {
    const missing: string[] = [];
    const untyped: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const definition = metadata[entity];
      if (definition === undefined) {
        missing.push(entity);
        continue;
      }
      expect(definition.isEntity, `${entity} is not an entity`).toBe(true);
      expect(String(definition.label ?? '').trim(), `${entity} has no label`).not.toBe('');
      const fields = definition.fields ?? {};
      expect(Object.keys(fields).length, `${entity} has no fields`).toBeGreaterThan(0);
      for (const [name, field] of Object.entries(fields)) {
        if (typeof field.type !== 'string' || field.type === '') untyped.push(`${entity}.${name}`);
      }
    }
    expect(missing, 'entities the module owns but the metadata does not register').toEqual([]);
    expect(untyped, 'fields with no type').toEqual([]);
  });

  it('gives each one list and detail layouts that only name fields it has', () => {
    const problems: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const definition = metadata[entity];
      if (definition === undefined) continue;
      const fields = definition.fields ?? {};
      for (const view of ['list', 'detail', 'edit'] as const) {
        const panels = (definition.layouts ?? {})[view];
        if (!Array.isArray(panels) || panels.length === 0) {
          // A command-owned record has no form, by design (see COMMAND_OWNED_RECORDS); every other
          // entity must have all three.
          if (view === 'edit' && COMMAND_OWNED_RECORDS.has(entity)) continue;
          problems.push(`${entity}: no ${view} layout`);
          continue;
        }
        const named = panels.flatMap((panel) => panel.panels ?? []).flatMap((panel) => panel.fields ?? []);
        if (named.length === 0) problems.push(`${entity}: the ${view} layout names no fields`);
        for (const name of named) {
          if (fields[name] === undefined) problems.push(`${entity}: the ${view} layout names "${name}", which is not a field`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('leaves exactly the command-owned records without an edit form', () => {
    const withoutEdit = SALES_ENTITY_TYPES.filter((entity) => {
      const panels = (metadata[entity]?.layouts ?? {})['edit'];
      return !Array.isArray(panels) || panels.length === 0;
    });
    expect([...withoutEdit].sort()).toEqual([...COMMAND_OWNED_RECORDS].sort());
  });

  it('resolves every link and relation to a registered entity', () => {
    const problems: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const definition = metadata[entity];
      if (definition === undefined) continue;
      for (const [name, field] of Object.entries(definition.fields ?? {})) {
        if (field.entityKey === undefined) continue;
        if (IDENTITY_LINK_TARGETS.has(field.entityKey)) continue;
        if (metadata[field.entityKey] === undefined) problems.push(`${entity}.${name} links to unknown entity "${field.entityKey}"`);
      }
      for (const [name, relation] of Object.entries(definition.relations ?? {})) {
        const target = relation.target;
        if (target === undefined) {
          problems.push(`${entity}.${name} has no target`);
          continue;
        }
        const targetDefinition = metadata[target];
        if (targetDefinition === undefined) {
          problems.push(`${entity}.${name} points at unknown entity "${target}"`);
          continue;
        }
        // `mappedBy` names the child field prefix: `source` resolves through `sourceId`, the same rule
        // `attrMatchFor` applies in the Entity Engine.
        if (relation.mappedBy !== undefined) {
          const targetFields = targetDefinition.fields ?? {};
          const candidates = [relation.mappedBy, `${relation.mappedBy}Id`];
          if (!candidates.some((candidate) => targetFields[candidate] !== undefined)) {
            problems.push(`${entity}.${name} is mapped by "${relation.mappedBy}", which "${target}" does not have`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every navigable entity a display field that exists', () => {
    const problems: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const definition = metadata[entity];
      if (definition === undefined) continue;
      // `client.web: false` means "reached through its parent, not the navigation" — a child line or a
      // ledger row — and such an entity has no list screen to display a field on.
      if (definition.client?.web === false) continue;
      const display = definition.record?.displayField;
      if (display === undefined || display === '') {
        problems.push(`${entity}: navigable but has no displayField`);
        continue;
      }
      if ((definition.fields ?? {})[display] === undefined) problems.push(`${entity}: displayField "${display}" is not a field`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the descriptors and the metadata agree (19-S.6)', () => {
  it('has one document entity per kind, whose status enum is the descriptor’s state list', () => {
    const problems: string[] = [];
    for (const kind of IMPLEMENTED_DOCUMENT_KINDS) {
      const descriptor = documentDescriptor(kind);
      const definition = metadata[descriptor.entity];
      if (definition === undefined) {
        problems.push(`${kind}: entity "${descriptor.entity}" is not registered`);
        continue;
      }
      const status = (definition.fields ?? {})['status'];
      if (status === undefined) {
        problems.push(`${kind}: "${descriptor.entity}" has no status field`);
      } else if (JSON.stringify(status.values) !== JSON.stringify([...descriptor.states])) {
        // The seed's own comment: "`states` must match descriptors.ts — the descriptor is the
        // authority for the state machine; the enum is what the engine validates a write against."
        problems.push(`${kind}: status enum ${JSON.stringify(status.values)} ≠ states ${JSON.stringify(descriptor.states)}`);
      }
      const items = (definition.relations ?? {})['items'];
      if (items?.target !== descriptor.itemEntity) problems.push(`${kind}: "items" points at "${String(items?.target)}", expected "${descriptor.itemEntity}"`);
      const itemDefinition = metadata[descriptor.itemEntity];
      if (itemDefinition === undefined) problems.push(`${kind}: item entity "${descriptor.itemEntity}" is not registered`);
      else if ((itemDefinition.fields ?? {})[descriptor.itemParentField] === undefined) {
        problems.push(`${kind}: item entity "${descriptor.itemEntity}" has no "${descriptor.itemParentField}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('declares a date field per kind that the entity actually carries', () => {
    const problems: string[] = [];
    for (const kind of IMPLEMENTED_DOCUMENT_KINDS) {
      const descriptor = documentDescriptor(kind);
      const definition = metadata[descriptor.entity];
      if (definition === undefined) continue;
      if ((definition.fields ?? {})[descriptor.dateField] === undefined) {
        problems.push(`${kind}: dateField "${descriptor.dateField}" is not a field of "${descriptor.entity}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('every Sales entity is ACL-protected (19-S.17)', () => {
  it('refuses a caller with no permission and serves an administrator', async () => {
    const outsider = await createTestUser(ctx, { userName: `sales-layout-audit-${Date.now().toString(36)}`, roleIds: ['noAccess'] });
    cleanupUsers.push(outsider.id);

    const leaked: string[] = [];
    const unreachable: string[] = [];
    for (const entity of SALES_ENTITY_TYPES) {
      const denied = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/${entity}?maxSize=1`,
        headers: { authorization: `Bearer ${outsider.token}` },
      });
      if (denied.statusCode !== 403) leaked.push(`${entity} → ${String(denied.statusCode)}`);

      const allowed = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/${entity}?maxSize=1`,
        headers: { authorization: `Bearer ${ctx.adminToken}` },
      });
      if (allowed.statusCode !== 200) unreachable.push(`${entity} → ${String(allowed.statusCode)}`);
    }
    expect(leaked, 'entities a caller without permission could read').toEqual([]);
    expect(unreachable, 'entities the API could not serve').toEqual([]);
  }, 60_000);
});

describe('the navigation signal (19-S.17 task 5)', () => {
  it('reports the domain as visible to an administrator and invisible to a caller with no access', async () => {
    const outsider = await createTestUser(ctx, { userName: `sales-nav-audit-${Date.now().toString(36)}`, roleIds: ['noAccess'] });
    cleanupUsers.push(outsider.id);

    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/Sales/action/nav',
      headers: { authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(admin.statusCode, admin.body).toBe(200);
    const adminBody = admin.json() as { visible: boolean; readableEntities: number };
    expect(adminBody.visible).toBe(true);
    expect(adminBody.readableEntities).toBe(SALES_ENTITY_TYPES.length);

    const blind = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/Sales/action/nav',
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(blind.statusCode, blind.body).toBe(200);
    const blindBody = blind.json() as { visible: boolean; readableEntities: number };
    expect(blindBody.visible).toBe(false);
    expect(blindBody.readableEntities).toBe(0);
  });
});
