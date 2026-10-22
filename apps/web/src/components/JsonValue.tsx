import { CopyOutlined, DownOutlined, EyeOutlined, UpOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Modal, Tooltip } from 'antd';
import { useMemo, useState } from 'react';

import { formatDateTime, formatNumber, t } from '../state/i18n.js';

/**
 * Structured rendering for a JSON payload held by a record field (PLAN §13).
 *
 * A `text` field may carry a frozen document snapshot, a tax breakdown, a health result — values
 * written by the server, not typed by a person. They used to fall through to `String(value)` and
 * printed one unreadable wall of JSON, which is a debugging view, not a record view. The payload is
 * opaque (any entity, any shape), so this renderer works from the shape alone: objects become
 * labelled rows, arrays of objects become a small table, arrays of values become chips. The raw
 * JSON stays one click away for whoever needs to copy it.
 *
 * Labels are humanised here rather than translated: `accountName` is a storage key, and a catalog
 * entry for every key of every payload would go stale the first time a snapshot changes shape.
 */

const MAX_TABLE_COLUMNS = 8;
const MAX_TABLE_ROWS = 6;
const MAX_CHIPS = 12;

/** Keys that name the payload, in the order a reader looks for them (list-column summary). */
const HEADLINE_KEYS = ['number', 'name', 'title', 'label', 'reference', 'code', 'subject', 'displayName', 'email'] as const;
const STATUS_KEYS = ['status', 'state', 'stage'] as const;
/** Values under these keys are states, so they read better as a pill than as plain text. */
const PILL_KEYS: ReadonlySet<string> = new Set(['status', 'state', 'kind', 'type', 'currency', 'priority']);
/** Kept upper-case when humanising a key (`accountId` → `Account ID`). */
const ACRONYMS: ReadonlySet<string> = new Set(['id', 'url', 'uri', 'sku', 'uuid', 'vat', 'json', 'api', 'http', 'https', 'csv', 'pdf', 'ip', 'crm', 'iso']);

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{32,}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type JsonPayload = Record<string, unknown> | unknown[];

/**
 * Field types that can hold a JSON payload. Server-computed `text` fields (a frozen document
 * snapshot, a tax breakdown) are the common case; `json` is accepted for forward compatibility.
 * A link/multi-enum field also carries an array, but that array is the field's own shape — `[]` on
 * a `linkMultiple` must not turn a relation into an empty payload block.
 */
const JSON_CAPABLE_TYPES: ReadonlySet<string> = new Set(['text', 'varchar', 'json', 'longText']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The payload behind a field value, or `undefined` when the value is not JSON.
 *
 * Accepts an already-decoded object (the API may hand one back) and a JSON *string*, which is how
 * a `text` field stores it. The cheap first-character test keeps ordinary text — the overwhelming
 * majority of `text` values — out of `JSON.parse`.
 */
export function parseJsonLike(value: unknown): JsonPayload | undefined {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length < 2) return undefined;
  const head = text[0];
  if (head !== '{' && head !== '[') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when this field's value is a JSON payload — one predicate for the renderer, the block
 *  layout and the list's inline-edit guard, so they can never disagree. */
export function isJsonPayload(fieldType: string, value: unknown): boolean {
  return JSON_CAPABLE_TYPES.has(fieldType) && parseJsonLike(value) !== undefined;
}

/** `capturedAt` / `captured_at` / `captured-at` → `Captured at`. */
function humanKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((word) => word !== '');
  return words
    .map((word, index) => {
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase();
    })
    .join(' ');
}

