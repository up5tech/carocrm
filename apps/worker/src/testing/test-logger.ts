import { Writable } from 'node:stream';

import type { Logger } from '@carocrm/core/logger/index.js';
import pino from 'pino';

export interface LogRecord {
  level: string;
  msg: string;
  [key: string]: unknown;
}

/** pino serialises `level` as a number; tests read the label instead. */
const LEVEL_BY_VALUE: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export interface TestLogger {
  log: Logger;
  records: LogRecord[];
  messages(level?: string): string[];
  recordsAt(level: string): LogRecord[];
}

/** Capturing pino logger so tests can assert that a warning/error was emitted. */
export function createTestLogger(): TestLogger {
  const records: LogRecord[] = [];
  const sink = new Writable({
    write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const line = String(chunk).trim();
      if (line !== '') {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const value = typeof parsed.level === 'number' ? parsed.level : 30;
          records.push({ ...parsed, level: LEVEL_BY_VALUE[value] ?? 'info', msg: String(parsed.msg ?? '') });
        } catch {
          records.push({ level: 'trace', msg: line });
        }
      }
      callback();
    },
  });

  const log = pino({ level: 'trace' }, sink);
  return {
    log,
    records,
    messages: (level?: string) =>
      records
        .filter((record) => level === undefined || record.level === level)
        .map((record) => record.msg),
    recordsAt: (level: string) => records.filter((record) => record.level === level),
  };
}
