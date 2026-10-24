import { Modal, Select, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';
import { type FieldEntry,fieldLabel } from '../state/metadata.js';
import { FieldEditor } from './fields.js';

export interface BulkEditModalProps {
  open: boolean;
  /**
   * `update` sets one plain field on every selected record; `assign` sets the record owner and uses
   * the assignee lookup rather than a free-form link, because a record id typed into a box is not a
   * picker.
   */
  mode: 'update' | 'assign';
  /** Candidates for `update`; for `assign` the single owner field the entity actually declares. */
  fields: FieldEntry[];
  busy: boolean;
  onClose: () => void;
  /** One key: the field the administrator chose and the value to write. */
  onSubmit: (values: Record<string, unknown>) => void;
}

/**
 * The value chooser behind the bulk bar (PLAN_Phase_20_Settings_UX.md §5.3). It reuses `FieldEditor`
 * so a bulk write accepts exactly what the record form accepts — the same enum options, the same
 * date format, the same validation — instead of a second editor that can drift.
 */
export function BulkEditModal({ open, mode, fields, busy, onClose, onSubmit }: BulkEditModalProps) {
  const [fieldName, setFieldName] = useState('');
  const [value, setValue] = useState<unknown>(undefined);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);

  const entry = fields.find((candidate) => candidate.name === fieldName) ?? fields[0];

  // Every opening starts clean: the previous field's value must never leak into the next write.
  useEffect(() => {
    if (!open) return;
    setFieldName(fields[0]?.name ?? '');
    setValue(undefined);
  }, [open, fields]);

  // The assignee picker is searched on the server; the list is capped and ordered by user name.
  useEffect(() => {
    if (!open || mode !== 'assign') return;
    let active = true;
    setPeopleLoading(true);
    api
      .assignableUsers()
      .then((result) => {
        if (active) setPeople(result.list);
      })
      .catch(() => {
        if (active) setPeople([]);
      })
      .finally(() => {
        if (active) setPeopleLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, mode]);

  const submitDisabled =
    entry === undefined ||
    value === undefined ||
    (mode === 'assign' && (typeof value !== 'string' || value === ''));

  const submit = (): void => {
    if (entry === undefined || submitDisabled) return;
    onSubmit({ [entry.name]: value });
  };

  return (
    <Modal
      open={open}
      title={mode === 'assign' ? t('web.list.assignTitle') : t('web.list.bulkEditTitle')}
      okText={mode === 'assign' ? t('web.list.assignAction') : t('web.list.bulkApply')}
      cancelText={t('core.common.cancel')}
      confirmLoading={busy}
      okButtonProps={{ disabled: submitDisabled }}
      onOk={submit}
      onCancel={onClose}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t('web.list.bulkEditHint')}</Typography.Paragraph>
      {mode === 'update' && fields.length > 1 ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text className="carocrm-filter-label">{t('web.list.bulkField')}</Typography.Text>
          <Select
            style={{ width: '100%' }}
            aria-label={t('web.list.bulkField')}
            value={entry?.name}
            options={fields.map((candidate) => ({ value: candidate.name, label: fieldLabel(candidate.name, candidate.field) }))}
            onChange={(next) => {
              if (typeof next === 'string') setFieldName(next);
              setValue(undefined);
            }}
          />
        </div>
      ) : null}
      {entry === undefined ? (
        <Typography.Text type="secondary">{t('web.list.bulkNoFields')}</Typography.Text>
      ) : mode === 'assign' ? (
        <Select
          style={{ width: '100%' }}
          showSearch
          aria-label={t('web.list.assignTo')}
          placeholder={t('web.list.assignTo')}
          loading={peopleLoading}
          value={typeof value === 'string' && value !== '' ? value : undefined}
          options={people.map((person) => ({ value: person.id, label: person.name }))}
          filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          onChange={(next) => setValue(next)}
        />
      ) : (
        <FieldEditor
          fieldName={entry.name}
          field={entry.field}
          value={value}
          onChange={(next) => setValue(next)}
        />
      )}
    </Modal>
  );
}
