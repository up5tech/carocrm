#!/usr/bin/env node
/**
 * PLAN §58 — API endpoint registry check.
 *
 * The registry in `api-spec/` is hand-written (it states permissions, side effects and idempotency
 * that no generator can infer), so the one thing that must be automated is that it does not lie:
 * every documented `method + path` has to exist in the Nest controllers, every file has to parse,
 * and no endpoint may be documented twice.
 *
 * Route extraction is static (decorators only) so this runs DB-free in the nightly gate. Path
 * parameters are compared by position, so `:id` and `:sessionId` match. Coverage of the remaining
 * /api/v1 routes is reported, and required only with `--strict` while the registry is incomplete.
 *
 * Usage:
 *   node scripts/check-api-spec.mjs             # validate the documented entries
 *   node scripts/check-api-spec.mjs --strict    # also require every /api/v1 route to be documented
 *   node scripts/check-api-spec.mjs --print     # dump the parsed registry
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SPEC_DIR = 'api-spec';
const SRC_DIR = 'apps/api/src';
const REQUIRED_FIELDS = [
  'method',
  'path',
  'auth',
  'permissions',
  'request',
  'response',
  'errors',
  'pagination',
  'sorting',
  'filtering',
  'sideEffects',
  'idempotency',
];
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_VALUES = new Set(['public', 'authenticated', 'cookie+csrf']);

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const print = args.has('--print');

/** Splits `key: value` and rejects anything that is not a flat field. */
function splitField(body, where) {
  const match = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/.exec(body);
  if (!match) throw new Error(`${where}: expected "key: value", got "${body}"`);
  return { key: match[1], value: match[2] ?? '' };
}

function scalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => scalar(item.trim()));
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Parses the documented YAML subset: top-level scalars, an `endpoints` list and flat fields under
 * each item. Deliberately not a YAML implementation — see api-spec/README.md §2.
 */
function parseSpec(text, file) {
  const doc = { endpoints: [] };
  let inEndpoints = false;
  let current;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+$/, '');
    const body = line.trim();
    if (body === '' || body.startsWith('#')) continue;
    const where = `${file}:${String(index + 1)}`;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const { key, value } = splitField(body, where);
      if (key === 'endpoints') {
        if (value !== '') throw new Error(`${where}: "endpoints" takes no value`);
        inEndpoints = true;
        continue;
      }
      if (key in doc) throw new Error(`${where}: duplicate top-level key "${key}"`);
      doc[key] = scalar(value);
      inEndpoints = false;
      continue;
    }
    if (!inEndpoints) throw new Error(`${where}: indented line outside "endpoints"`);
    if (body.startsWith('- ')) {
      current = {};
      doc.endpoints.push(current);
      const { key, value } = splitField(body.slice(2), where);
      current[key] = scalar(value);
      continue;
    }
    if (current === undefined) throw new Error(`${where}: field before the first list item`);
    const { key, value } = splitField(body, where);
    if (key in current) throw new Error(`${where}: duplicate field "${key}"`);
    current[key] = scalar(value);
  }
  return doc;
}

function controllerFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...controllerFiles(path));
    else if (entry.endsWith('.controller.ts')) out.push(path);
  }
  return out;
}

function normalizePath(path) {
  const trimmed = path.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return trimmed === '' ? '/' : trimmed.replace(/:[A-Za-z0-9_]+/g, ':');
}

const CONTROLLER_RE = /^\s*@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;
const ROUTE_RE = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;

/** Static route inventory from the controllers. */
function sourceRoutes() {
  const routes = [];
  for (const file of controllerFiles(SRC_DIR)) {
    let prefix = '';
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const controller = CONTROLLER_RE.exec(line);
      if (controller) {
        prefix = controller[1] ?? controller[2] ?? '';
        continue;
      }
      const route = ROUTE_RE.exec(line);
      if (!route) continue;
      const suffix = route[2] ?? route[3] ?? '';
      const path = `/${[prefix, suffix].filter((part) => part !== '').join('/')}`.replace(/\/{2,}/g, '/');
      routes.push({ method: route[1].toUpperCase(), path, file: relative(process.cwd(), file) });
    }
  }
  return routes;
}

