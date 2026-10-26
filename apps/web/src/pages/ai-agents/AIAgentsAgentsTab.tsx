import { EditOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Checkbox, Col, Descriptions, Divider, Drawer, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { AIAgentConfigShape, AIAgentTemplate, AIAgentValidationReport, AIAgentVersionView,AIAgentView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { t } from '../../state/i18n.js';
import { AgentStatusTag, EffectTag, formatTimestamp, shortChecksum } from './shared.js';

/**
 * Phase 19-AI.5/19-AI.8 — agent definitions and immutable versions
 * (PLAN_Phase_19_AI_Agents.md §5, §15.2, §15.3, §20 `19-AI.5`).
 *
 * The editor never presents a policy value as free text: limits are bounded number inputs, tools are
 * a checkbox list of registered keys, and the provider/model pair comes from the server's allowlist.
 * The validation report shown before publishing is the server's own report — the SPA does not
 * re-implement publication rules.
 *
 * Every action is rendered from the server-reported `capabilities` of the specific agent, and a
 * hidden button is never the authorization: the corresponding endpoint re-checks it.
 */

const DEFAULT_LIMITS = {
  maxSteps: 6,
  maxModelCalls: 6,
  maxToolCalls: 4,
  maxTokens: 12_000,
  maxCostUsd: 0.5,
  maxElapsedSeconds: 60,
  maxRetries: 1,
  maxOutputTokens: 1_024,
  temperature: 0.2,
} as const;

interface AgentFormValues {
  key: string;
  name: string;
  description?: string;
  visibility: 'private' | 'team' | 'organization';
  providerKey?: string;
  model?: string;
  systemPrompt: string;
  tools: string[];
  memoryMode: 'none' | 'conversation' | 'checkpoint';
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxElapsedSeconds: number;
}

interface AgentsTabProps {
  readonly capabilities: Record<string, boolean>;
  readonly executionAvailable: boolean;
  readonly onOpenRun: (runId: string) => void;
}

export function AIAgentsAgentsTab({ capabilities, executionAvailable, onOpenRun }: AgentsTabProps) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<AIAgentView | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const [publishNote, setPublishNote] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runTask, setRunTask] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [templateKey, setTemplateKey] = useState<string | undefined>(undefined);

  const [form] = Form.useForm<AgentFormValues>();
  const providerKey = Form.useWatch('providerKey', form);

  const agents = useQuery({
    queryKey: ['aiAgents', 'agents', statusFilter, search],
    queryFn: () =>
      api.aiAgentsAgents({
        maxSize: 50,
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        ...(search.trim() === '' ? {} : { q: search.trim() }),
      }),
  });
  const tools = useQuery({ queryKey: ['aiAgents', 'toolCatalogue'], queryFn: () => api.aiAgentsTools(), staleTime: 60_000 });
  const templates = useQuery({ queryKey: ['aiAgents', 'templates'], queryFn: () => api.aiAgentsTemplates(), staleTime: 60_000 });
  const providers = useQuery({
    queryKey: ['aiAgents', 'providers'],
    queryFn: () => api.aiAgentsProviders(),
    enabled: capabilities['providerAdmin'] === true,
    retry: false,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ['aiAgents', 'agent', detailId],
    queryFn: () => api.aiAgentsAgent(detailId ?? ''),
    enabled: detailId !== undefined,
  });
  const validation = useQuery({
    queryKey: ['aiAgents', 'agentValidation', detailId],
    queryFn: () => api.aiAgentsValidate(detailId ?? ''),
    enabled: detailId !== undefined,
    retry: false,
  });
  const versions = useQuery({
    queryKey: ['aiAgents', 'agentVersions', detailId],
    queryFn: () => api.aiAgentsVersions(detailId ?? ''),
    enabled: detailId !== undefined,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'agents'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'agent'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'agentValidation'] });
    void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'agentVersions'] });
  };

  const save = useMutation({
    mutationFn: async (values: AgentFormValues) => {
      const base = editing?.draftConfig ?? templateConfig(templates.data?.list ?? [], templateKey);
      const config = buildConfig(base, values);
      if (editing === undefined) {
        return api.aiAgentsCreateAgent({
          key: values.key,
          name: values.name,
          ...(values.description === undefined || values.description.trim() === '' ? {} : { description: values.description.trim() }),
          visibility: values.visibility,
          config,
        });
      }
      return api.aiAgentsUpdateAgent(editing.id, {
        name: values.name,
        ...(values.description === undefined ? {} : { description: values.description.trim() === '' ? null : values.description.trim() }),
        visibility: values.visibility,
        config,
      });
    },
    onSuccess: (agent) => {
      void message.success(t('web.aiAgents.agentSaved', { name: agent.name }));
      setEditorOpen(false);
      setEditing(undefined);
      setTemplateKey(undefined);
      refresh();
      setDetailId(agent.id);
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: () => api.aiAgentsPublish(detailId ?? '', publishNote.trim() === '' ? undefined : publishNote.trim()),
    onSuccess: (result) => {
      void message.success(t('web.aiAgents.published', { version: result.version.version }));
      setPublishOpen(false);
      setPublishNote('');
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const lifecycle = useMutation({
    mutationFn: async (command: 'pause' | 'resume' | 'archive' | 'restore') => {
      const id = detailId ?? '';
      if (command === 'pause') return api.aiAgentsPause(id);
      if (command === 'resume') return api.aiAgentsResume(id);
      if (command === 'archive') return api.aiAgentsArchive(id);
      return api.aiAgentsRestore(id);
    },
    onSuccess: (agent) => {
      void message.success(t('web.aiAgents.agentNow', { status: agent.status }));
      refresh();
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const runConversations = useQuery({
    queryKey: ['aiAgents', 'conversations', 'agent', detailId],
    queryFn: () => api.aiAgentsConversations({ agentId: detailId ?? '', maxSize: 50 }),
    enabled: runOpen && detail.data?.draftConfig.memory.mode === 'conversation',
    staleTime: 15_000,
  });

  const startRun = useMutation({
    mutationFn: () => api.aiAgentsCreateRun(detailId ?? '', { text: runTask.trim() }, undefined, conversationId),
    onSuccess: (run) => {
      void message.success(t('web.aiAgents.runStarted'));
      setRunOpen(false);
      setRunTask('');
      setConversationId(undefined);
      void queryClient.invalidateQueries({ queryKey: ['aiAgents', 'runs'] });
      onOpenRun(run.id);
    },
    onError: (error: Error) => void message.error(error.message),
  });

  useEffect(() => {
    if (!editorOpen) return;
    form.setFieldsValue(formValues(editing, (templates.data?.list ?? []).find((template) => template.key === templateKey)));
  }, [editorOpen, editing, templateKey, templates.data, form]);

  const connection = providers.data?.list.find((entry) => entry.key === providerKey);
  const modelOptions = useMemo(() => connection?.models.map((model) => ({ value: model, label: model })) ?? [], [connection]);

  const openCreate = (template?: AIAgentTemplate): void => {
    setEditing(undefined);
    setTemplateKey(template?.key);
    setEditorOpen(true);
  };

  const openEdit = (agent: AIAgentView): void => {
    setEditing(agent);
    setTemplateKey(undefined);
    setEditorOpen(true);
  };

  const active = detail.data;
  const canManage = capabilities['manageDraft'] === true;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder={t('web.aiAgents.searchAgents')}
          style={{ maxWidth: 280, minWidth: 180, flex: '1 1 180px' }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          allowClear
          placeholder={t('web.aiAgents.anyStatus')}
          style={{ width: 150 }}
          value={statusFilter}
          onChange={(value) => setStatusFilter(value)}
          options={['draft', 'published', 'paused', 'archived'].map((status) => ({ value: status, label: status }))}
        />
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t('core.common.reload')}
        </Button>
        <div style={{ flex: 1 }} />
        {canManage ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
            {t('web.aiAgents.newAgent')}
          </Button>
        ) : null}
      </div>

      {(templates.data?.list.length ?? 0) > 0 && canManage ? (
        <Alert
          type="info"
          showIcon
          icon={<RobotOutlined />}
          style={{ marginBottom: 12 }}
          message={t('web.aiAgents.templateHint')}
          description={
            <Space wrap>
              {templates.data?.list.map((template) => (
                <Button key={template.key} size="small" onClick={() => openCreate(template)}>
                  {template.name}
                </Button>
              ))}
            </Space>
          }
        />
      ) : null}

      <Table<AIAgentView>
        rowKey="id"
        size="middle"
        loading={agents.isLoading}
        dataSource={agents.data?.list ?? []}
        scroll={{ x: 760 }}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: <EmptyState description={t('web.aiAgents.noAgents')} /> }}
        onRow={(agent) => ({ onClick: () => setDetailId(agent.id), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: t('web.aiAgents.name'),
            dataIndex: 'name',
            key: 'name',
            render: (_value, agent) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{agent.name}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {agent.key}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('web.aiAgents.status'),
            dataIndex: 'status',
            key: 'status',
            width: 120,
            render: (status: AIAgentView['status']) => <AgentStatusTag status={status} />,
          },
          {
            title: t('web.aiAgents.version'),
            key: 'version',
            width: 110,
            render: (_value, agent) =>
              agent.currentVersion === null ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <Space size={4}>
                  <Tag>v{agent.currentVersion}</Tag>
                  {agent.hasUnpublishedChanges ? <Tag color="orange">{t('web.aiAgents.draftChanges')}</Tag> : null}
                </Space>
              ),
          },
          {
            title: t('web.aiAgents.tools'),
            key: 'tools',
            width: 220,
            render: (_value, agent) =>
              agent.tools.length === 0 ? (
                <Typography.Text type="secondary">{t('web.aiAgents.noTools')}</Typography.Text>
              ) : (
                <Space size={[4, 4]} wrap>
                  {agent.tools.map((tool) => (
                    <Tag key={tool.key}>{tool.key.replaceAll('_', ' ')}</Tag>
                  ))}
                </Space>
              ),
          },
          { title: t('web.aiAgents.visibility'), dataIndex: 'visibility', key: 'visibility', width: 120 },
          {
            title: t('web.aiAgents.updated'),
            dataIndex: 'modifiedAt',
            key: 'modifiedAt',
            width: 170,
            render: (value: string) => formatTimestamp(value),
          },
        ]}
      />

      <Modal
        open={editorOpen}
        title={editing === undefined ? t('web.aiAgents.newAgent') : t('web.aiAgents.editDraft')}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(undefined);
          setTemplateKey(undefined);
        }}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText={t('core.common.save')}
        width={760}
        forceRender
        destroyOnClose={false}
      >
        <Form<AgentFormValues> form={form} layout="vertical" onFinish={(values) => save.mutate(values)} requiredMark="optional">
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="key" label={t('web.aiAgents.key')} rules={[{ required: true, pattern: /^[a-z][a-z0-9-]{1,63}$/, message: t('web.aiAgents.keyRule') }]}>
                <Input disabled={editing !== undefined} placeholder="account-briefing" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="name" label={t('web.aiAgents.name')} rules={[{ required: true, max: 120 }]}>
                <Input placeholder={t('web.aiAgents.namePlaceholder')} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label={t('web.aiAgents.description')}>
            <Input.TextArea rows={2} maxLength={1_000} showCount />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}>
              <Form.Item name="visibility" label={t('web.aiAgents.visibility')} initialValue="team">
                <Select
                  options={[
                    { value: 'private', label: t('web.aiAgents.visibilityPrivate') },
                    { value: 'team', label: t('web.aiAgents.visibilityTeam') },
                    { value: 'organization', label: t('web.aiAgents.visibilityOrganization') },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('web.aiAgents.providerModel')} extra={t('web.aiAgents.providerModelHint')}>
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="providerKey" noStyle>
                    <Select
                      allowClear
                      placeholder={t('web.aiAgents.chooseProvider')}
                      disabled={providers.isError || (providers.data?.list.length ?? 0) === 0}
                      onChange={() => form.setFieldValue('model', undefined)}
                      options={(providers.data?.list ?? []).map((entry) => ({ value: entry.key, label: `${entry.label} (${entry.key})` }))}
                    />
                  </Form.Item>
                  <Form.Item name="model" noStyle>
                    <Select allowClear placeholder={t('web.aiAgents.chooseModel')} options={modelOptions} disabled={modelOptions.length === 0} />
                  </Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>
          {providers.isError ? (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('web.aiAgents.providerDenied')} />
          ) : null}
          <Form.Item name="systemPrompt" label={t('web.aiAgents.systemPrompt')} rules={[{ required: true, max: 12_000 }]} extra={t('web.aiAgents.systemPromptHint')}>
            <Input.TextArea rows={5} maxLength={12_000} showCount placeholder={t('web.aiAgents.systemPromptPlaceholder')} />
          </Form.Item>
          <Form.Item name="tools" label={t('web.aiAgents.tools')} extra={t('web.aiAgents.toolsHint')}>
            <Checkbox.Group style={{ width: '100%' }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {(tools.data?.tools ?? []).map((tool) => (
                  <Checkbox key={tool.key} value={tool.key} disabled={!tool.enabled}>
                    <Space size={6} wrap>
                      <Typography.Text>{tool.label}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {tool.key}
                      </Typography.Text>
                      <EffectTag effect={tool.effectClass} />
                      {!tool.enabled ? <Tag color="red">{t('web.aiAgents.disabled')}</Tag> : null}
                    </Space>
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="memoryMode" label={t('web.aiAgents.memoryMode')} extra={t('web.aiAgents.memoryHint')} initialValue="none">
            <Select
              options={[
                { value: 'none', label: t('web.aiAgents.memoryNone') },
                { value: 'conversation', label: t('web.aiAgents.memoryConversation') },
                { value: 'checkpoint', label: t('web.aiAgents.memoryCheckpoint') },
              ]}
            />
          </Form.Item>
          <Divider orientation="left" style={{ marginTop: 0 }}>
            {t('web.aiAgents.limits')}
          </Divider>
          <Row gutter={12}>
            <Col xs={12} sm={6}>
              <Form.Item name="maxSteps" label={t('web.aiAgents.maxSteps')}>
                <InputNumber min={1} max={16} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="maxToolCalls" label={t('web.aiAgents.maxToolCalls')}>
                <InputNumber min={0} max={32} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="maxTokens" label={t('web.aiAgents.maxTokens')}>
                <InputNumber min={100} max={200_000} step={500} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="maxElapsedSeconds" label={t('web.aiAgents.maxElapsedSeconds')}>
                <InputNumber min={1} max={600} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Drawer
        open={detailId !== undefined}
        onClose={() => setDetailId(undefined)}
        width={Math.min(760, typeof window === 'undefined' ? 760 : window.innerWidth - 32)}
        title={
          active === undefined ? (
            t('web.aiAgents.agent')
          ) : (
            <Space wrap>
              <span>{active.name}</span>
              <AgentStatusTag status={active.status} />
              {active.hasUnpublishedChanges ? <Tag color="orange">{t('web.aiAgents.draftChanges')}</Tag> : null}
            </Space>
          )
        }
        extra={
          active === undefined ? null : (
            <Space wrap>
              {active.capabilities.run && active.status === 'published' ? (
                <Button
                  size="small"
                  icon={<PlayCircleOutlined />}
                  disabled={!executionAvailable}
                  onClick={() => setRunOpen(true)}
                >
                  {t('web.aiAgents.runAgent')}
                </Button>
              ) : null}
              {active.capabilities.editDraft ? (
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(active)}>
                  {t('web.aiAgents.editDraft')}
                </Button>
              ) : null}
              {active.capabilities.publish ? (
                <Button size="small" type="primary" onClick={() => setPublishOpen(true)}>
                  {t('web.aiAgents.publish')}
                </Button>
              ) : null}
            </Space>
          )
        }
      >
        {detail.isLoading || active === undefined ? (
          <EmptyState description={t('web.aiAgents.loadingAgent')} />
        ) : (
          <Tabs
            items={[
              {
                key: 'overview',
                label: t('web.aiAgents.overview'),
                children: (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label={t('web.aiAgents.key')}>{active.key}</Descriptions.Item>
                      <Descriptions.Item label={t('web.aiAgents.description')}>{active.description ?? '—'}</Descriptions.Item>
                      <Descriptions.Item label={t('web.aiAgents.visibility')}>{active.visibility}</Descriptions.Item>
                      <Descriptions.Item label={t('web.aiAgents.dataClass')}>{active.dataSensitivity}</Descriptions.Item>
                      <Descriptions.Item label={t('web.aiAgents.providerModel')}>
                        {active.draftConfig.provider === undefined
                          ? t('web.aiAgents.notConfigured')
                          : `${active.draftConfig.provider.key} · ${active.draftConfig.provider.model}`}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('web.aiAgents.updated')}>{formatTimestamp(active.modifiedAt)}</Descriptions.Item>
                    </Descriptions>

                    {active.configIssues.length > 0 ? (
                      <Alert
                        type="error"
                        showIcon
                        message={t('web.aiAgents.invalidDraft')}
                        description={
                          <List
                            size="small"
                            dataSource={[...active.configIssues]}
                            renderItem={(issue) => (
                              <List.Item>
                                <Typography.Text code>{issue.path}</Typography.Text> {issue.message}
                              </List.Item>
                            )}
                          />
                        }
                      />
                    ) : null}

                    <div>
                      <Typography.Title level={5}>{t('web.aiAgents.tools')}</Typography.Title>
                      {active.tools.length === 0 ? (
                        <Typography.Text type="secondary">{t('web.aiAgents.noTools')}</Typography.Text>
                      ) : (
                        <List
                          size="small"
                          dataSource={[...active.tools]}
                          renderItem={(tool) => (
                            <List.Item>
                              <Space wrap>
                                <Typography.Text>{tool.label}</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {tool.key}
                                </Typography.Text>
                                <EffectTag effect={tool.effectClass} />
                                {tool.requiresApproval ? <Tag color="gold">{t('web.aiAgents.approvalRequired')}</Tag> : null}
                                {!tool.enabled ? <Tag color="red">{t('web.aiAgents.disabled')}</Tag> : null}
                              </Space>
                            </List.Item>
                          )}
                        />
                      )}
                    </div>

                    <div>
                      <Typography.Title level={5}>{t('web.aiAgents.lifecycle')}</Typography.Title>
                      <Space wrap>
                        {active.status === 'published' && active.capabilities.lifecycle ? (
                          <Button onClick={() => lifecycle.mutate('pause')} loading={lifecycle.isPending}>
                            {t('web.aiAgents.pause')}
                          </Button>
                        ) : null}
                        {active.status === 'paused' && active.capabilities.lifecycle ? (
                          <Button onClick={() => lifecycle.mutate('resume')} loading={lifecycle.isPending}>
                            {t('web.aiAgents.resume')}
                          </Button>
                        ) : null}
                        {active.status !== 'archived' && active.status !== 'draft' && active.capabilities.lifecycle ? (
                          <Popconfirm
                            title={t('web.aiAgents.archiveConfirm')}
                            onConfirm={() => lifecycle.mutate('archive')}
                            okText={t('core.common.confirm')}
                            cancelText={t('core.common.cancel')}
                          >
                            <Button danger>{t('web.aiAgents.archive')}</Button>
                          </Popconfirm>
                        ) : null}
                        {active.status === 'archived' && active.capabilities.lifecycle ? (
                          <Button onClick={() => lifecycle.mutate('restore')} loading={lifecycle.isPending}>
                            {t('web.aiAgents.restore')}
                          </Button>
                        ) : null}
                      </Space>
                    </div>
                  </Space>
                ),
              },
              {
                key: 'versions',
                label: `${t('web.aiAgents.versions')} (${String(versions.data?.list.length ?? 0)})`,
                children:
                  versions.data?.list.length === 0 ? (
                    <EmptyState description={t('web.aiAgents.noVersions')} />
                  ) : (
                    <List
                      dataSource={[...(versions.data?.list ?? [])]}
                      renderItem={(version: AIAgentVersionView) => (
                        <List.Item>
                          <Space direction="vertical" size={2} style={{ width: '100%' }}>
                            <Space wrap>
                              <Tag color="blue">v{version.version}</Tag>
                              <Typography.Text type="secondary">{formatTimestamp(version.publishedAt)}</Typography.Text>
                              {version.providerKey === null ? null : (
                                <Tag>
                                  {version.providerKey} · {version.model}
                                </Tag>
                              )}
                            </Space>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t('web.aiAgents.checksum')}: <Typography.Text code>{shortChecksum(version.checksum)}</Typography.Text>
                            </Typography.Text>
                            {version.note === null ? null : <Typography.Text>{version.note}</Typography.Text>}
                            <Space size={[4, 4]} wrap>
                              {version.tools.map((tool) => (
                                <Tag key={tool.key}>{tool.key.replaceAll('_', ' ')}</Tag>
                              ))}
                            </Space>
                          </Space>
                        </List.Item>
                      )}
                    />
                  ),
              },
              {
                key: 'validation',
                label: t('web.aiAgents.validation'),
                children: <ValidationPanel report={validation.data} loading={validation.isLoading} error={validation.error} />,
              },
            ]}
          />
        )}
      </Drawer>

      <Modal
        open={publishOpen}
        title={t('web.aiAgents.publishTitle')}
        okText={t('web.aiAgents.publish')}
        confirmLoading={publish.isPending}
        onOk={() => publish.mutate()}
        onCancel={() => setPublishOpen(false)}
      >
        <Typography.Paragraph type="secondary">{t('web.aiAgents.publishHint')}</Typography.Paragraph>
        {validation.data === undefined ? null : <ValidationPanel report={validation.data} loading={false} error={null} compact />}
        <Input.TextArea
          rows={3}
          maxLength={1_000}
          showCount
          placeholder={t('web.aiAgents.publishNote')}
          value={publishNote}
          onChange={(event) => setPublishNote(event.target.value)}
          style={{ marginTop: 12 }}
        />
      </Modal>

      <Modal
        open={runOpen}
        title={t('web.aiAgents.runAgent')}
        okText={t('web.aiAgents.startRun')}
        onOk={() => startRun.mutate()}
        confirmLoading={startRun.isPending}
        okButtonProps={{ disabled: runTask.trim() === '' || !executionAvailable }}
        onCancel={() => setRunOpen(false)}
      >
        {!executionAvailable ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('web.aiAgents.executionUnavailable')}
            description={t('web.aiAgents.executionUnavailableHint')}
          />
        ) : null}
        <Typography.Paragraph type="secondary">
          {active?.inputHint ?? t('web.aiAgents.runHint')}
        </Typography.Paragraph>
        {active?.draftConfig.memory.mode === 'conversation' ? (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text strong>{t('web.aiAgents.conversation')}</Typography.Text>
            <Select
              allowClear
              style={{ width: '100%', marginTop: 4 }}
              value={conversationId}
              onChange={(value: string | undefined) => setConversationId(value)}
              placeholder={t('web.aiAgents.newConversation')}
              options={(runConversations.data?.list ?? []).map((conversation) => ({
                value: conversation.id,
                label: `${conversation.title ?? conversation.id.slice(0, 8)} · ${String(conversation.messageCount)} messages`,
              }))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('web.aiAgents.newConversationHint')}
            </Typography.Text>
          </div>
        ) : null}
        <Input.TextArea
          rows={4}
          maxLength={4_000}
          showCount
          value={runTask}
          onChange={(event) => setRunTask(event.target.value)}
          placeholder={active?.inputHint ?? t('web.aiAgents.runPlaceholder')}
        />
      </Modal>

    </div>
  );
}

