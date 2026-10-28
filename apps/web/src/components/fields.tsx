import { DatePicker, Input, InputNumber, Select, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { api } from '../api/client.js';
import type { FieldDefinition, LinkLabels } from '../api/types.js';
import { formatDateTime, formatNumber, t } from '../state/i18n.js';
import { fieldLabel, recordLabel } from '../state/metadata.js';
import { isJsonPayload, JsonFieldValue } from './JsonValue.js';

const { Link } = Typography;

/** Reads `_linkLabels` off a row; `undefined` means the server did not resolve them. */
export function linkLabelsOf(row: { _linkLabels?: unknown } | undefined): LinkLabels | undefined {
  const value = row?._linkLabels;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as LinkLabels;
}

function enumOptions(field: FieldDefinition): string[] {
  return field.values ?? field.enum ?? [];
}

/** Resolves a linked record id to its display label (PLAN §40.2 relationship-aware fields). */
export function LinkValue({
  entity,
  id,
  label,
  resolve = true,
}: {
  entity: string;
  id: string;
  /** Label already resolved by the API; skips the per-record detail request. */
  label?: string | undefined;
  /** Whether a missing label should be fetched. A supplied (even empty) label map is authoritative. */
  resolve?: boolean;
}) {
  const [loaded, setLoaded] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!resolve || label !== undefined) return;
    let active = true;
    api
      .get(entity, id)
      .then((record) => {
        if (active) setLoaded(recordLabel(record));
      })
      .catch(() => {
        if (active) setLoaded(undefined);
      });
    return () => {
      active = false;
    };
  }, [entity, id, label, resolve]);

  return <RouterLink to={`/${entity}/${encodeURIComponent(id)}`}>{label ?? loaded ?? id}</RouterLink>;
}

/**
 * Read-mode rendering for every Alpha field type (PLAN §13 field registry).
 *
 * `variant` is the only difference between the record page and a list cell: a JSON payload is a
 * structured block on the record page and a one-line summary in a table cell.
 */
export function FieldValue({
  field,
  value,
  variant = 'detail',
  label,
  fieldName,
  linkLabels,
}: {
  field: FieldDefinition;
  value: unknown;
  variant?: 'detail' | 'inline';
  /** The field's resolved label; only the JSON payload renderer needs it. */
  label?: string;
  /** Metadata name of the field, used to look its link labels up. */
  fieldName?: string;
  /** Labels returned with the record; when present, link fields never fetch their target. */
  linkLabels?: LinkLabels | undefined;
}) {
  if (value === undefined || value === null || value === '') return <span style={{ color: 'var(--carocrm-c-8c8c8c)' }}>—</span>;

  // A JSON payload is never printed raw (PLAN §13): the payload's own structure is the layout.
  if (isJsonPayload(field.type, value)) {
    return <JsonFieldValue value={value} variant={variant} {...(label === undefined ? {} : { label })} />;
  }

  switch (field.type) {
    case 'bool':
      return <span>{value ? t('core.common.yes') : t('core.common.no')}</span>;
    case 'text':
      return <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{String(value)}</Typography.Paragraph>;
    case 'url':
      return (
        <Link href={String(value)} target="_blank" rel="noreferrer">
          {String(value)}
        </Link>
      );
    case 'email':
      return <Link href={`mailto:${String(value)}`}>{String(value)}</Link>;
    case 'currency':
    case 'int':
    case 'float':
    case 'decimal': {
      // Numbers render with the user's locale (PLAN §41.6); currency keeps its own symbol.
      const numeric = typeof value === 'number' ? value : Number(value);
      return <span>{Number.isNaN(numeric) ? String(value) : formatNumber(numeric)}</span>;
    }
    case 'date':
      return <span>{formatDateTime(String(value), false)}</span>;
    case 'datetime':
      return <span>{formatDateTime(String(value))}</span>;
    case 'password':
      return <span>{'••••••'}</span>;
    case 'enum':
      return <span className="carocrm-pill">{String(value)}</span>;
    case 'multiEnum': {
      const items = Array.isArray(value) ? value : [value];
      return (
        <span>
          {items.map((item) => (
            <span key={String(item)} className="carocrm-pill" style={{ marginRight: 4 }}>
              {String(item)}
            </span>
          ))}
        </span>
      );
    }
    case 'link':
    case 'linkOne':
    case 'foreign': {
      const target = field.entityKey;
      const id = String(value);
      if (!target) return <span>{id}</span>;
      const resolved = fieldName !== undefined ? linkLabels?.[fieldName]?.[id] : undefined;
      return <LinkValue entity={target} id={id} label={resolved} resolve={linkLabels === undefined} />;
    }
    case 'linkMultiple':
    case 'attachmentMultiple': {
      const ids = Array.isArray(value) ? value : [value];
      const target = field.entityKey;
      if (!target) return <span>{ids.map((id) => String(id)).join(', ')}</span>;
      return (
        <span>
          {ids.map((id) => (
            <span key={String(id)}>
              <LinkValue
                entity={target}
                id={String(id)}
                label={fieldName !== undefined ? linkLabels?.[fieldName]?.[String(id)] : undefined}
                resolve={linkLabels === undefined}
              />{' '}
            </span>
          ))}
        </span>
      );
    }
    default:
      return <span>{String(value)}</span>;
  }
}

