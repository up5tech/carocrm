import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * §20.26: the convention gate must actually run and must actually catch each defect. `pnpm test:web`
 * invokes the script twice — once against the real tree (must be clean) and once in `--self-test`
 * mode (every rule must flag a seeded violation). Without the second run a broken regex could quietly
 * stop enforcing anything while the first run stayed green.
 */
const root = process.cwd();
const script = join(root, 'scripts/check-ui-conventions.mjs');

const run = (args: string[]): string =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'pipe', encoding: 'utf8' });

describe('ui conventions gate (§20.22/§20.26)', () => {
  it('passes on the current tree', () => {
    expect(run([])).toContain('ui conventions: clean');
  });

  it('catches a seeded violation in every rule (--self-test)', () => {
    expect(run(['--self-test'])).toContain('self-test: ok');
  });
});
