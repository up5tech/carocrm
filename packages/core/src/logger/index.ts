import pino from 'pino';

import { getRequestContext } from '../context/index.js';

/**
 * Credential-shaped keys dropped from every log line by default (22.21 task 3).
 *
 * The list is deliberately broader than the first version: provider adapters, OAuth callbacks and
 * webhook receivers all build objects whose field names are vendor-specific, and a single missed
 * spelling is a token in a log. `*` matches one object level, so `*.accessToken` covers a nested
 * connector result as well as a top-level one.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-api-secret"]',
  'req.headers["x-webhook-signature"]',
  'req.headers["x-docusign-signature-1"]',
  'req.headers.signature',
  'req.body.password',
  'req.body.newPassword',
  'req.body.oldPassword',
  'req.body.cardNumber',
  'req.body.cvc',
  'apiKey',
  'apiSecret',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'databaseUrl',
  'connectionString',
  'redisUrl',
  'secret',
  'password',
  'token',
  'authorization',
  'cookie',
  '*.apiKey',
  '*.apiSecret',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.authorization',
  '*.cookie',
  '*.secret',
  '*.password',
  '*.token',
  'err.config.headers.authorization',
  'err.config.headers["x-api-key"]',
] as const;

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
  },
  hooks: {
    logMethod(inputArgs: unknown[], method: (...args: unknown[]) => void) {
      const context = getRequestContext();
      if (context) {
        const obj = (inputArgs[0] as Record<string, unknown>) ?? {};
        if (typeof obj === 'object' && obj !== null) {
          obj.requestId = context.requestId;
          if (context.userId) obj.userId = context.userId;
          if (context.tenantId) obj.tenantId = context.tenantId;
          if (context.traceId) obj.traceId = context.traceId;
        }
      }
      method.apply(this, inputArgs);
    },
  },
};

if (process.env.NODE_ENV === 'development' && process.env.PINO_PRETTY !== 'false') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  };
}

const logger = pino(options);

export const log = logger;

export function createLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}

export type Logger = pino.Logger;