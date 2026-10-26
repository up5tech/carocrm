import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guards the §20.20 token layer: `tokens.css` is the only place a colour literal may live, and every
 * `--carocrm-*` the stylesheet uses must be declared there. This is the automated form of the
 * acceptance criterion ("`grep` for a hex in carocrm.css is 0"), so the sweep cannot silently regress.
 */
const styles = new URL('../styles/', import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, styles)), 'utf8');

const HEX =
  /(#[0-9a-fA-F]{8}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{3})(?![0-9a-fA-F])(?![a-zA-Z0-9_-])/g;

describe('design tokens (§20.20)', () => {
  const carocrm = read('carocrm.css');
  const tokens = read('tokens.css');

  it('carocrm.css contains no hex colour literal', () => {
    expect(carocrm.match(HEX) ?? []).toEqual([]);
  });

  it('every --carocrm-* used in carocrm.css is declared in tokens.css', () => {
    const used = new Set([...carocrm.matchAll(/var\((--carocrm-[a-z0-9-]+)\)/g)].map((match) => match[1]));
    const declared = new Set([...tokens.matchAll(/^\s*(--carocrm-[a-z0-9-]+):/gm)].map((match) => match[1]));
    const missing = [...used].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('declares the themable accent tokens a brand colour overrides', () => {
    for (const name of ['--carocrm-accent', '--carocrm-accent-hover', '--carocrm-accent-strong', '--carocrm-accent-soft']) {
      expect(tokens).toContain(`${name}:`);
    }
  });
});
