import { AsyncLocalStorage } from 'node:async_hooks';

import type { Db, DbTx } from '../database/database.service.js';

const storage = new AsyncLocalStorage<DbTx | undefined>();

/** The transaction the current call is running in, if any. */
export function currentTx(): DbTx | undefined {
  return storage.getStore();
}

/**
 * Run `work` inside one database transaction, and let every record write it performs join that same
 * transaction instead of opening another one.
 *
 * `PostgresRecordStore` wraps each single mutation in a transaction of its own, which is what the
 * audit/stream/outbox kernel hooks need. A Phase 19 domain command (a stage move, a reorder, a
 * project clone) is several mutations with one invariant, so it runs here instead: nested calls see
 * the ambient transaction and reuse it. Without a second transaction manager, and without a
 * connection pool deadlock, because no nested `BEGIN` is ever issued (AGENTS.md §5.1).
 */
export async function runInTransaction<T>(db: Db, work: (tx: DbTx) => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing !== undefined) return work(existing);
  return db.transaction().execute((tx) => withTxContext(tx, () => work(tx)));
}

/**
 * Mark the current async context as running inside `tx`, so any store read or write issued from
 * `work` joins it instead of taking another connection from the pool.
 */
export async function withTxContext<T>(tx: DbTx, work: () => Promise<T>): Promise<T> {
  return storage.run(tx, work);
}
