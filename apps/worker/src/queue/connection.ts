import type { Logger } from '@carocrm/core/logger/index.js';
import { Redis } from 'ioredis';

import { errorMessage } from '../db.js';

/**
 * Creates an ioredis connection for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` (a command must never be rejected while the
 * connection is reconnecting). Each BullMQ entity gets its own connection: the worker also
 * duplicates one internally for its blocking `BRPOP`.
 */
export function createRedisConnection(url: string, log: Logger, label: string): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  redis.on('error', (error: Error) => {
    log.error({ error: error.message, label }, 'redis connection error');
  });
  redis.on('close', () => {
    log.debug({ label }, 'redis connection closed');
  });
  return redis;
}

export async function closeRedisConnection(redis: Redis, log: Logger, label: string): Promise<void> {
  if (redis.status === 'end') return;
  try {
    await redis.quit();
  } catch (error: unknown) {
    log.warn({ error: errorMessage(error), label }, 'redis quit failed, forcing disconnect');
    redis.disconnect();
  }
}
