#!/usr/bin/env node
/**
 * Phase 24.4 — typed client generator.
 *
 * Reads the schema-backed entries of the `api-spec/` registry (endpoints carrying `operationId`
 * plus `requestSchema`/`responseSchema` references to versioned JSON Schema documents under
 * `api-spec/schemas/`) and emits `packages/api-client/src/generated.ts`: TypeScript types plus a
 * typed `createApiClient` transport wrapper.
 *
 * The generator is deliberately strict: an operationId without resolvable schemas, a path with
 * parameters (not supported by the v1 emitter), an unknown JSON Schema keyword or an unresolvable
 * $ref fails generation — it never falls back to `any` or to the prose `request`/`response` fields.
 *
 * Usage:
 *   node scripts/generate-api-client.mjs          # write packages/api-client/src/generated.ts
 *   node scripts/generate-api-client.mjs --check  # fail when the committed file is stale
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = join(ROOT, 'api-spec');
const OUT_FILE = join(ROOT, 'packages/api-client/src/generated.ts');
const CHECK = process.argv.includes('--check');

const ALLOWED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'enum', 'anyOf', 'oneOf', '$ref',
  'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'format', 'default',
  'examples', 'deprecated', 'readOnly', 'writeOnly',
]);

function fail(message) {
  console.error(`generate-api-client: ${message}`);
  process.exit(1);
}

/** Loads the parsed registry from the checker's --print mode (JSON followed by summary lines). */
function documentedEndpoints() {
  const out = execFileSync('node', ['scripts/check-api-spec.mjs', '--print'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const end = out.indexOf('\napi-spec:');
  return JSON.parse(end === -1 ? out : out.slice(0, end));
}

const schemaCache = new Map();

/** Splits `file.json#/path` into file and fragment; bare `#/path` stays in the current document. */
function splitRef(ref, fromFile) {
  const hash = ref.indexOf('#');
  if (hash === -1) return { file: ref, fragment: '' };
  const filePart = ref.slice(0, hash);
  const fragment = ref.slice(hash + 1);
  return { file: filePart === '' ? fromFile : filePart, fragment };
}

function loadJson(path) {
  if (!existsSync(path)) fail(`schema file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`schema file is not valid JSON: ${path} (${String(error)})`);
  }
}

function resolveFragment(doc, fragment) {
  if (fragment === '') return doc;
  if (!fragment.startsWith('/')) fail(`unsupported $ref fragment "${fragment}" (only JSON pointers are supported)`);
  let node = doc;
  for (const raw of fragment.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) {
      fail(`unresolvable $ref fragment "${fragment}"`);
    }
    node = node[key];
  }
  return node;
}

/** Returns { file, doc, node, defKey } for a schema reference like `schemas/x.v1.json` or `...#/$defs/Y`. */
function resolveSchemaRef(ref, fromFile) {
  const { file, fragment } = splitRef(ref, fromFile);
  let abs;
  if (file === '') abs = fromFile;
  else if (file.startsWith('/')) abs = file;
  else if (file.startsWith('schemas/')) abs = join(SPEC_DIR, file);
  else abs = join(dirname(fromFile), file);
  if (!schemaCache.has(abs)) schemaCache.set(abs, loadJson(abs));
  const doc = schemaCache.get(abs);
  const parts = fragment === '' ? [] : fragment.slice(1).split('/');
  const defKey = parts.length === 2 && parts[0] === '$defs' ? parts[1] : null;
  return { file: abs, doc, node: resolveFragment(doc, fragment), defKey };
}

function checkKeywords(node, where) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) fail(`${where}: unsupported JSON Schema keyword "${key}"`);
  }
}

/** Collects every schema document reachable from an operation's refs, keyed by emitted type name. */
const emittedTypes = new Map(); // name -> ts type source
const emittedDefs = new Set();

function emitType(schemaNode, refFile, depth = 0) {
  if (depth > 24) fail('schema nesting too deep (possible $ref cycle)');
  checkKeywords(schemaNode, refFile);
  if (typeof schemaNode.$ref === 'string') {
    const target = resolveSchemaRef(schemaNode.$ref, refFile);
    return refTypeName(target.node, target);
  }
  if (Array.isArray(schemaNode.anyOf) || Array.isArray(schemaNode.oneOf)) {
    const variants = (schemaNode.anyOf ?? schemaNode.oneOf).map((v) => emitType(v, refFile, depth + 1));
    return [...new Set(variants)].join(' | ');
  }
  const type = schemaNode.type;
  if (Array.isArray(type)) {
    const parts = type.map((t) => emitType({ ...schemaNode, type: t }, refFile, depth + 1));
    return [...new Set(parts)].join(' | ');
  }
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      if (!schemaNode.items || typeof schemaNode.items !== 'object') fail(`${refFile}: array schema requires "items"`);
      return `${emitType(schemaNode.items, refFile, depth + 1)}[]`;
    }
    case 'object': {
      const props = schemaNode.properties ?? {};
      const required = new Set(schemaNode.required ?? []);
      const members = Object.entries(props).map(([key, sub]) => {
        const optional = required.has(key) ? '' : '?';
        const ts = emitType(sub, refFile, depth + 1);
        return `  ${JSON.stringify(key)}${optional}: ${ts};`;
      });
      const additional = schemaNode.additionalProperties;
      if (additional !== undefined && additional !== false && additional !== true) {
        members.push(`  [key: string]: ${emitType(additional, refFile, depth + 1)};`);
      }
      return `{\n${members.join('\n')}\n}`;
    }
    default:
      fail(`${refFile}: schema node has no supported "type" (got ${JSON.stringify(type)})`);
  }
}

