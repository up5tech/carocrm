import pino from 'pino';

import { getRequestContext } from '../context/index.js';

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.oldPassword',
      'apiKey',
      'apiSecret',
      'secret',
      'password',
      'token',
      'refreshToken',
    ],
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