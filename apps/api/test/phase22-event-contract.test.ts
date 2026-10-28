import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { runInTransaction } from '../src/entity/tx-context.js';
import { EventBus } from '../src/events/event-bus.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.6 — the domain-event contract
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 task 5; `docs/architecture/contract-catalog.md` §3).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Nothing is reset or truncated; the
 * records this run creates are deleted by id.
 *
 * The outbox is the platform's promise that a committed record and the event that describes it
 * appear together — and that a **rolled back** record leaves no event behind. That promise is what
 * every downstream consumer relies on, and Phase 22.5 found no test locking it in. This file does:
 *
 *  - the event row is written in the caller's transaction, so it is invisible to every other
 *    connection until the transaction commits;
 *  - a transaction that fails leaves neither the record nor the event — including the `entity.*`
 *    event the kernel writes for every mutation;
 *  - the committed event carries the state of the record that changed;
 *  - an event type that is not module-prefixed is refused at the producer, not at the consumer.
 */

const runId = Date.now().toString(36);
const TEST_EVENT_TYPE = 'phase22.contract.event';

let ctx: ApiContext;
let scope: RequestScope;
let events: EventBus;
const createdAccountIds: string[] = [];

/** A system principal with the platform's own capabilities, so a service-level write is allowed. */
function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return scope.runAs(
    { userId: 'system', userName: 'system', userType: 'system', roles: ['sysAdmin'], teams: [] },
    work,
    `phase22:${runId}`,
  );
}

async function outboxRows(eventType: string): Promise<readonly { id: string; payload: unknown }[]> {
  return await ctx.database.db
    .selectFrom('outbox_events')
    .select(['id', 'payload'])
    .where('event_type', '=', eventType)
    .execute();
}

beforeAll(async () => {
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  events = ctx.app.get(EventBus);
});

afterAll(async () => {
  if (createdAccountIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', createdAccountIds).execute();
    // The events this run published about those records are removed with them: an unconsumed
    // event row is what makes the outbox grow without bound.
    await ctx.database.db
      .deleteFrom('outbox_events')
      .where('event_type', '=', 'entity.created')
      .where(sql`payload ->> 'entityId'`, 'in', createdAccountIds)
      .execute();
  }
  await ctx.database.db.deleteFrom('outbox_events').where('event_type', '=', TEST_EVENT_TYPE).execute();
  await shutdownApi();
});

describe('the domain-event contract', () => {
  it('writes the event in the caller\'s transaction, so it appears with the data that caused it', async () => {
    let eventId = '';
    let visibleOutsideBeforeCommit = -1;

    await runInTransaction(ctx.database.db, async (tx) => {
      const account = await asSystem(() =>
        ctx.app.get(EntityCrudService).create('Account', {
          name: `AGENT_TEST_event_${runId}`,
        }),
      );
      createdAccountIds.push(String(account['id']));

      eventId = await events.dispatch(tx, {
        type: TEST_EVENT_TYPE,
        payload: { accountId: String(account['id']), runId },
      });

      // The event is written, and it is written *here* — the row belongs to this transaction.
      const inside = await tx
        .selectFrom('outbox_events')
        .select('id')
        .where('id', '=', eventId)
        .executeTakeFirst();
      expect(inside?.id).toBe(eventId);

      // Another connection cannot see it yet: the row is not committed, and a consumer must never
      // observe an event whose data is still being written.
      const outside = await outboxRows(TEST_EVENT_TYPE);
      visibleOutsideBeforeCommit = outside.filter((row) => row.id === eventId).length;
    });

    expect(visibleOutsideBeforeCommit).toBe(0);
    const after = await outboxRows(TEST_EVENT_TYPE);
    expect(after.map((row) => row.id)).toContain(eventId);
  });

  it('rolls the event back with the transaction that failed', async () => {
    let accountId = '';
    const failure = await runInTransaction(ctx.database.db, async (tx) => {
      const account = await asSystem(() =>
        ctx.app.get(EntityCrudService).create('Account', {
          name: `AGENT_TEST_event_rollback_${runId}`,
        }),
      );
      accountId = String(account['id']);
      await events.dispatch(tx, {
        type: TEST_EVENT_TYPE,
        payload: { accountId, runId },
      });
      throw new Error('The transaction failed after the event was written.');
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);

    // The record is gone…
    const record = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('id', '=', accountId)
      .executeTakeFirst();
    expect(record).toBeUndefined();

    // …and so is the event, including the `entity.created` event the kernel writes for every
    // mutation. An event for a record that was never committed is a consumer acting on a ghost.
    const rows = await outboxRows(TEST_EVENT_TYPE);
    expect(rows.filter((row) => String((row.payload as { accountId?: string }).accountId) === accountId)).toHaveLength(0);

    const kernelRows = await ctx.database.db
      .selectFrom('outbox_events')
      .select(['id', 'payload'])
      .where('event_type', '=', 'entity.created')
      .execute();
    expect(
      kernelRows.filter((row) => String((row.payload as { entityId?: string }).entityId) === accountId),
    ).toHaveLength(0);
  });

  it('carries the committed state of the record that changed', async () => {
    const account = await asSystem(() =>
      ctx.app.get(EntityCrudService).create('Account', {
        name: `AGENT_TEST_event_state_${runId}`,
      }),
    );
    createdAccountIds.push(String(account['id']));
    const accountId = String(account['id']);

    const rows = await ctx.database.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'entity.created')
      .where(sql`payload ->> 'entityId'`, '=', accountId)
      .executeTakeFirst();

    expect(rows).toBeDefined();
    const payload = rows?.payload as { entityType?: string; entityId?: string; version?: number };
    expect(payload.entityType).toBe('Account');
    expect(payload.entityId).toBe(accountId);
    expect(payload.version).toBeGreaterThanOrEqual(1);
  });

  it('refuses an event type that is not module-prefixed, at the producer', async () => {
    const refusal = await runInTransaction(ctx.database.db, async (tx) =>
      events.dispatch(tx, { type: 'notPrefixed', payload: { runId } }).catch((error: unknown) => error),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain('Invalid domain event type');
  });
});