function specFiles() {
  return readdirSync(SPEC_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => join(SPEC_DIR, name));
}

const errors = [];
const documented = [];
let fileCount = 0;

for (const file of specFiles()) {
  fileCount += 1;
  let spec;
  try {
    spec = parseSpec(readFileSync(file, 'utf8'), file);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    continue;
  }
  if (typeof spec.group !== 'string' || spec.group === '') errors.push(`${file}: missing "group"`);
  if (typeof spec.basePath !== 'string' || !spec.basePath.startsWith('/')) {
    errors.push(`${file}: missing or invalid "basePath"`);
    continue;
  }
  if (!Array.isArray(spec.endpoints) || spec.endpoints.length === 0) errors.push(`${file}: no endpoints`);

  for (const [index, endpoint] of spec.endpoints.entries()) {
    const where = `${file} endpoint #${String(index + 1)}`;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in endpoint)) errors.push(`${where}: missing "${field}"`);
    }
    if (!METHODS.has(endpoint.method)) errors.push(`${where}: unknown method "${String(endpoint.method)}"`);
    if (typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/')) {
      errors.push(`${where}: path must start with "/"`);
      continue;
    }
    if (!endpoint.path.startsWith(spec.basePath)) errors.push(`${where}: path does not start with basePath "${spec.basePath}"`);
    if (!AUTH_VALUES.has(endpoint.auth)) errors.push(`${where}: unknown auth "${String(endpoint.auth)}"`);
    if (!Array.isArray(endpoint.errors)) errors.push(`${where}: "errors" must be an inline array`);
    if (!Array.isArray(endpoint.sideEffects) && endpoint.sideEffects !== 'none') {
      errors.push(`${where}: "sideEffects" must be an inline array or the literal "none"`);
    }
    documented.push({ file, group: spec.group, method: endpoint.method, path: endpoint.path, auth: endpoint.auth });
  }
}

const routes = sourceRoutes();
const apiRoutes = routes.filter((route) => route.path.startsWith('/api/'));
const realKeys = new Set(apiRoutes.map((route) => `${route.method} ${normalizePath(route.path)}`));

const seen = new Map();
let matched = 0;
for (const entry of documented) {
  const key = `${entry.method} ${normalizePath(entry.path)}`;
  const previous = seen.get(key);
  if (previous !== undefined) {
    errors.push(`${entry.file}: ${entry.method} ${entry.path} is documented twice (also ${previous})`);
    continue;
  }
  seen.set(key, entry.file);
  if (realKeys.has(key)) matched += 1;
  else errors.push(`${entry.file}: ${entry.method} ${entry.path} does not exist in any controller`);
}

const undocumented = apiRoutes.filter((route) => !seen.has(`${route.method} ${normalizePath(route.path)}`));

if (print) {
  console.log(JSON.stringify(documented, null, 2));
}

console.log(
  `api-spec: ${String(fileCount)} files, ${String(documented.length)} documented endpoints, ` +
    `${String(matched)} matched, ${String(errors.length)} problem(s)`,
);
console.log(`api-spec: ${String(apiRoutes.length)} /api routes in source, ${String(undocumented.length)} not yet documented`);

if (undocumented.length > 0) {
  const sample = undocumented.slice(0, 8).map((route) => `  ${route.method} ${route.path} (${route.file})`);
  console.log(`api-spec: first undocumented routes:\n${sample.join('\n')}`);
}

if (errors.length > 0) {
  console.error(`\napi-spec: ${String(errors.length)} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

if (strict && undocumented.length > 0) {
  console.error(`\napi-spec: --strict requires every /api route to be documented; ${String(undocumented.length)} remain.`);
  process.exit(1);
}

console.log('api-spec: registry is consistent with the controllers.');
