import type { EntityRecord } from '@carocrm/entity-engine/types/index.js';

import type { Db, DbTx } from '../database/database.service.js';

/**
 * Kernel hook contract (docs/module-guide.md "Cross-module contracts").
 *
 * The generic entity store invokes every registered hook inside the mutation
 * transaction right after insert/update/soft-delete. The audit module pushes its
 * hook into the KERNEL_HOOKS_TOKEN array (`useValue: []`, i.e. one shared,
 * mutable instance) while being constructed, so provider order does not matter.
 */
/** Which mutation opened the transaction the hook runs in (PLAN §23.2). */
export type KernelMutation = 'create' | 'update' | 'delete' | 'restore';

export interface AfterSaveHookArgs {
  readonly entityType: string;
  readonly record: EntityRecord;
  readonly previous?: Record<string, unknown> | undefined;
  readonly userId?: string | undefined;
  readonly tx: Db | DbTx;
  readonly operation: KernelMutation;
}

export type AfterSaveHook = (args: AfterSaveHookArgs) => Promise<void>;

export const KERNEL_HOOKS_TOKEN = Symbol('KERNEL_HOOKS');
