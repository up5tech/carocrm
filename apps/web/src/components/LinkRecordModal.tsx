import { SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Input, Modal, Table, Tag } from 'antd';
import { useEffect, useState } from 'react';

import { api, type WhereClause } from '../api/client.js';
import type { EntityDefinition } from '../api/types.js';
import { t } from '../state/i18n.js';
import { recordLabel } from '../state/metadata.js';

const LINK_PAGE_SIZE = 10;

interface LinkRecordModalProps {
  open: boolean;
  parent: string;
  parentId: string;
  relation: string;
  targetEntity: string;
  targetDefinition: EntityDefinition | undefined;
  /** Records already in the relation; they stay listed but cannot be linked twice. */
  linkedIds: Set<string>;
  onClose: () => void;
  onLinked: () => Promise<void> | void;
}

/**
 * Pick an existing record to relate. A relation can point at any record in the workspace, so this
 * is a searched, paged list rather than a plain select box.
 */
export function LinkRecordModal({
  open,
  parent,
  parentId,
  relation,
  targetEntity,
  targetDefinition,
  linkedIds,
  onClose,
  onLinked,
}: LinkRecordModalProps) {
  const { message } = AntApp.useApp();
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const displayField = targetDefinition?.record?.displayField ?? 'name';
  const label = targetDefinition?.label ?? targetEntity;

  // Reopening starts a fresh search; the debounce below cancels any request from the old term.
  useEffect(() => {
    if (!open) return;
    setTerm('');
    setPage(1);
    setSelectedId(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const where: WhereClause | undefined =
        term.trim() === '' ? undefined : [{ field: displayField, operator: 'contains', value: term.trim() }];
      api
        .list(targetEntity, { where, orderBy: '-createdAt', offset: (page - 1) * LINK_PAGE_SIZE, maxSize: LINK_PAGE_SIZE, total: true })
        .then((result) => {
          if (!active) return;
          setRows(result.list);
          setTotal(result.total ?? result.list.length);
        })
        .catch((error) => {
          if (!active) return;
          setRows([]);
          setTotal(0);
          void message.error(error instanceof Error ? error.message : t('web.detail.linkFailed'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, targetEntity, displayField, term, page, message]);

  const submit = async (): Promise<void> => {
    if (selectedId === null) return;
    setLinking(true);
    try {
      await api.link(parent, parentId, relation, selectedId);
      void message.success(t('web.detail.linked'));
      await onLinked();
      onClose();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.detail.linkFailed'));
    } finally {
      setLinking(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('web.detail.linkExistingTitle', { entity: label })}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={t('web.detail.link')}
      okButtonProps={{ disabled: selectedId === null }}
      confirmLoading={linking}
      width={640}
      destroyOnHidden
    >
      <Input
        allowClear
        autoFocus
        prefix={<SearchOutlined />}
        placeholder={t('web.detail.linkSearch', { entity: label })}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setPage(1);
        }}
        style={{ marginBottom: 12 }}
      />
      <Table
        rowKey={(row) => String(row['id'])}
        size="small"
        loading={loading}
        dataSource={rows}
        columns={[
          {
            title: label,
            dataIndex: displayField,
            render: (_: unknown, row: Record<string, unknown>) => (
              <span>
                {recordLabel(row, targetDefinition)}
                {linkedIds.has(String(row['id'])) ? (
                  <Tag style={{ marginLeft: 8 }}>{t('web.detail.linkAlreadyLinked')}</Tag>
                ) : null}
              </span>
            ),
          },
        ]}
        rowSelection={{
          type: 'radio',
          selectedRowKeys: selectedId === null ? [] : [selectedId],
          onChange: (keys) => setSelectedId(keys.length > 0 ? String(keys[0]) : null),
          getCheckboxProps: (row) => ({ disabled: linkedIds.has(String(row['id'])) }),
        }}
        onRow={(row) => {
          const linked = linkedIds.has(String(row['id']));
          return {
            onClick: () => {
              if (!linked) setSelectedId(String(row['id']));
            },
            style: { cursor: linked ? 'not-allowed' : 'pointer' },
          };
        }}
        pagination={{
          current: page,
          pageSize: LINK_PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
        locale={{ emptyText: t('web.detail.linkNoResults') }}
      />
    </Modal>
  );
}
