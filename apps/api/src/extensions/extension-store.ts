import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { log } from '@carocrm/core/logger/index.js';
import { errorMessage,ExtensionError } from '@carocrm/extension-sdk';
import type { ExtensionPackage } from '@carocrm/extension-sdk/loader/index.js';
import pg from 'pg';

/**
 * Durable state of the extension installation (PLAN §38.3).
 *
 * Two tables, both created by the core migration:
 *
 * ```text
 * installed_extensions   id, name, version, order, enabled, manifest, installed_at, modified_at
 * extension_migrations   extension_id, name, applied_at
 * ```
 *
 * `installed_extensions` is the *activation* record — a package is merely present on disk until an
 * administrator installs it — and `extension_migrations` is a per-extension ledger, kept apart from
 * the core `schema_migrations` so an extension can never claim (or re-run) a kernel migration.
 *
 * These helpers use a plain `pg` pool on purpose: the bootstrap loader must read the enabled ids
 * *before* Nest (and therefore Kysely) exists.
 */

export interface InstalledExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly installedAt: Date;
}

export interface InstalledExtensionState {
  readonly enabled: Set<string>;
  readonly disabled: Set<string>;
}

/**
 * Reads the installed/enabled sets. A missing table (fresh database, migrations not applied yet)
 * yields empty sets rather than an error, so a brand-new installation still boots.
 */
export async function readInstalledExtensions(connectionString: string): Promise<InstalledExtensionState> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ id: string; enabled: boolean }>(
      'SELECT id, enabled FROM installed_extensions',
    );
    const enabled = new Set<string>();
    const disabled = new Set<string>();
    for (const row of result.rows) (row.enabled ? enabled : disabled).add(row.id);
    return { enabled, disabled };
  } catch (error: unknown) {
    log.warn({ error: errorMessage(error) }, 'installed extensions could not be read; continuing without extensions');
    return { enabled: new Set(), disabled: new Set() };
  } finally {
    await pool.end();
  }
}

/**
 * Applies the package's pending `*.sql` files, each in its own transaction, recording every applied
 * file in `extension_migrations` (AGENTS.md §3.5: reviewed, version-controlled SQL — never a
 * statement assembled at runtime from user input).
 *
 * Re-running is a no-op, which is what makes `install` safe to retry after a partial failure.
 */
export async function applyExtensionMigrations(connectionString: string, pkg: ExtensionPackage): Promise<{ applied: string[]; skipped: string[] }> {
  const files = pkg.migrationFiles.map((file) => ({ name: basename(file), sql: readFileSync(file, 'utf8') }));
  if (files.length === 0) return { applied: [], skipped: [] };

  const pool = new pg.Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    for (const file of files) {
      const done = await pool.query('SELECT 1 FROM extension_migrations WHERE extension_id = $1 AND name = $2', [pkg.id, file.name]);
      if ((done.rowCount ?? 0) > 0) {
        skipped.push(file.name);
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO extension_migrations (extension_id, name) VALUES ($1, $2)', [pkg.id, file.name]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw new ExtensionError('EXTENSION_MIGRATION_FAILED', `Migration "${file.name}" of extension "${pkg.id}" failed: ${errorMessage(error)}`, {
          id: pkg.id,
          migration: file.name,
        });
      } finally {
        client.release();
      }
    }
    return { applied, skipped };
  } finally {
    await pool.end();
  }
}