function firstScalar(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

interface PayloadSummary {
  readonly headline?: string;
  readonly status?: string;
  readonly count: string;
}

function summarize(payload: JsonPayload): PayloadSummary {
  if (Array.isArray(payload)) return { count: t('web.json.items', { count: payload.length }) };
  const headline = firstScalar(payload, HEADLINE_KEYS);
  const status = firstScalar(payload, STATUS_KEYS);
  return {
    ...(headline === undefined ? {} : { headline }),
    ...(status === undefined ? {} : { status }),
    count: t('web.json.fields', { count: Object.keys(payload).length }),
  };
}

/** One scalar cell: the value type decides the treatment, never the surrounding chrome. */
function JsonScalar({ value, pillKey }: { readonly value: unknown; readonly pillKey?: string }) {
  if (value === null || value === undefined) return <span className="carocrm-json-null">—</span>;
  if (typeof value === 'boolean') return <span>{value ? t('core.common.yes') : t('core.common.no')}</span>;
  if (typeof value === 'number') return <span>{formatNumber(value)}</span>;
  if (typeof value !== 'string') return <span>{String(value)}</span>;

  const text = value;
  if (text === '') return <span className="carocrm-json-null">—</span>;
  if (pillKey !== undefined && PILL_KEYS.has(pillKey) && text.length <= 24) return <span className="carocrm-pill">{text}</span>;
  if (ISO_DATETIME_RE.test(text)) return <span title={text}>{formatDateTime(text)}</span>;
  if (ISO_DATE_RE.test(text)) return <span title={text}>{formatDateTime(text, false)}</span>;
  if (URL_RE.test(text)) return <a href={text} target="_blank" rel="noreferrer">{text}</a>;
  if (EMAIL_RE.test(text)) return <a href={`mailto:${text}`}>{text}</a>;
  // An identifier is shown in full when it is a UUID, and shortened when it is a hash: nobody reads
  // 64 hex characters, but everybody can copy them from the tooltip.
  if (UUID_RE.test(text)) return <code className="carocrm-json-code" title={text}>{text}</code>;
  if (HASH_RE.test(text)) return <code className="carocrm-json-code" title={text}>{`${text.slice(0, 12)}…`}</code>;
  return <span className="carocrm-json-text">{text}</span>;
}

/** A nested object or array inside a table cell, compressed to what fits a row. */
function JsonCell({ value }: { readonly value: unknown }) {
  if (Array.isArray(value)) return <span className="carocrm-json-null">{t('web.json.items', { count: value.length })}</span>;
  if (isPlainObject(value)) return <span className="carocrm-json-null">{t('web.json.fields', { count: Object.keys(value).length })}</span>;
  return <JsonScalar value={value} />;
}

function JsonTable({ rows }: { readonly rows: readonly Record<string, unknown>[] }) {
  const [expanded, setExpanded] = useState(false);

  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [rows]);

  const shown = expanded ? rows : rows.slice(0, MAX_TABLE_ROWS);
  const capped = columns.slice(0, MAX_TABLE_COLUMNS);
  const hiddenColumns = columns.length - capped.length;
  const toggle = (
    <Button type="link" size="small" onClick={() => setExpanded((previous) => !previous)}>
      {expanded ? t('web.json.showLess') : t('web.json.showAll', { count: rows.length })}
    </Button>
  );

  return (
    <div className="carocrm-json-table-wrap">
      <table className="carocrm-json-table">
        <caption className="carocrm-json-caption">{t('web.json.items', { count: rows.length })}</caption>
        <thead>
          <tr>
            {capped.map((key) => (
              <th key={key} scope="col">{humanKey(key)}</th>
            ))}
            {hiddenColumns > 0 ? <th scope="col">{t('web.json.moreFields', { count: hiddenColumns })}</th> : null}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index}>
              {capped.map((key) => (
                <td key={key}><JsonCell value={row[key]} /></td>
              ))}
              {hiddenColumns > 0 ? <td><span className="carocrm-json-null">…</span></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS ? toggle : null}
    </div>
  );
}

function JsonArray({ value }: { readonly value: readonly unknown[] }) {
  const [expanded, setExpanded] = useState(false);

  if (value.length === 0) return <span className="carocrm-json-null">{t('web.json.empty')}</span>;
  // A list of records is a table; a list of values is a row of chips.
  if (value.every(isPlainObject)) return <JsonTable rows={value} />;

  const shown = expanded ? value : value.slice(0, MAX_CHIPS);
  return (
    <div className="carocrm-json-chips">
      {shown.map((item, index) => (
        <span className="carocrm-json-chip" key={index}>
          <JsonScalar value={item} />
        </span>
      ))}
      {value.length > MAX_CHIPS ? (
        <Button type="link" size="small" onClick={() => setExpanded((previous) => !previous)}>
          {expanded ? t('web.json.showLess') : t('web.json.showAll', { count: value.length })}
        </Button>
      ) : null}
    </div>
  );
}

