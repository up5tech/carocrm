import { EditOutlined, MoreOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Input, Space } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client.js';
import type { EntityDefinition, RowActions } from '../api/types.js';
import { t } from '../state/i18n.js';
import { fieldLabel, recordLabel } from '../state/metadata.js';
import { usePageTitle } from './PageHeader.js';
import { FieldValue, linkLabelsOf } from './fields.js';

export interface RecordHeaderProps {
  entity: string;
  id: string;
  definition: EntityDefinition | undefined;
  record: Record<string, unknown> | undefined;
  base: string;
  /** Refetch the record after a write from the header itself (the name, a delete). */
  onChanged: () => Promise<void> | void;
}

/**
 * The record page's sticky header (PLAN_Phase_20_Settings_UX.md §5.4).
 *
 * It keeps the record's identity in view while the page scrolls: the name (editable in place when
 * the caller may edit), the entity it belongs to, and the two fields a reader asks about first —
 * status and owner. The primary action sits next to it; everything else is behind the kebab.
 *
 * Every action comes from `POST /:entity/action/rowActions`, which the server answered from the
 * caller's ACL. A rep therefore never sees Edit on an entity their role only reads, and a record the
 * role scopes away still refuses the write with its own message.
 */
export function RecordHeader({ entity, id, definition, record, base, onChanged }: RecordHeaderProps) {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const [actions, setActions] = useState<RowActions | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .rowActions(entity)
      .then((next) => {
        if (active) setActions(next);
      })
      .catch(() => {
        if (active) setActions(null);
      });
    return () => {
      active = false;
    };
  }, [entity]);

  const displayField = definition?.record?.displayField ?? 'name';
  const name = recordLabel(record, definition);
  const nameField = definition?.fields[displayField];
  // Phase 20.24 (F5/F6): the record's name is the record page's `h1` — and the browser-tab title,
  // so five open records are five distinguishable tabs.
  usePageTitle(name);
  // A computed or non-text display field is not editable in place; the form still edits it.
  const nameEditable =
    actions?.edit === true &&
    nameField !== undefined &&
    ['varchar', 'text', 'email', 'url', 'phone'].includes(nameField.type);

  const meta = useMemo(() => {
    const out: { field: string; label: string; value: unknown }[] = [];
    for (const field of ['status', 'state', 'assignedUserId']) {
      const definitionField = definition?.fields[field];
      const value = record?.[field];
      if (definitionField === undefined || value === null || value === undefined || value === '') continue;
      out.push({ field, label: fieldLabel(field, definitionField), value });
    }
    return out;
  }, [definition, record]);

  const saveName = async (): Promise<void> => {
    const next = draft.trim();
    if (next === '' || next === name) {
      setEditing(false);
      return;
    }
    setSavingName(true);
    try {
      await api.update(entity, id, { [displayField]: next });
      await onChanged();
      setEditing(false);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.detail.nameSaveFailed'));
    } finally {
      setSavingName(false);
    }
  };

  const remove = (): void => {
    modal.confirm({
      title: t('web.detail.deleteThisRecord'),
      okText: t('web.detail.delete'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.remove(entity, id);
          void message.success(t('web.detail.deleted'));
          navigate(`${base}/${entity}`);
        } catch (error) {
          void message.error(error instanceof Error ? error.message : t('web.detail.deleteFailed'));
        }
      },
    });
  };

  const follow = async (): Promise<void> => {
    try {
      await api.follow(entity, id);
      void message.success(t('web.list.followed'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.list.followFailed'));
    }
  };

  const items: { key: string; label: string; danger?: boolean }[] = [];
  if (actions?.follow === true) items.push({ key: 'follow', label: t('web.list.rowFollow') });
  if (actions?.delete === true) items.push({ key: 'delete', label: t('web.detail.delete'), danger: true });

  return (
    <div className="carocrm-record-header">
      <div className="carocrm-record-header-main">
        <div className="carocrm-record-header-title">
          {editing ? (
            <h1 className="carocrm-record-header-name">
              <Input
                autoFocus
                size="small"
                value={draft}
                disabled={savingName}
                aria-label={t('web.detail.nameAria')}
                onChange={(event) => setDraft(event.target.value)}
                onPressEnter={() => void saveName()}
                onBlur={() => void saveName()}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(false);
                }}
              />
            </h1>
          ) : (
            // The record's name is the page's one `<h1>`. When the name is editable, the affordance
            // is the pencil button next to it (was: the whole text acted as a button — an h1 cannot
            // also be a button without its heading role being lost to assistive technology).
            <h1 className="carocrm-record-header-name">
              {name}
              {nameEditable ? (
                <Button
                  className="carocrm-record-header-rename"
                  type="text"
                  size="small"
                  aria-label={t('web.detail.renameHint')}
                  icon={<EditOutlined />}
                  onClick={() => {
                    setDraft(name);
                    setEditing(true);
                  }}
                />
              ) : null}
            </h1>
          )}
          <span className="carocrm-record-header-entity">{definition?.label ?? entity}</span>
        </div>
        {meta.length > 0 ? (
          <div className="carocrm-record-header-meta">
            {meta.map((entry) => (
              <span key={entry.field} className="carocrm-record-header-chip">
                <span className="carocrm-record-header-chip-label">{entry.label}</span>
                <FieldValue
                  field={definition?.fields[entry.field] ?? { type: 'varchar' }}
                  value={entry.value}
                  fieldName={entry.field}
                  variant="inline"
                  linkLabels={linkLabelsOf(record)}
                />
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <Space className="carocrm-record-header-actions" wrap>
        {actions?.edit === true ? (
          <Button type="primary" icon={<EditOutlined />} onClick={() => navigate(`${base}/${entity}/${id}/edit`)}>
            {t('web.detail.edit')}
          </Button>
        ) : null}
        {items.length > 0 ? (
          <Dropdown
            trigger={['click']}
            menu={{
              items,
              onClick: ({ key }) => {
                if (key === 'follow') void follow();
                else if (key === 'delete') remove();
              },
            }}
          >
            <Button icon={<MoreOutlined />} aria-label={t('web.detail.moreActions')} />
          </Dropdown>
        ) : null}
      </Space>
    </div>
  );
}
