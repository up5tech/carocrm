import { listen } from './bootstrap.js';
import { buildConfig } from './config.js';

listen(buildConfig()).catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