function JsonBody({ value, depth }: { readonly value: unknown; readonly depth: number }) {
  if (Array.isArray(value)) return <JsonArray value={value} />;
  if (!isPlainObject(value)) return <JsonScalar value={value} />;

  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="carocrm-json-null">{t('web.json.empty')}</span>;
  return (
    <dl className={depth === 0 ? 'carocrm-json-rows' : 'carocrm-json-rows carocrm-json-rows--nested'}>
      {entries.map(([key, child]) => (
        <div className="carocrm-json-row" key={key}>
          <dt className="carocrm-json-key" title={key}>{humanKey(key)}</dt>
          <dd className="carocrm-json-value">
            {isPlainObject(child) || Array.isArray(child) ? <JsonBody value={child} depth={depth + 1} /> : <JsonScalar value={child} pillKey={key} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The field renderer for a JSON payload.
 *
 * `inline` is the list/board cell: a summary built from the payload's own headline key (an invoice
 * number, a name) so the column stays readable, with the size as the fallback.
 *
 * `detail` is the record page and starts as **one line** — a payload is reference material, not a
 * value a reader scans, so it must not push the fields below it off the screen. Two ways in: the
 * eye opens it in a panel of its own (the comfortable place to read a long document), the chevron
 * expands it under the line (the quick look, height-capped so the page keeps its shape).
 */
export function JsonFieldValue({
  value,
  variant = 'detail',
  label,
}: {
  readonly value: unknown;
  readonly variant?: 'detail' | 'inline';
  /** The field's own label, so the block header names what the payload is. */
  readonly label?: string;
}) {
  const { message } = AntApp.useApp();
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [raw, setRaw] = useState(false);

  const payload = useMemo(() => parseJsonLike(value), [value]);
  const text = useMemo(() => JSON.stringify(payload ?? value, null, 2) ?? '', [payload, value]);
  const summary = useMemo(() => (payload === undefined ? undefined : summarize(payload)), [payload]);

  if (payload === undefined || summary === undefined) return null;

  if (variant === 'inline') {
    return (
      <span className="carocrm-json-inline">
        {summary.headline === undefined ? (
          <span className="carocrm-json-inline-count">{summary.count}</span>
        ) : (
          <span className="carocrm-json-inline-text">{summary.headline}</span>
        )}
        {summary.status === undefined ? null : <span className="carocrm-pill">{summary.status}</span>}
      </span>
    );
  }

  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => message.success(t('web.json.copied')))
      .catch(() => message.error(t('web.json.copyFailed')));
  };
  const rawToggle = (
    <Button size="small" type="text" aria-pressed={raw} onClick={() => setRaw((previous) => !previous)}>
      {raw ? t('web.json.structured') : t('web.json.raw')}
    </Button>
  );
  const copyButton = (withLabel: boolean) => (
    <Tooltip title={t('web.json.copy')}>
      <Button size="small" type="text" icon={<CopyOutlined />} aria-label={t('web.json.copy')} onClick={copy}>
        {withLabel ? t('web.json.copy') : null}
      </Button>
    </Tooltip>
  );

  return (
    <div className="carocrm-json">
      <div className="carocrm-json-bar">
        {label === undefined ? null : <span className="carocrm-json-title">{label}</span>}
        <span className="carocrm-json-badge">JSON</span>
        <span className="carocrm-json-count">{summary.count}</span>
        <span className="carocrm-json-actions">
          <Tooltip title={t('web.json.open')}>
            <Button size="small" type="text" icon={<EyeOutlined />} aria-label={t('web.json.open')} onClick={() => setModalOpen(true)} />
          </Tooltip>
          <Tooltip title={expanded ? t('web.json.collapse') : t('web.json.expand')}>
            <Button
              size="small"
              type="text"
              icon={expanded ? <UpOutlined /> : <DownOutlined />}
              aria-expanded={expanded}
              aria-label={expanded ? t('web.json.collapse') : t('web.json.expand')}
              onClick={() => setExpanded((previous) => !previous)}
            />
          </Tooltip>
          {copyButton(false)}
        </span>
      </div>

      {expanded ? (
        <div className="carocrm-json-body">
          <JsonBody value={payload} depth={0} />
        </div>
      ) : null}

      <Modal
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        width={1000}
        footer={null}
        destroyOnHidden
        title={
          <span className="carocrm-json-modal-title">
            {label ?? t('web.json.badge')}
            <span className="carocrm-json-badge">JSON</span>
            <span className="carocrm-json-count">{summary.count}</span>
          </span>
        }
      >
        <div className="carocrm-json-modal-toolbar">
          <span className="carocrm-json-actions">
            {rawToggle}
            {copyButton(true)}
          </span>
        </div>
        {raw ? <pre className="carocrm-json-raw carocrm-json-raw--modal">{text}</pre> : (
          <div className="carocrm-json-body carocrm-json-body--modal">
            <JsonBody value={payload} depth={0} />
          </div>
        )}
      </Modal>
    </div>
  );
}