function ValidationPanel({
  report,
  loading,
  error,
  compact = false,
}: {
  readonly report: AIAgentValidationReport | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly compact?: boolean;
}) {
  if (loading) return <Typography.Text type="secondary">{t('web.aiAgents.validating')}</Typography.Text>;
  if (error !== null && error !== undefined) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('web.aiAgents.validationUnavailable')}
        description={error instanceof Error ? error.message : undefined}
      />
    );
  }
  if (report === undefined) return <Typography.Text type="secondary">{t('web.aiAgents.validationPending')}</Typography.Text>;
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Alert
        type={report.ok ? 'success' : 'error'}
        showIcon
        message={report.ok ? t('web.aiAgents.validationOk') : t('web.aiAgents.validationBlocked')}
        description={compact ? undefined : t('web.aiAgents.validationHint')}
      />
      <List
        size="small"
        dataSource={[...report.checks]}
        renderItem={(check) => (
          <List.Item>
            <Space align="start">
              <Tag color={check.ok ? 'green' : 'red'}>{check.ok ? 'OK' : '!'}</Tag>
              <div>
                <Typography.Text strong>{check.id}</Typography.Text>
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {check.detail}
                </Typography.Text>
              </div>
            </Space>
          </List.Item>
        )}
      />
      {report.issues.length === 0 ? null : (
        <List
          size="small"
          dataSource={[...report.issues]}
          renderItem={(issue) => (
            <List.Item>
              <Space align="start" wrap={false}>
                <Tag color={issue.blocking ? 'red' : 'gold'}>{issue.blocking ? t('web.aiAgents.blocking') : t('web.aiAgents.warning')}</Tag>
                <Typography.Text>
                  <Typography.Text code>{issue.path}</Typography.Text> {issue.message}
                </Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </Space>
  );
}

function templateConfig(templates: readonly AIAgentTemplate[], key: string | undefined): AIAgentConfigShape | undefined {
  if (key === undefined) return undefined;
  return templates.find((template) => template.key === key)?.config;
}

function formValues(agent: AIAgentView | undefined, template: AIAgentTemplate | undefined): AgentFormValues {
  const config = agent?.draftConfig ?? template?.config;
  const limits = config?.limits ?? DEFAULT_LIMITS;
  return {
    key: agent?.key ?? '',
    name: agent?.name ?? template?.name ?? '',
    description: agent?.description ?? template?.description ?? '',
    visibility: (agent?.visibility as AgentFormValues['visibility'] | undefined) ?? 'team',
    ...(config?.provider?.key === undefined ? {} : { providerKey: config.provider.key }),
    ...(config?.provider?.model === undefined ? {} : { model: config.provider.model }),
    systemPrompt: config?.prompt.system ?? '',
    tools: config?.tools.map((tool) => tool.key) ?? [],
    memoryMode: config?.memory.mode ?? 'none',
    maxSteps: limits.maxSteps,
    maxToolCalls: limits.maxToolCalls,
    maxTokens: limits.maxTokens,
    maxCostUsd: limits.maxCostUsd,
    maxElapsedSeconds: limits.maxElapsedSeconds,
  };
}

/** The editor changes fields a run depends on; policy and trigger sections are preserved verbatim. */
function buildConfig(base: AIAgentConfigShape | undefined, values: AgentFormValues): Record<string, unknown> {
  const limits = {
    ...(base?.limits ?? DEFAULT_LIMITS),
    maxSteps: values.maxSteps,
    maxModelCalls: Math.min(base?.limits.maxModelCalls ?? values.maxSteps, values.maxSteps),
    maxToolCalls: values.maxToolCalls,
    maxTokens: values.maxTokens,
    maxCostUsd: values.maxCostUsd,
    maxElapsedSeconds: values.maxElapsedSeconds,
  };
  const out: Record<string, unknown> = {
    ...(base ?? {}),
    prompt: { ...(base?.prompt ?? { system: '' }), system: values.systemPrompt },
    tools: values.tools.map((key) => ({ key })),
    // Memory is opt-in: the mode is the administrator's choice, the sizing fields keep their
    // server defaults (maxMessages/retentionDays) unless the draft already set them.
    memory: { maxMessages: 12, retentionDays: 30, ...(base?.memory ?? {}), mode: values.memoryMode },
    limits,
  };
  // Clearing the provider must remove it, not silently keep the previous connection: publication
  // validates the provider the administrator actually chose.
  if (values.providerKey !== undefined && values.model !== undefined && values.providerKey !== '' && values.model !== '') {
    out['provider'] = { key: values.providerKey, model: values.model, fallbackModels: [] };
  } else {
    delete out['provider'];
  }
  return out;
}
