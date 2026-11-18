import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentSkillView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { t } from '../../state/i18n.js';
import { errorText } from './AIAgentsAgentsTab.js';
import { formatTimestamp } from './shared.js';

/**
 * Phase 25.4 — reusable versioned skills.
 *
 * A skill is a bounded text instruction record, never code. Drafts can be edited, publication
 * freezes one version, and a later edit creates the next version. The agent editor binds published
 * versions by exact key/version, so this screen never changes an already published agent.
 */

const MAX_LABEL = 120;
const MAX_DESCRIPTION = 300;
const MAX_INSTRUCTIONS = 4_000;

interface SkillFormValues {
  key: string;
  label: string;
  description?: string;
  instructions: string;
  visibility: 'private' | 'team' | 'organization';
}

function StatusTag({ status }: { readonly status: AIAgentSkillView['status'] }) {
  const color = status === 'published' ? 'green' : status === 'draft' ? 'blue' : 'default';
  return <Tag color={color}>{t(`web.aiAgents.skillStatus_${status}`)}</Tag>;
}

export function AIAgentsSkillsTab() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AIAgentSkillView | undefined>(undefined);
  const [publishTarget, setPublishTarget] = useState<AIAgentSkillView | undefined>(undefined);
  const [publishNote, setPublishNote] = useState('');
  const [form] = Form.useForm<SkillFormValues>();

  const skills = useQuery({
    queryKey: ['aiAgents', 'skills', status, search],
    queryFn: () =>
      api.aiAgentsSkills({
        maxSize: 50,
        ...(status === undefined ? {} : { status }),
        ...(search.trim() === '' ? {} : { q: search.trim() }),
      }),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'skills'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'agentValidation'] });
  };

  useEffect(() => {
    if (!editorOpen) return;
    form.setFieldsValue({
      key: editing?.key ?? '',
      label: editing?.label ?? '',
      description: editing?.description ?? '',
      instructions: editing?.instructions ?? '',
      visibility: (editing?.visibility as SkillFormValues['visibility'] | undefined) ?? 'team',
    });
  }, [editorOpen, editing, form]);

  const save = useMutation({
    mutationFn: async (values: SkillFormValues) => {
      const input = {
        label: values.label.trim(),
        ...(values.description === undefined || values.description.trim() === ''
          ? {}
          : { description: values.description.trim() }),
        instructions: values.instructions,
        visibility: values.visibility,
      };
      if (editing === undefined) {
        return api.aiAgentsCreateSkill({ key: values.key.trim(), ...input });
      }
      return api.aiAgentsUpdateSkill(editing.key, editing.version, input);
    },
    onSuccess: (skill) => {
      void message.success(
        editing === undefined
          ? t('web.aiAgents.skillDraftCreated', { version: skill.version })
          : t('web.aiAgents.skillDraftSaved', { version: skill.version }),
      );
      setEditorOpen(false);
      setEditing(undefined);
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error), 8),
  });

  const publish = useMutation({
    mutationFn: () =>
      api.aiAgentsPublishSkill(
        publishTarget?.key ?? '',
        publishTarget?.version ?? 1,
        publishNote.trim() === '' ? undefined : publishNote.trim(),
      ),
    onSuccess: (skill) => {
      void message.success(t('web.aiAgents.skillPublished', { version: skill.version }));
      setPublishTarget(undefined);
      setPublishNote('');
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error), 8),
  });

  const archive = useMutation({
    mutationFn: (skill: AIAgentSkillView) => api.aiAgentsArchiveSkill(skill.key, skill.version),
    onSuccess: (skill) => {
      void message.success(t('web.aiAgents.skillArchived', { version: skill.version }));
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error), 8),
  });

  const remove = useMutation({
    mutationFn: (skill: AIAgentSkillView) => api.aiAgentsDeleteSkill(skill.key, skill.version),
    onSuccess: () => {
      void message.success(t('web.aiAgents.skillDeleted'));
      refresh();
    },
    onError: (error: Error) => void message.error(errorText(error), 8),
  });

  const openCreate = (): void => {
    setEditing(undefined);
    setEditorOpen(true);
  };

  const openEdit = (skill: AIAgentSkillView): void => {
    setEditing(skill);
    setEditorOpen(true);
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Text type="secondary">{t('web.aiAgents.skillsHint')}</Typography.Text>
      <Space wrap>
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder={t('web.aiAgents.skillSearch')}
          onSearch={setSearch}
        />
        <Select
          allowClear
          style={{ width: 180 }}
          placeholder={t('web.aiAgents.skillAnyStatus')}
          value={status}
          onChange={setStatus}
          options={['draft', 'published', 'archived'].map((value) => ({
            value,
            label: t(`web.aiAgents.skillStatus_${value}`),
          }))}
        />
        <Button icon={<ReloadOutlined />} onClick={() => void skills.refetch()}>
          {t('core.common.reload')}
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('web.aiAgents.newSkill')}
        </Button>
      </Space>
      {skills.isError ? (
        <Alert type="error" showIcon message={errorText(skills.error)} />
      ) : null}
      <Table
        rowKey="id"
        size="small"
        loading={skills.isLoading}
        dataSource={skills.data?.list ?? []}
        locale={{ emptyText: <EmptyState title={t('web.aiAgents.noSkills')} variant="no-results" /> }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          {
            title: t('web.aiAgents.skillKey'),
            dataIndex: 'key',
            render: (_: string, row: AIAgentSkillView) => (
              <Space direction="vertical" size={0}>
                <Typography.Text code>{row.key}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.aiAgents.skillVersion', { version: row.version })}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.skillLabel'),
            dataIndex: 'label',
            render: (_: string, row: AIAgentSkillView) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{row.label}</Typography.Text>
                {row.description === null ? null : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.description}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.status'),
            dataIndex: 'status',
            render: (_: string, row: AIAgentSkillView) => <StatusTag status={row.status} />,
          },
          {
            title: t('web.aiAgents.visibility'),
            dataIndex: 'visibility',
            render: (_: string, row: AIAgentSkillView) => <Tag>{row.visibility}</Tag>,
          },
          {
            title: t('web.aiAgents.updated'),
            dataIndex: 'modifiedAt',
            render: (_: string, row: AIAgentSkillView) => formatTimestamp(row.modifiedAt),
          },
          {
            title: t('web.aiAgents.actions'),
            key: 'actions',
            render: (_: unknown, row: AIAgentSkillView) => (
              <Space size={4} wrap>
                {row.canEdit ? (
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
                    {t('web.aiAgents.editDraft')}
                  </Button>
                ) : null}
                {row.canEdit && row.status === 'draft' ? (
                  <Button size="small" type="primary" onClick={() => { setPublishTarget(row); setPublishNote(''); }}>
                    {t('web.aiAgents.publishSkill')}
                  </Button>
                ) : null}
                {row.canEdit && row.status === 'published' ? (
                  <Popconfirm
                    title={t('web.aiAgents.archiveSkillConfirm')}
                    onConfirm={() => void archive.mutate(row)}
                  >
                    <Button size="small">{t('web.aiAgents.archiveSkill')}</Button>
                  </Popconfirm>
                ) : null}
                {row.canEdit && row.status === 'draft' ? (
                  <Popconfirm title={t('web.aiAgents.skillDeleteConfirm')} onConfirm={() => void remove.mutate(row)}>
                    <Button size="small" danger>{t('web.aiAgents.delete')}</Button>
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={editorOpen}
        title={editing === undefined ? t('web.aiAgents.newSkill') : t('web.aiAgents.editSkillTitle')}
        okText={t('core.common.save')}
        cancelText={t('core.common.cancel')}
        confirmLoading={save.isPending}
        onCancel={() => { setEditorOpen(false); setEditing(undefined); }}
        onOk={() => void form.validateFields().then((values) => save.mutate(values))}
        destroyOnClose
        width={720}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="key"
            label={t('web.aiAgents.skillKey')}
            extra={t('web.aiAgents.skillKeyHint')}
            rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,63}$/ }]}
          >
            <Input disabled={editing !== undefined} maxLength={64} placeholder="support_playbook" />
          </Form.Item>
          <Form.Item name="label" label={t('web.aiAgents.skillLabel')} rules={[{ required: true, max: MAX_LABEL }]}>
            <Input maxLength={MAX_LABEL} />
          </Form.Item>
          <Form.Item name="description" label={t('web.aiAgents.description')} rules={[{ max: MAX_DESCRIPTION }]}>
            <Input.TextArea rows={2} maxLength={MAX_DESCRIPTION} />
          </Form.Item>
          <Form.Item name="visibility" label={t('web.aiAgents.visibility')} initialValue="team">
            <Select
              options={['private', 'team', 'organization'].map((value) => ({
                value,
                label: t(`web.aiAgents.skillVisibility_${value}`),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="instructions"
            label={t('web.aiAgents.skillInstructions')}
            extra={t('web.aiAgents.skillInstructionsHint')}
            rules={[{ required: true, max: MAX_INSTRUCTIONS }]}
          >
            <Input.TextArea rows={8} maxLength={MAX_INSTRUCTIONS} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={publishTarget !== undefined}
        title={t('web.aiAgents.publishSkillTitle', { version: publishTarget?.version ?? 0 })}
        okText={t('web.aiAgents.publishSkill')}
        cancelText={t('core.common.cancel')}
        confirmLoading={publish.isPending}
        onCancel={() => { setPublishTarget(undefined); setPublishNote(''); }}
        onOk={() => void publish.mutate()}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">{t('web.aiAgents.skillPublishHint')}</Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={1_000}
          value={publishNote}
          onChange={(event) => setPublishNote(event.target.value)}
          placeholder={t('web.aiAgents.publishNotePlaceholder')}
        />
      </Modal>
    </Space>
  );
}
