import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(rootDir: string = process.cwd()): void {
  const file = resolve(rootDir, '.env');
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/carocrm_dev';
}
