import { migrateDb } from './bootstrap.js';

const connectionString = process.env['MIGRATIONS_DATABASE_URL']?.trim();
if (!connectionString) {
  process.stderr.write('MIGRATIONS_DATABASE_URL is required; migrations must use the separate DDL-capable role.\n');
  process.exit(1);
}
process.env['MIGRATIONS_DATABASE_URL'] = connectionString;

migrateDb(connectionString)
  .then(() => process.stdout.write('migrations: up to date\n'))
  .catch((error: unknown) => {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  });