/** Registers a named type for a $ref target and returns its TS name. */
function refTypeName(node, target) {
  const { file, doc, defKey } = target;
  let name;
  let schemaForName = node;
  if (defKey !== null) {
    // A #/$defs/<Key> target is named by its def key.
    name = defKey;
    schemaForName = node;
  } else if (node && typeof node === 'object' && node.title && /^[A-Z]/.test(node.title)) {
    name = node.title;
  } else {
    const base = doc && typeof doc.title === 'string' && /^[A-Z]/.test(doc.title)
      ? doc.title
      : file.split('/').pop().replace(/\.json$/, '').replace(/\.v\d+$/, '').replace(/(^|\.)([a-z])/g, (_, _d, c) => c.toUpperCase()).replace(/\./g, '');
    name = `${base}Ref`;
    schemaForName = doc ?? node;
  }
  if (!emittedTypes.has(name)) {
    if (emittedTypes.size > 400) fail('too many types (cycle?)');
    emittedTypes.set(name, null); // reserve before recursing
    emittedTypes.set(name, emitNamedType(schemaForName, file));
  }
  return name;
}

function emitNamedType(schemaNode, file) {
  if (schemaNode.type === 'object' || (schemaNode.properties && !schemaNode.type)) {
    const props = schemaNode.properties ?? {};
    const required = new Set(schemaNode.required ?? []);
    const members = Object.entries(props).map(([key, sub]) => {
      const optional = required.has(key) ? '' : '?';
      return `  ${JSON.stringify(key)}${optional}: ${emitType(sub, file)};`;
    });
    const additional = schemaNode.additionalProperties;
    if (additional !== undefined && additional !== false && additional !== true) {
      members.push(`  [key: string]: ${emitType(additional, file)};`);
    }
    return `{\n${members.join('\n')}\n}`;
  }
  return emitType(schemaNode, file);
}

/** Emits a root document's $defs as named types (called for every doc we touch). */
function emitDefs(doc, file) {
  const defs = doc.$defs ?? {};
  for (const [key, sub] of Object.entries(defs)) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) fail(`${file}: $defs key "${key}" is not a valid TypeScript type name`);
    if (!emittedTypes.has(key)) {
      emittedTypes.set(key, null);
      emittedTypes.set(key, emitNamedType(sub, file));
    }
    emittedDefs.add(key);
  }
}

