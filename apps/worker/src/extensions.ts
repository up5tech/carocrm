import { log } from '@carocrm/core/logger/index.js';
import { ExtensionError, ExtensionHost, loadExtensions } from '@carocrm/extension-sdk';

import type { Queryable } from './db.js';
import { isRecord } from './db.js';
import type { WorkerConfig } from './env.js';

/**
 * Extension loading in the worker (PLAN §38.3, §24).
 *
 * The worker loads the same packages as the API — the same directory, the same
 * `installed_extensions` rows — but uses a different slice of the backend contract: job handlers
 * and domain-event subscribers. A package declaring `backend: { entry, worker: false }` is skipped
 * here, and the worker never loads Nest providers or controllers.
 *
 * Loading happens **before** `WorkerApplication.start()`, so a broken package fails the process
 * fast instead of leaving a worker that silently ignores part of its queue.
 */

export async function loadWorkerExtensions(config: WorkerConfig): Promise<ExtensionHost> {
  const state = await readInstalledIds(config);
  if (state.enabled.size === 0) return ExtensionHost.empty();
  return loadExtensions({
    directory: config.extensionsDir,
    platformVersion: config.platformVersion,
    enabledIds: state.enabled,
    disabledIds: state.disabled,
  });
}

/** Reads the enabled/disabled extension ids straight from Postgres (the worker has no Kysely). */
async function readInstalledIds(config: WorkerConfig): Promise<{ enabled: Set<string>; disabled: Set<string> }> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ id: string; enabled: boolean }>('SELECT id, enabled FROM installed_extensions');
    const enabled = new Set<string>();
    const disabled = new Set<string>();
    for (const row of result.rows) (row.enabled ? enabled : disabled).add(row.id);
    return { enabled, disabled };
  } catch (error: unknown) {
    // A missing table simply means no extension has ever been installed — a normal state.
    log.debug({ error: error instanceof Error ? error.message : String(error) }, 'installed extensions could not be read');
    return { enabled: new Set(), disabled: new Set() };
  } finally {
    await pool.end();
  }
}

/** Turns a package failure into a message an operator can act on. */
export function describeExtensionFailure(error: unknown): string {
  if (error instanceof ExtensionError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads an extension's configuration blob (`app_settings` row `extension:<id>`).
 *
 * Loaded once during `setup()` so the facade's `getConfig` can stay synchronous, which is what a
 * job handler wants inside a loop. A missing row is an empty configuration, not an error.
 */
export async function loadExtensionConfig(db: Queryable, id: string): Promise<Record<string, unknown>> {
  const result = await db.query('SELECT data FROM app_settings WHERE name = $1', [`extension:${id}`]);
  const data = result.rows[0]?.['data'];
  if (isRecord(data)) return data;
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}