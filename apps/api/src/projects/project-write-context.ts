import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<boolean>();

/**
 * True while a Projects domain command is writing. The generic record API and the domain commands
 * run through the same validation hooks, and only the commands may write the fields the platform
 * derives for itself — a task's `status` (always the mapped stage status) and the ownership
 * membership row created with a new project (PLAN_Phase_19_Projects.md §4.3, §4.6).
 *
 * Nothing else changes: every other rule still applies to a domain write, so a command cannot use
 * this flag as a shortcut around validation.
 */
export function isDomainProjectWrite(): boolean {
  return storage.getStore() === true;
}

export async function asDomainProjectWrite<T>(work: () => Promise<T>): Promise<T> {
  return storage.run(true, work);
}
