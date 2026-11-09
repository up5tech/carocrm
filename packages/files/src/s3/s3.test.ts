import { describe, expect, it } from 'vitest';

import { parseS3Settings } from './index.js';

describe('parseS3Settings', () => {
  const base = {
    driver: 's3' as const,
    bucket: 'b',
    region: 'r',
    endpoint: '',
    accessKeyId: '',
    secretAccessKey: '',
    forcePathStyle: '',
  };

  it('accepts both credentials or neither', () => {
    expect(() => parseS3Settings({ ...base, accessKeyId: 'k', secretAccessKey: 's' })).not.toThrow();
    expect(() => parseS3Settings(base)).not.toThrow();
  });

  it('throws when only one credential is set (G87)', () => {
    expect(() => parseS3Settings({ ...base, accessKeyId: 'k', secretAccessKey: '' })).toThrow();
    expect(() => parseS3Settings({ ...base, accessKeyId: '', secretAccessKey: 's' })).toThrow();
  });
});