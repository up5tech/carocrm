import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Phase 24.4 — the api-spec registry gate regression.
 *
 * `pnpm ci:api-spec` runs `scripts/check-api-spec.mjs --strict`, which fails when any `/api`
 * controller route is undocumented. This suite proves that contract without a database: it drops a
 * probe controller into `apps/api/src`, runs the real checker both ways, and removes the probe.
 * The probe is never registered in a Nest module, so it cannot affect the application — the
 * checker's route extraction is static (decorators only).
 */

const ROOT = process.cwd();
const PROBE = join(ROOT, 'apps/api/src/zz-api-spec-registry-probe.controller.ts');
const PROBE_ROUTE = '/api/v1/SpecProbeRegistry/ping';

const PROBE_SOURCE = `import { Controller, Get } from '@nestjs/common';

@Controller('api/v1/SpecProbeRegistry')
export class SpecProbeRegistryController {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}
`;

function runChecker(args: string[]) {
  return spawnSync('node', ['scripts/check-api-spec.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('api-spec registry gate (Phase 24.4)', () => {
  it('strict mode fails on an undocumented route and the lenient mode only reports it', () => {
    expect(existsSync(PROBE)).toBe(false);
    writeFileSync(PROBE, PROBE_SOURCE);
    try {
      const strict = runChecker(['--strict']);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain('--strict requires every /api route to be documented');
      expect(strict.stdout).toContain('1 not yet documented');
      expect(strict.stdout).toContain(PROBE_ROUTE);

      const lenient = runChecker([]);
      expect(lenient.status).toBe(0);
      expect(lenient.stdout).toContain('1 not yet documented');
    } finally {
      rmSync(PROBE, { force: true });
    }
  });

  it('the committed registry passes strict checking', () => {
    const result = runChecker(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('registry is consistent with the controllers');
  });
});
