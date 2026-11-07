import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Divider, Form, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';

export interface CRMChatSettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Phase 19-CHAT.31 — the administrator settings modal, extracted from `CRMChatPage` unchanged.
 *
 * The assistant is an AI Agent profile key, not a credential: the picker lists the published
 * profiles so an administrator chooses one instead of typing a key from memory. The stored value
 * stays the key.
 */
export function CRMChatSettingsModal(props: CRMChatSettingsModalProps) {
  const { open, onClose } = props;

  const queryClient = useQueryClient();
  const [assistantKey, setAssistantKey] = useState('');
  const [executionMode, setExecutionMode] = useState<'queue' | 'inline'>('queue');

  const settingsQuery = useQuery({
    queryKey: ['crmChat', 'settings'],
    queryFn: () => api.crmChatSettings(),
    enabled: open,
    staleTime: 15_000,
    retry: false,
  });

  useEffect(() => {
    const settings = settingsQuery.data?.settings as
      | { assistant?: { agentKey?: string }; execution?: { mode?: string } }
      | undefined;
    const key = settings?.assistant?.agentKey;
    if (typeof key === 'string') setAssistantKey(key);
    if (settings?.execution?.mode === 'inline' || settings?.execution?.mode === 'queue') {
      setExecutionMode(settings.execution.mode);
    }
  }, [settingsQuery.data]);

  // The assistant is an AI Agent profile key, not a credential: list the published profiles so an
  // administrator picks one instead of typing a key from memory. The stored value stays the key.
  const assistantAgents = useQuery({
    queryKey: ['crmChat', 'assistantAgents'],
    queryFn: () => api.aiAgentsAgents({ status: 'published', maxSize: 50 }),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });

  const agentOptions = (assistantAgents.data?.list ?? []).map((agent) => ({
    value: agent.key,
    label: `${agent.name} (${agent.key})`,
  }));
  // A configured key may no longer be published (or readable); keep it selectable so saving another
  // field never silently clears the current assistant.
  if (assistantKey !== '' && !agentOptions.some((option) => option.value === assistantKey)) {
    agentOptions.unshift({ value: assistantKey, label: assistantKey });
  }

  const saveSettings = useMutation({
    mutationFn: () =>
      api.crmChatUpdateSettings({
        assistant: { agentKey: assistantKey.trim() },
        execution: { mode: executionMode },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crmChat'] });
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      title={t('web.crmChat.settingsTitle')}
      onCancel={onClose}
      onOk={() => void saveSettings.mutate()}
      confirmLoading={saveSettings.isPending}
    >
      <Form layout="vertical">
        {assistantAgents.isError ? (
          <Alert
            type="error"
            showIcon
            message={t('web.crmChat.agentListFailed')}
            style={{ marginBottom: 12 }}
          />
        ) : null}
        <Form.Item label={t('web.crmChat.agentFieldLabel')}>
          {assistantAgents.isError ? (
            // A Chat administrator without AI Agents read access can still set the key by hand;
            // the picker stays the default path whenever the list is readable.
            <Input
              value={assistantKey}
              onChange={(event) => setAssistantKey(event.target.value)}
              placeholder={t('web.crmChat.agentKeyInputPlaceholder')}
            />
          ) : (
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              loading={assistantAgents.isLoading}
              placeholder={t('web.crmChat.agentFieldPlaceholder')}
              value={assistantKey === '' ? undefined : assistantKey}
              options={agentOptions}
              onChange={(value?: string) => setAssistantKey(value ?? '')}
              notFoundContent={
                assistantAgents.isLoading ? undefined : t('web.crmChat.agentFieldEmpty')
              }
            />
          )}
        </Form.Item>
        {settingsQuery.data?.warnings?.length ? (
          <Alert type="warning" showIcon message={settingsQuery.data.warnings.map((w) => w.message).join('; ')} />
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.crmChat.agentFieldHint')}
        </Typography.Text>
        <Divider style={{ margin: '16px 0' }} />
        <Form.Item label={t('web.crmChat.executionFieldLabel')}>
          <Radio.Group
            value={executionMode}
            onChange={(event) => setExecutionMode(event.target.value as 'queue' | 'inline')}
          >
            <Space direction="vertical" size={4}>
              <Radio value="queue">{t('web.crmChat.executionQueue')}</Radio>
              <Radio value="inline">{t('web.crmChat.executionInline')}</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('web.crmChat.executionHint')}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
