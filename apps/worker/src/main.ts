import { log } from '@carocrm/core/logger/index.js';

import { WorkerApplication } from './app.js';
import { errorMessage } from './db.js';
import { loadWorkerConfig } from './env.js';

/**
 * Worker entrypoint: `pnpm --filter @carocrm/worker dev` (tsx watch) or
 * `node dist/main.js` after `pnpm --filter @carocrm/worker build`.
 */
const config = loadWorkerConfig();
// The shared logger is created at import time (before `.env` is read), so align its level now.
log.level = config.logLevel;

const app = new WorkerApplication(config, log);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down');

  const forceExit = setTimeout(() => {
    log.error('graceful shutdown timed out after 15s, forcing exit');
    process.exit(1);
  }, 15000);
  forceExit.unref();

  try {
    await app.stop();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error: unknown) {
    log.error({ error: errorMessage(error) }, 'error during shutdown');
    clearTimeout(forceExit);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason: unknown) => {
  log.error({ error: errorMessage(reason) }, 'unhandled promise rejection in worker');
});

process.on('uncaughtException', (error: Error) => {
  log.fatal({ error: errorMessage(error) }, 'uncaught exception in worker');
  process.exit(1);
});

app.start().catch((error: unknown) => {
  log.error({ error: errorMessage(error) }, 'worker failed to start');
  process.exit(1);
});

// Optional auto-stop (WORKER_RUN_MS): used by the smoke script and one-shot container runs so
// a bounded lifetime still goes through the full graceful shutdown path instead of a signal.
if (config.runForMs > 0) {
  setTimeout(() => {
    void shutdown('WORKER_RUN_MS');
  }, config.runForMs);
}
