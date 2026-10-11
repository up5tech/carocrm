import { resolve } from 'node:path';

import type { FileStorage } from '@carocrm/files';
import { LocalFsStorage, parseS3Settings,S3FileStorage } from '@carocrm/files';

import type { WorkerConfig } from './env.js';

/**
 * Storage for worker jobs that touch attachment bytes (`system.cleanupUploads`).
 *
 * The same `STORAGE_*`/`S3_*` environment variables drive the API and the worker, so a chunked
 * upload started against one is cleaned up by the other.
 */
export function createStorage(config: WorkerConfig): FileStorage {
  if (config.storageDriver === 'local') {
    return new LocalFsStorage(resolve(config.storageRoot));
  }
  return new S3FileStorage(
    parseS3Settings({
      driver: config.storageDriver,
      bucket: config.s3Bucket,
      region: config.s3Region,
      endpoint: config.s3Endpoint,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      forcePathStyle: config.s3ForcePathStyle,
    }),
  );
}
