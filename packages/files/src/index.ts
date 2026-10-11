/**
 * @carocrm/files — the storage abstraction behind attachments (PLAN §25).
 *
 * Drivers: local filesystem, S3 and any S3-compatible endpoint (MinIO). The port also carries the
 * malware-scanning hook. No module outside this package touches a driver SDK directly.
 */
export * from './local/index.js';
export * from './s3/index.js';
export * from './scanner/index.js';
export * from './storage/index.js';
