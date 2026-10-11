import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';
import pg from 'pg';

import { getDatabaseUrl,loadEnv } from './env.js';
import { runMigrations } from './migrate.js';
import { coreMetadata } from './seed-metadata.js';

const here = dirname(fileURLToPath(import.meta.url));
void here;

export interface SeedOptions {
  adminLogin?: string;
  adminPassword?: string;
  resetAdminPassword?: boolean;
  demo?: boolean;
}

export async function seed(connectionString: string, options: SeedOptions = {}): Promise<void> {
  await runMigrations(connectionString);
  const adminLogin = options.adminLogin ?? process.env.SEED_ADMIN_LOGIN ?? 'admin';
  const adminPassword = options.adminPassword ?? process.env.SEED_ADMIN_PASSWORD ?? 'admin';
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });

    await pool.query(
      `INSERT INTO roles (id, name, permissions) VALUES ($1, 'System Administrator', $2) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      ['sysAdmin', { '*' : { create: 'yes', read: 'yes', edit: 'yes', delete: 'yes', stream: 'yes', export: 'yes', massUpdate: 'yes' } }],
    );
    await pool.query(
      `INSERT INTO roles (id, name, permissions) VALUES ($1, 'Default users', $2) ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      ['noAccess', {}],
    );

    await pool.query(
      `INSERT INTO teams (id, name) VALUES ($1, 'Sales') ON CONFLICT (id) DO NOTHING`,
      ['teamSales'],
    );

    // Never overwrite an existing admin password: shared dev database would break concurrent suites.
    await pool.query(
      `INSERT INTO users (id, user_name, is_admin, type, password, assigned_role_ids, first_name, last_name, email_address)
       VALUES ($1, $2, TRUE, 'admin', $3, '["sysAdmin"]', 'Admin', 'User', $4)
       ON CONFLICT (user_name) DO UPDATE SET is_active = TRUE, is_deleted = FALSE, is_admin = TRUE, type = 'admin'`,
      ['adminUserId', adminLogin, passwordHash, `${adminLogin}@example.com`],
    );
    if (options.resetAdminPassword) {
      await pool.query(`UPDATE users SET password = $2, is_admin = TRUE, type = 'admin' WHERE user_name = $1`, [adminLogin, passwordHash]);
    }

    if (options.demo) {
      const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'demo123';
      const demoHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
      await pool.query(
        `INSERT INTO users (id, user_name, password, first_name, last_name, email_address, assigned_role_ids)
         VALUES ($1, 'demo', $2, 'Demo', 'User', 'demo@example.com', '["noAccess"]')
         ON CONFLICT (user_name) DO NOTHING`,
        ['demoUserId', demoHash],
      );
      await pool.query(`INSERT INTO users_teams (user_id, team_id) VALUES ('demoUserId', 'teamSales') ON CONFLICT DO NOTHING`);
    }

    for (const entry of coreMetadata) {
      await pool.query(
        `INSERT INTO metadata_entries (scope, name, data) VALUES ($1, $2, $3)
         ON CONFLICT (scope, name) DO UPDATE SET data = EXCLUDED.data, modified_at = now()`,
        [entry.scope, entry.name, JSON.stringify(entry.data)],
      );
    }

    await pool.query(
      `INSERT INTO app_settings (name, data) VALUES ('entity', $1) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(Object.fromEntries(coreMetadata.map((e) => [e.name, e.data])))],
    );
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  loadEnv();
  const demo = process.argv.includes('--demo');
  seed(getDatabaseUrl(), { demo })
    .then(() => {
      process.stdout.write('seed: done\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(`seed failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
