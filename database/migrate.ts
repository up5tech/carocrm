import { readdirSync, readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { getDatabaseUrl,loadEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const dir = resolve(here, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount && done.rowCount > 0) continue;
      const sql = readFileSync(resolve(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await pool.end();
  }
}

export async function withDatabase(connectionString: string, fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  loadEnv();
  runMigrations(getDatabaseUrl())
    .then((applied) => {
      if (applied.length === 0) {
        process.stdout.write('migrations: up to date\n');
      } else {
        process.stdout.write(`migrations applied: ${applied.join(', ')}\n`);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
