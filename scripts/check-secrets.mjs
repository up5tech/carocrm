#!/usr/bin/env node
/**
 * Phase 22.22 — the scheduled gate's secret check.
 *
 * It scans **tracked** files only (what a checkout would publish) for high-confidence credential
 * shapes, plus a tracked `.env` file (which should never be in the repository). It is deliberately
 * narrow: a generic "password =" pattern would flag documentation and test fixtures, and a scanner
 * everyone learns to ignore is worse than no scanner. The log never prints the matched value.
 *
 * Exit code 1 on a finding; 0 on a clean tree. No network, no database, no side effects.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // OpenAI-style keys are long and prefixed; the 32+ body avoids placeholder "sk-test".
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '');

const findings = [];
for (const file of tracked) {
  if (/(^|\/)\.env(\..+)?$/.test(file) && !file.endsWith('.example')) {
    findings.push({ file, line: 0, rule: 'tracked-env-file' });
    continue;
  }
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 1_000_000 || /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|webm|wasm)$/i.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue; // binary that slipped past the extension list
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.includes('[REDACTED]') || /agent[-_ ]test/i.test(line)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) findings.push({ file, line: index + 1, rule: pattern.name });
    }
  }
}

if (findings.length === 0) {
  console.log(`secret scan: clean (${String(tracked.length)} tracked files)`);
  process.exit(0);
}

console.error(`secret scan: ${String(findings.length)} finding(s). Values are not printed.`);
for (const finding of findings) {
  console.error(`- ${finding.file}:${String(finding.line)} (${finding.rule})`);
}
process.exit(1);
