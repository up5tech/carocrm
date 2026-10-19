import { App as AntApp, Card, Select, Space, Typography } from 'antd';
import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import { LayoutEditor, type LayoutEditorState } from '../../components/LayoutEditor.js';
import { t } from '../../state/i18n.js';
import { useMetadata } from '../../state/metadata.js';
import { usePublishTabActions } from '../shell.js';

/**
 * Layout tab (PLAN_Phase_20_Settings_UX.md §4.3 row 3, §20.8): the per-entity layout manager hosted in
 * the settings shell. The editor itself is the same component the Entity Manager uses — one editing
 * behavior, two hosts — and its draft is reported to the shell, so Save/Discard/dirty guard come from
 * the shared save bar instead of a second button row.
 */
export function LayoutSettingsTab() {
  const { message, modal } = AntApp.useApp();
  const metadata = useMetadata();
  const [searchParams, setSearchParams] = useSearchParams();
  const entityName = searchParams.get('entity') ?? undefined;
  const entity = entityName === undefined ? undefined : metadata.data?.[entityName];
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The editor reports its draft every render; the actions live in a ref because they are called, not
  // rendered, and storing them in state would re-render this tab on every keystroke of the editor.
  const editor = useRef<LayoutEditorState | null>(null);

  const handleState = useCallback((state: LayoutEditorState) => {
    setDirty(state.dirty);
    editor.current = state;
  }, []);

  const save = useCallback(
    async (body: Record<string, unknown>, okText: string) => {
      if (entityName === undefined) return;
      setSaving(true);
      try {
        await api.patchEntity(entityName, body);
        void message.success(okText);
        await metadata.refetch();
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.adminLayout.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [entityName, message, metadata],
  );

  usePublishTabActions({
    dirty,
    saving,
    canSave: entity !== undefined,
    onSave: () => editor.current?.persist(),
    onDiscard: () => editor.current?.reset(),
    onReload: () => void metadata.refetch(),
  });

  const pickEntity = (name: string | undefined) => {
    const leave = () => {
      const next = new URLSearchParams(searchParams);
      if (name === undefined) next.delete('entity');
      else next.set('entity', name);
      setSearchParams(next, { replace: true });
    };
    // Switching entity abandons the draft of the one being edited — same rule as the rail guard.
    if (!dirty) {
      leave();
      return;
    }
    modal.confirm({
      title: t('web.adminShell.unsavedTitle'),
      content: t('web.adminShell.unsavedBody'),
      okText: t('web.adminShell.leave'),
      cancelText: t('core.common.cancel'),
      onOk: leave,
    });
  };

  const entities = Object.values(metadata.data ?? {})
    .filter((candidate) => candidate.isEntity && candidate.client?.web !== false)
    .sort((left, right) => left.label.localeCompare(right.label));

  return (
    <div className="carocrm-admin-form">
      <Card className="carocrm-card" title={t('web.adminLayout.entityTitle')}>
        <Space wrap size={12} align="center">
          <Select
            showSearch
            optionFilterProp="label"
            allowClear
            className="carocrm-admin-entity-picker"
            aria-label={t('web.adminLayout.entityAria')}
            placeholder={t('web.adminLayout.entityPlaceholder')}
            value={entityName}
            onChange={(value) => pickEntity(value)}
            options={entities.map((candidate) => ({ value: candidate.name, label: candidate.label }))}
          />
          {entity !== undefined ? (
            <Typography.Text type="secondary">{t('web.adminLayout.changesRender', { name: entity.label })}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">{t('web.adminLayout.pickEntity')}</Typography.Text>
          )}
        </Space>
      </Card>
      {entity !== undefined ? (
        <Card className="carocrm-card" title={t('web.adminLayout.editorTitle', { name: entity.label })}>
          <LayoutEditor key={entity.name} entity={entity} save={save} showInlineActions={false} onState={handleState} />
        </Card>
      ) : null}
    </div>
  );
}