function operationMethodName(operationId) {
  const parts = operationId.split(/[._\-/]+/).filter(Boolean);
  if (parts.length === 0) fail(`invalid operationId "${operationId}"`);
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

const endpoints = documentedEndpoints().filter((e) => typeof e.operationId === 'string' && e.operationId !== '');
if (endpoints.length === 0) fail('no endpoints carry operationId — nothing to generate');

const operations = [];
for (const ep of endpoints) {
  if (ep.path.includes(':')) fail(`${ep.operationId}: path parameters are not supported by the v1 client emitter (${ep.method} ${ep.path})`);
  const requestType = ep.requestSchema ? resolveRootType(ep.requestSchema, `${ep.operationId} request`) : null;
  const responseType = ep.responseSchema ? resolveRootType(ep.responseSchema, `${ep.operationId} response`).name : 'unknown';
  // A request schema with no required properties means the body itself is optional (for example the
  // refresh/logout cookie fallback), so the generated method takes `body?`.
  const requestOptional = requestType !== null && requestType.required === false;
  operations.push({
    operationId: ep.operationId,
    method: ep.method,
    path: ep.path,
    requestType: requestType === null ? null : requestType.name,
    requestOptional,
    responseType,
    auth: ep.auth,
  });
}

function resolveRootType(ref, label) {
  const { file, doc, node } = resolveSchemaRef(ref, join(SPEC_DIR, 'schemas/placeholder'));
  emitDefs(doc, file);
  const rootNode = node === doc ? doc : node;
  const required = Array.isArray(rootNode.required) && rootNode.required.length > 0;
  // Untitled root: emit inline via a synthesized name.
  const title = typeof doc.title === 'string' && /^[A-Z]/.test(doc.title) ? doc.title : null;
  const name = title ?? `${label.replace(/[^A-Za-z0-9]/g, '')}Type`;
  if (!emittedTypes.has(name)) {
    emittedTypes.set(name, null);
    emittedTypes.set(name, emitNamedType(rootNode, file));
  }
  return { name, required };
}

// Emit all collected types sorted by name for deterministic output.
const typeLines = [...emittedTypes.entries()]
  .filter(([, source]) => source !== null)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, source]) => `export type ${name} = ${source};\n`);

const seenMethods = new Set();
const clientLines = [];
const operationEntries = [];
for (const op of operations) {
  const methodName = operationMethodName(op.operationId);
  if (seenMethods.has(methodName)) fail(`operationId collision: "${op.operationId}" and another operation both map to "${methodName}"`);
  seenMethods.add(methodName);
  const args = op.requestType ? `body${op.requestOptional ? '?' : ''}: ${op.requestType}` : '';
  clientLines.push(`  readonly ${methodName}: (${args}) => Promise<${op.responseType}>;`);
  operationEntries.push(
    `  { operationId: ${JSON.stringify(op.operationId)}, method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, requestType: ${op.requestType ? JSON.stringify(op.requestType) : 'null'}, responseType: ${JSON.stringify(op.responseType)}, auth: ${JSON.stringify(op.auth)} },`,
  );
  const callArgs = op.requestType ? ', body' : '';
  clientLines.push(`    ${methodName}: (${args}) => transport.request<${op.responseType}>({ method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}${callArgs} }),`);
}

const generated = `// GENERATED FILE — do not edit. Regenerate with: node scripts/generate-api-client.mjs
// Source: api-spec/*.yaml entries carrying operationId + requestSchema/responseSchema.
// Phase 24.4 (PLAN_Phase_24_Product_Completion.md §10): the schema-backed canonical contract.

export interface ApiTransport {
  request<TResponse = unknown>(options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<TResponse>;
}

${typeLines.join('\n')}
export interface CaroCrmApiOperations {
${clientLines.filter((l) => l.startsWith('  readonly')).join('\n')}
}

export const API_OPERATIONS = [
${operationEntries.join('\n')}
] as const;

export type ApiOperationId = (typeof API_OPERATIONS)[number]['operationId'];

export function createApiClient(transport: ApiTransport): CaroCrmApiOperations {
  return {
${clientLines.filter((l) => l.startsWith('    ')).join('\n')}
  };
}
`;

if (CHECK) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== generated) {
    console.error('generate-api-client: packages/api-client/src/generated.ts is stale — run `node scripts/generate-api-client.mjs`');
    process.exit(1);
  }
  console.log(`generate-api-client: ${String(operations.length)} operations, generated.ts is up to date`);
} else {
  writeFileSync(OUT_FILE, generated);
  console.log(`generate-api-client: wrote ${String(operations.length)} operations to packages/api-client/src/generated.ts`);
}
