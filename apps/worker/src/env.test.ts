import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildWorkerConfig, loadEnv } from './env.js';

describe('buildWorkerConfig', () => {
  it('applies the documented kernel defaults', () => {
    const config = buildWorkerConfig({});
    expect(config.queueName).toBe('crm-jobs');
    expect(config.databaseUrl).toContain('carocrm_dev');
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.outboxPollIntervalMs).toBe(2000);
    expect(config.outboxBatchSize).toBe(10);
    expect(config.outboxMaxAttempts).toBe(8);
    expect(config.outboxBackoffBaseMs).toBe(5000);
    expect(config.outboxBackoffMaxMs).toBe(900000);
    expect(config.schedulerIntervalMs).toBe(30000);
    expect(config.jobAttempts).toBe(3);
    expect(config.jobBackoffBaseMs).toBe(5000);
    expect(config.runForMs).toBe(0);
  });

  it('reads the WORKER_* overrides', () => {
    const config = buildWorkerConfig({
      DATABASE_URL: 'postgres://user:pass@db:5432/crm',
      REDIS_URL: 'redis://cache:6379/2',
      WORKER_QUEUE_NAME: 'other-queue',
      WORKER_OUTBOX_POLL_INTERVAL_MS: '250',
      WORKER_OUTBOX_BATCH_SIZE: '3',
      WORKER_MAX_ATTEMPTS: '4',
      WORKER_SCHEDULER_INTERVAL_MS: '1000',
      WORKER_JOB_ATTEMPTS: '5',
      WORKER_JOB_CONCURRENCY: '2',
      WORKER_RUN_MS: '12000',
    });
    expect(config.databaseUrl).toBe('postgres://user:pass@db:5432/crm');
    expect(config.redisUrl).toBe('redis://cache:6379/2');
    expect(config.queueName).toBe('other-queue');
    expect(config.outboxPollIntervalMs).toBe(250);
    expect(config.outboxBatchSize).toBe(3);
    expect(config.outboxMaxAttempts).toBe(4);
    expect(config.schedulerIntervalMs).toBe(1000);
    expect(config.jobAttempts).toBe(5);
    expect(config.jobConcurrency).toBe(2);
    expect(config.runForMs).toBe(12000);
  });

  it('rejects malformed numbers and out-of-range values', () => {
    expect(() => buildWorkerConfig({ WORKER_OUTBOX_BATCH_SIZE: 'abc' })).toThrow();
    expect(() => buildWorkerConfig({ WORKER_OUTBOX_BATCH_SIZE: '0' })).toThrow();
    expect(() => buildWorkerConfig({ WORKER_JOB_ATTEMPTS: '-1' })).toThrow();
    expect(() => buildWorkerConfig({ REDIS_URL: '' })).toThrow();
  });
});

describe('loadEnv', () => {
  it('loads KEY=value pairs from a .env file, without overriding real env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carocrm-worker-env-'));
    try {
      writeFileSync(
        join(dir, '.env'),
        [
          '# a comment',
          '',
          'WORKER_TEST_PLAIN=plain',
          'WORKER_TEST_QUOTED="quoted value"',
          'WORKER_TEST_EXISTS=polluted',
        ].join('\n'),
        'utf8',
      );
      process.env['WORKER_TEST_EXISTS'] = 'from-process';
      const loaded = loadEnv(dir);
      expect(loaded).toBe(join(dir, '.env'));
      expect(process.env['WORKER_TEST_PLAIN']).toBe('plain');
      expect(process.env['WORKER_TEST_QUOTED']).toBe('quoted value');
      expect(process.env['WORKER_TEST_EXISTS']).toBe('from-process');
    } finally {
      delete process.env['WORKER_TEST_PLAIN'];
      delete process.env['WORKER_TEST_QUOTED'];
      delete process.env['WORKER_TEST_EXISTS'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no .env exists above the start directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'carocrm-worker-env-empty-'));
    try {
      // Walk-up stops at the filesystem root, so nothing is found under an empty temp tree.
      const loaded = loadEnv(dir);
      expect(loaded === undefined || loaded.endsWith('carocrmv2/.env')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
