import { ArrowLeftOutlined, DeleteOutlined, DownOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Empty, Input, InputNumber, Row, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { WorkflowDefinitionShape, WorkflowNode, WorkflowRunView, WorkflowView } from '../api/types.js';
import { useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';
import { editableDefinition, useWorkflow, useWorkflowCatalog, useWorkflowRuns } from '../state/workflows.js';

/**
 * Workflow editor (PLAN §35).
 *
 * The graph is edited as an ordered list of nodes, which is the honest shape for an engine that has
 * no loops: execution follows `next` / `then` / `otherwise`, and the editor rewires those links as
 * nodes are inserted, moved or removed. A condition node splits the flow, so "otherwise" points at
 * whatever follows the branch — the reader never has to think about a free-form graph.
 *
 * Every save is validated by the API before it is stored, and the issues come back attached to the
 * node that caused them, so a broken automation is visible here rather than at run time.
 */
export function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const admin = principal?.type === 'admin';

  const workflow = useWorkflow(id, admin);
  const catalog = useWorkflowCatalog(admin);
  const metadata = useMetadata();
  const runs = useWorkflowRuns(admin);

  const [definition, setDefinition] = useState<WorkflowDefinitionShape | undefined>(undefined);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!workflow.data) return;
    const loaded = editableDefinition(workflow.data);
    setDefinition(loaded);
    setName(workflow.data.name);
    setDirty(false);
  }, [workflow.data]);

  const save = useMutation({
    mutationFn: () => api.updateWorkflow(id ?? '', { name, ...(definition === undefined ? {} : { definition }) }),
    onSuccess: () => {
      void message.success('Draft saved.');
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: () => api.publishWorkflow(id ?? ''),
    onSuccess: (updated: WorkflowView) => {
      void message.success(`Version ${String(updated.currentVersion)} published.`);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) return <Alert type="error" message="Administrator access is required to edit workflows." />;
  if (workflow.isLoading) return <Card loading />;
  if (!workflow.data || !definition) return <Alert type="error" message="This workflow does not exist." />;

  const actions = catalog.data?.actions ?? [];
  const issues = workflow.data.issues;
  const nodes = definition.nodes;

  const update = (next: WorkflowDefinitionShape) => {
    setDefinition(next);
    setDirty(true);
  };

  /** Rewires the graph after an insert/remove/move so every link points at a node that exists. */
  const rewire = (list: WorkflowNode[]): WorkflowNode[] => {
    const known = new Set(list.map((node) => node.id));
    const nextOf = (node: WorkflowNode, index: number): string | undefined => {
      const declared = node.type === 'condition' ? node.otherwise : node.next;
      if (declared !== undefined && known.has(declared)) return declared;
      return list[index + 1]?.id;
    };
    return list.map((node, index): WorkflowNode => {
      if (node.type === 'end') return node;
      const target = nextOf(node, index);
      if (node.type === 'condition') {
        return target === undefined ? { ...node, otherwise: undefined } : { ...node, otherwise: target };
      }
      return target === undefined ? { ...node, next: undefined } : { ...node, next: target };
    });
  };

  const insertAfter = (index: number, node: WorkflowNode): void => {
    const list = [...nodes.slice(0, index + 1), node, ...nodes.slice(index + 1)];
    const start = definition.start === nodes[index]?.id && index === 0 ? node.id : definition.start;
    update({ ...definition, start: knownOr(start, list), nodes: rewire(list) });
  };

  const remove = (index: number) => {
    const list = nodes.filter((_node, position) => position !== index);
    if (list.length === 0) return;
    const start = definition.start === nodes[index]?.id ? list[0]?.id ?? '' : definition.start;
    update({ ...definition, start: knownOr(start, list), nodes: rewire(list) });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return;
    const list = [...nodes];
    const [moved] = list.splice(index, 1);
    if (moved === undefined) return;
    list.splice(target, 0, moved);
    update({ ...definition, nodes: rewire(list) });
  };

  const patchNode = (nodeId: string, patch: Partial<WorkflowNode>) => {
    update({
      ...definition,
      nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    });
  };

  const addAction = (after: number, actionName: string): void => {
    const spec = actions.find((action) => action.name === actionName);
    const node: WorkflowNode = {
      id: `n${Date.now().toString(36)}`,
      type: 'action',
      name: spec?.label ?? actionName,
      action: actionName,
      params: defaultParamsOf(actionName),
    };
    insertAfter(after, node);
  };

  const addCondition = (after: number): void => {
    const node: WorkflowNode = {
      id: `c${Date.now().toString(36)}`,
      type: 'condition',
      name: 'Condition',
      formula: '',
      then: '',
    };
    insertAfter(after, node);
  };

  const addDelay = (after: number): void => {
    const node: WorkflowNode = { id: `d${Date.now().toString(36)}`, type: 'delay', name: 'Wait', seconds: 3600 };
    insertAfter(after, node);
  };

  const entityOptions = Object.values(metadata.data ?? {})
    .filter((entity) => entity.isEntity)
    .map((entity) => ({ value: entity.name, label: entity.label }));
  const workflowRuns = (runs.data?.list ?? []).filter((run) => run.workflowId === workflow.data?.id);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <Link to="/admin/workflows">
              <Button size="small" icon={<ArrowLeftOutlined />} />
            </Link>
            {workflow.data.name}
          </Space>
        }
        extra={
          <Space>
            <Button icon={<SaveOutlined />} onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              Save draft
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => publish.mutate()}
              loading={publish.isPending}
              disabled={dirty || issues.length > 0}
            >
              Publish
            </Button>
          </Space>
        }
      >
        <Row gutter={16}>
          <Col span={12}>
            <Typography.Text type="secondary">Name</Typography.Text>
            <Input value={name} onChange={(event) => setName(event.target.value)} onBlur={() => setDirty(true)} />
          </Col>
          <Col span={6}>
            <Typography.Text type="secondary">When</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={definition.trigger.eventType}
              options={(catalog.data?.events ?? []).map((event) => ({ value: event, label: event }))}
              onChange={(eventType) => update({ ...definition, trigger: { ...definition.trigger, eventType } })}
            />
          </Col>
          <Col span={6}>
            <Typography.Text type="secondary">Entity</Typography.Text>
            <Select
              style={{ width: '100%' }}
              showSearch
              value={definition.trigger.entityType}
              options={[{ value: '*', label: 'Any entity' }, ...entityOptions]}
              onChange={(entityType) => update({ ...definition, trigger: { ...definition.trigger, entityType } })}
            />
          </Col>
        </Row>

        <Space style={{ marginTop: 12 }} wrap>
          <Tag color={workflow.data.currentVersionStatus === 'published' ? 'blue' : 'default'}>
            draft v{workflow.data.currentVersion ?? '—'}
          </Tag>
          {workflow.data.publishedVersion !== null ? <Tag color="blue">published v{workflow.data.publishedVersion}</Tag> : <Tag>not published</Tag>}
          {dirty ? <Tag color="orange">unsaved changes</Tag> : null}
        </Space>

        {issues.length > 0 ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            message="This definition cannot run"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {issues.map((issue) => (
                  <li key={`${issue.path ?? ''}-${issue.message}`}>
                    {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </Card>

      <Card title="Flow">
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {nodes.length === 0 ? <Empty description="This workflow has no steps." /> : null}
          {nodes.map((node, index) => (
            <NodeEditor
              key={node.id}
              node={node}
              isStart={definition.start === node.id}
              actions={actions}
              issues={issues.filter((issue) => issue.path === node.id)}
              onChange={(patch) => patchNode(node.id, patch)}
              onRemove={() => remove(index)}
              onMove={(delta) => move(index, delta)}
              onAddAction={(action) => addAction(index, action)}
              onAddCondition={() => addCondition(index)}
              onAddDelay={() => addDelay(index)}
            />
          ))}
        </Space>
      </Card>

      <Card title="Run history">
        <RunTable runs={workflowRuns} />
      </Card>
    </Space>
  );
}

function NodeEditor({
  node,
  isStart,
  actions,
  issues,
  onChange,
  onRemove,
  onMove,
  onAddAction,
  onAddCondition,
  onAddDelay,
}: {
  node: WorkflowNode;
  isStart: boolean;
  actions: { name: string; label: string; description: string }[];
  issues: { message: string }[];
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onAddAction: (action: string) => void;
  onAddCondition: () => void;
  onAddDelay: () => void;
}) {
  return (
    <Card size="small" style={{ width: '100%' }} title={<Space>{node.name}{isStart ? <Tag color="blue">start</Tag> : null}</Space>} extra={
      <Space size={4}>
        <Button size="small" onClick={() => onMove(-1)}>
          Up
        </Button>
        <Button size="small" onClick={() => onMove(1)}>
          Down
        </Button>
        <Button size="small" danger icon={<DeleteOutlined />} onClick={onRemove} aria-label={`Remove ${node.name}`}>
          Remove
        </Button>
      </Space>
    }>
      {issues.length > 0 ? (
        <Alert style={{ marginBottom: 8 }} type="error" message={issues.map((issue) => issue.message).join(' ')} />
      ) : null}

      {node.type === 'end' ? (
        <Typography.Text type="secondary">The flow ends here.</Typography.Text>
      ) : null}

      {node.type === 'action' ? (
        <Row gutter={12}>
          <Col span={7}>
            <Typography.Text type="secondary">Action</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={node.action ?? null}
              options={actions.map((action) => ({ value: action.name, label: action.label }))}
              onChange={(action: string) =>
                onChange({
                  action,
                  name: actions.find((entry) => entry.name === action)?.label ?? action,
                  params: defaultParamsOf(action),
                })
              }
            />
          </Col>
          <Col span={7}>
            <Typography.Text type="secondary">Step name</Typography.Text>
            <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
          </Col>
          <Col span={10}>
            <Typography.Text type="secondary">Parameters</Typography.Text>
            <ParamsEditor action={node.action ?? ''} params={node.params ?? {}} onChange={(params) => onChange({ params })} />
          </Col>
        </Row>
      ) : null}

      {node.type === 'condition' ? (
        <Row gutter={12}>
          <Col span={14}>
            <Typography.Text type="secondary">Formula (condition must be true)</Typography.Text>
            <Input
              value={node.formula ?? ''}
              placeholder={'number(field("amount")) > 10000'}
              onChange={(event) => onChange({ formula: event.target.value })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              The sandboxed formula language: <code>field('x')</code> reads the record, <code>now()</code> is the run time.
            </Typography.Text>
          </Col>
          <Col span={10}>
            <Typography.Text type="secondary">Step name</Typography.Text>
            <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
          </Col>
        </Row>
      ) : null}

      {node.type === 'delay' ? (
        <Row gutter={12}>
          <Col span={8}>
            <Typography.Text type="secondary">Wait (seconds)</Typography.Text>
            <InputNumber min={0} value={node.seconds ?? 0} onChange={(value) => onChange({ seconds: Number(value ?? 0) })} />
          </Col>
          <Col span={8}>
            <Typography.Text type="secondary">Step name</Typography.Text>
            <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
          </Col>
        </Row>
      ) : null}

      <Space style={{ marginTop: 8 }} wrap>
        <Select
          size="small"
          style={{ width: 200 }}
          placeholder="Add a step after this one…"
          // A "picker" rather than a value: choosing an entry inserts that step after this node.
          value={null}
          onChange={(value: string) => {
            if (value === '__condition') onAddCondition();
            else if (value === '__delay') onAddDelay();
            else onAddAction(value);
          }}
          options={[
            { value: '__condition', label: 'Condition (branch)' },
            { value: '__delay', label: 'Wait (delay)' },
            ...actions.map((action) => ({ value: action.name, label: action.label })),
          ]}
        />
        <Tooltip title="The flow continues at the next step unless a node points somewhere else.">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <DownOutlined /> continues to the step below
          </Typography.Text>
        </Tooltip>
      </Space>
    </Card>
  );
}

/**
 * Structured parameter forms.
 *
 * Automation is edited through forms, never raw JSON, so each action gets the inputs it actually
 * needs. `{{field}}` placeholders stay available in text values — that is how a workflow says "the
 * account this started from".
 */
function ParamsEditor({
  action,
  params,
  onChange,
}: {
  action: string;
  params: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const fields = paramFieldsOf(action, params);
  if (fields.length === 0) return <Typography.Text type="secondary">No parameters.</Typography.Text>;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {fields.map((field) => (
        <Input
          key={field.key}
          size="small"
          placeholder={field.placeholder}
          value={String(params[field.key] ?? '')}
          onChange={(event) => onChange({ ...params, [field.key]: event.target.value })}
        />
      ))}
      {Object.keys(params)
        .filter((key) => !fields.some((field) => field.key === key))
        .map((key) => (
          <Input
            key={key}
            size="small"
            value={String(params[key] ?? '')}
            placeholder={key}
            onChange={(event) => onChange({ ...params, [key]: event.target.value })}
          />
        ))}
    </Space>
  );
}

function paramFieldsOf(action: string | undefined, params: Record<string, unknown>): { key: string; placeholder: string }[] {
  switch (action) {
    case 'updateRecord':
      return [{ key: 'fields', placeholder: 'field=value, field2=value2' }];
    case 'createRecord':
      return [
        { key: 'entityType', placeholder: 'entity type (Task)' },
        { key: 'fields', placeholder: 'name=Follow up, status=Planned' },
      ];
    case 'createNotification':
      return [
        { key: 'userId', placeholder: "user id, or {{assignedUserId}}" },
        { key: 'message', placeholder: 'message' },
      ];
    case 'sendEmail':
      return [
        { key: 'to', placeholder: 'to (use {{emailAddress}})' },
        { key: 'subject', placeholder: 'subject' },
        { key: 'body', placeholder: 'body' },
      ];
    case 'runJob':
      return [{ key: 'jobName', placeholder: 'job name' }];
    default:
      return Object.keys(params).map((key) => ({ key, placeholder: key }));
  }
}

/** Parses the compact `key=value, key2=value2` form used by the action parameter inputs. */
function defaultParamsOf(action: string | undefined): Record<string, unknown> {
  switch (action) {
    case 'updateRecord':
      return { fields: {} };
    case 'createRecord':
      return { entityType: 'Task', fields: {} };
    case 'createNotification':
      return { userId: '', message: '' };
    case 'sendEmail':
      return { to: '', subject: '', body: '' };
    case 'runJob':
      return { jobName: '' };
    default:
      return {};
  }
}

function knownOr(start: string, nodes: readonly WorkflowNode[]): string {
  return nodes.some((node) => node.id === start) ? start : nodes[0]?.id ?? '';
}

function RunTable({ runs }: { runs: WorkflowRunView[] }) {
  const summary = useMemo(() => (runs.length === 0 ? 'No run yet.' : `${String(runs.length)} recent run(s).`), [runs.length]);
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Typography.Text type="secondary">{summary}</Typography.Text>
      <Table<WorkflowRunView>
        rowKey="id"
        size="small"
        dataSource={runs}
        pagination={false}
        locale={{ emptyText: 'No run yet.' }}
        expandable={{
          expandedRowRender: (run) => (
            <Table
              rowKey="nodeId"
              size="small"
              pagination={false}
              dataSource={run.steps}
              columns={[
                { title: 'Step', dataIndex: 'name' },
                { title: 'Type', dataIndex: 'nodeType' },
                { title: 'Status', dataIndex: 'status' },
                { title: 'Attempt', dataIndex: 'attempt' },
                { title: 'Error', dataIndex: 'error', render: (error: string | null) => error ?? '—' },
              ]}
            />
          ),
        }}
        columns={[
          { title: 'Record', render: (_v: unknown, run) => `${run.entityType}/${run.entityId}` },
          { title: 'Status', dataIndex: 'status' },
          { title: 'Attempt', dataIndex: 'attempt' },
          { title: 'Started', render: (_v: unknown, run) => run.startedAt.slice(0, 19).replace('T', ' ') },
          { title: 'Error', dataIndex: 'error', render: (error: string | null) => error ?? '—' },
        ]}
      />
    </Space>
  );
}