/**
 * Option list for a link field, searched server-side (a workspace can hold far more
 * records than a single page, so client-side filtering alone is not enough).
 */
/** Options for a link field: server-side search so records beyond the first page stay selectable. */
export function useLinkOptions(entityName: string | undefined, term: string) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    if (!entityName) return;
    let active = true;
    const timer = setTimeout(() => {
      const where = term.trim() === '' ? undefined : [{ field: 'name', operator: 'contains', value: term.trim() }];
      api
        .list(entityName, { where, orderBy: '-createdAt', maxSize: 30, total: false })
        .then((result) => {
          if (active) setOptions(result.list.map((record) => ({ value: String(record['id']), label: recordLabel(record) })));
        })
        .catch(() => {
          if (active) setOptions([]);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [entityName, term]);

  return options;
}

interface EditorProps {
  fieldName: string;
  field: FieldDefinition;
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}

/** Write-mode control per field type — the generic EntityForm of PLAN §40.2. */
export function FieldEditor({ fieldName, field, value, disabled = false, onChange }: EditorProps) {
  const [term, setTerm] = useState('');
  const targetEntity = field.entityKey;
  const linkOptions = useLinkOptions(targetEntity, term);
  const options = useMemo(() => enumOptions(field), [field]);
  const placeholder = fieldLabel(fieldName, field);

  switch (field.type) {
    case 'text':
      return (
        <Input.TextArea rows={4} value={typeof value === 'string' ? value : ''} placeholder={placeholder} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      );
    case 'int':
    case 'float':
    case 'decimal':
    case 'currency':
      return (
        <InputNumber
          style={{ width: '100%' }}
          value={typeof value === 'number' ? value : null}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(next) => onChange(next ?? null)}
        />
      );
    case 'bool':
      return <Switch checked={value === true} disabled={disabled} onChange={(checked) => onChange(checked)} />;
    case 'date':
      return (
        <DatePicker
          style={{ width: '100%' }}
          value={typeof value === 'string' && value !== '' ? dayjs(value) : null}
          disabled={disabled}
          onChange={(_, text) => onChange(text === '' ? null : text)}
        />
      );
    case 'datetime':
      return (
        <DatePicker
          showTime
          style={{ width: '100%' }}
          value={typeof value === 'string' && value !== '' ? dayjs(value) : null}
          disabled={disabled}
          onChange={(_, text) => onChange(text === '' ? null : text)}
        />
      );
    case 'enum':
      return (
        <Select
          allowClear
          placeholder={placeholder}
          value={typeof value === 'string' && value !== '' ? value : undefined}
          disabled={disabled}
          options={options.map((item) => ({ value: item, label: item }))}
          onChange={(next) => onChange(next ?? null)}
        />
      );
    case 'multiEnum':
      return (
        <Select
          mode="multiple"
          allowClear
          placeholder={placeholder}
          value={Array.isArray(value) ? value.map(String) : []}
          disabled={disabled}
          options={options.map((item) => ({ value: item, label: item }))}
          onChange={(next) => onChange(next)}
        />
      );
    case 'link':
    case 'linkOne':
    case 'foreign':
      return (
        <Select
          showSearch
          allowClear
          filterOption={false}
          placeholder={placeholder}
          value={typeof value === 'string' && value !== '' ? value : undefined}
          disabled={disabled}
          options={linkOptions}
          onSearch={setTerm}
          onChange={(next) => {
            setTerm('');
            onChange(next ?? null);
          }}
        />
      );
    case 'linkMultiple':
    case 'attachmentMultiple':
      return (
        <Select
          mode="multiple"
          allowClear
          filterOption={false}
          placeholder={placeholder}
          value={Array.isArray(value) ? value.map(String) : []}
          disabled={disabled}
          options={linkOptions}
          onSearch={setTerm}
          onChange={(next) => {
            setTerm('');
            onChange(next);
          }}
        />
      );
    case 'password':
      return <Input.Password placeholder={placeholder} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'email':
      return <Input type="email" placeholder={placeholder} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'url':
      return <Input type="url" placeholder={placeholder} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    case 'phone':
      return <Input type="tel" placeholder={placeholder} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
    default:
      return (
        <Input
          placeholder={placeholder}
          maxLength={field.maxLength}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
