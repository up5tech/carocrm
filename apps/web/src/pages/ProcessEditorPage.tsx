import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Col, Empty, Input, InputNumber, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type {
  ProcessAssigneeSpec,
  ProcessCatalog,
  ProcessDefinitionShape,
  ProcessInstanceView,
  ProcessNode,
  ProcessOutcomeSpec,
  ProcessView,
} from '../api/types.js';
import { defaultParamsOf,ParamsEditor } from '../components/ParamsEditor.js';
import { t } from '../state/i18n.js';
import { useMetadata } from '../state/metadata.js';
import { editableProcessDefinition, useProcess, useProcessCatalog, useProcessInstances } from '../state/processes.js';
import { useSession } from '../state/session.js';

/**
 * Process editor (PLAN §36).
 *
 * A process graph may loop ("request changes, back to review"), so unlike the workflow editor this
 * one does not rewire links automatically — every outcome and branch names its target explicitly,
 * and the list below shows each step with the links it owns. What keeps the editor honest is the
 * same thing that keeps the engine honest: the API validates the whole graph before storing it, so
 * an unreachable step, a dangling link or a loop with nothing to wait for is shown here, attached
 * to the step that caused it, rather than discovered when a process is started.
 *
 * The lifecycle is the workflow one — draft is edited, publishing freezes the version, enabling
 * lets new instances start — with assignee and timer controls that only an approval needs.
 */
export function ProcessEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const { principal } = useSession();
  const queryClient = useQueryClient();
  const admin = principal?.type === 'admin';

  const process = useProcess(id, admin);
  const catalog = useProcessCatalog(admin);
  const metadata = useMetadata();
  const instances = useProcessInstances({ definitionId: id });

  const [definition, setDefinition] = useState<ProcessDefinitionShape | undefined>(undefined);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!process.data) return;
    const loaded = editableProcessDefinition(process.data);
    setDefinition(loaded);
    setName(process.data.name);
    setDescription(process.data.description ?? '');
    setDirty(false);
  }, [process.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateProcess(id ?? '', {
        name,
        description,
        ...(definition === undefined ? {} : { definition }),
      }),
    onSuccess: () => {
      void message.success(t('web.workflowEditor.draftSaved'));
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ['processes'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: () => api.publishProcess(id ?? ''),
    onSuccess: (updated: ProcessView) => {
      void message.success(t('web.workflowEditor.published', { version: String(updated.currentVersion) }));
      void queryClient.invalidateQueries({ queryKey: ['processes'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setProcessEnabled(id ?? '', enabled),
    onSuccess: (updated: ProcessView) => {
      void message.success(updated.isActive ? t('web.processes.enabledNotice', { name: updated.name }) : t('web.processes.disabledNotice', { name: updated.name }));
      void queryClient.invalidateQueries({ queryKey: ['processes'] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (!admin) return <Alert type="error" message={t('web.admin.accessRequiredProcessEditor')} />;
  if (process.isLoading) return <Card loading />;
  if (!process.data || !definition) return <Alert type="error" message={t('web.processEditor.notFound')} />;

  const actions = catalog.data?.actions ?? [];
  const issues = process.data.issues;
  const nodes = definition.nodes;

  const update = (next: ProcessDefinitionShape) => {
    setDefinition(next);
    setDirty(true);
  };

  /**
   * After a structural change, every link must still name a step that exists. Links are left alone
   * when they are valid — an explicit "reject → stop" must survive adding a step elsewhere — and a
   * dangling link falls back to the step below its owner, which is what the author most likely
   * meant. The last step has no step below, so its link stays empty and the API's issue ("needs a
   * target node") names the card to fix — clearer than silently looping the flow back to the top.
   */
  const rewire = (list: ProcessNode[]): ProcessNode[] => {
    const known = new Set(list.map((node) => node.id));
    const below = (index: number): string | undefined => list[index + 1]?.id;
    const repair = (index: number, target: string | undefined): string =>
      target !== undefined && known.has(target) ? target : below(index) ?? '';
    return list.map((node, index): ProcessNode => {
      switch (node.type) {
        case 'userTask':
          return {
            ...node,
            outcomes: (node.outcomes ?? []).map((outcome) => ({ ...outcome, next: repair(index, outcome.next) })),
          };
        case 'serviceTask':
          return { ...node, next: repair(index, node.next) };
        case 'gateway':
          return {
            ...node,
            branches: (node.branches ?? []).map((branch) => ({ ...branch, next: repair(index, branch.next) })),
            default: repair(index, node.default),
          };
        default:
          return node;
      }
    });
  };

  /**
   * A step is spliced *into* the flow: whatever continued at the step it displaces now stops here
   * first, and the new step continues where the displaced one did. Links that point elsewhere —
   * a loop back to review, "reject → stop" — are left alone.
   */
  const retarget = (owner: ProcessNode, from: string, to: string): ProcessNode => {
    const swap = (target: string | undefined): string | undefined => (target === from ? to : target);
    switch (owner.type) {
      case 'userTask':
        return {
          ...owner,
          outcomes: (owner.outcomes ?? []).map((outcome) => ({ ...outcome, next: swap(outcome.next) ?? outcome.next })),
        };
      case 'serviceTask':
        return { ...owner, next: swap(owner.next) };
      case 'gateway':
        return {
          ...owner,
          branches: (owner.branches ?? []).map((branch) => ({ ...branch, next: swap(branch.next) ?? branch.next })),
          default: swap(owner.default),
        };
      default:
        return owner;
    }
  };

  const insertAfter = (index: number, node: ProcessNode): void => {
    const displaced = nodes[index + 1];
    const list = [...nodes.slice(0, index + 1), node, ...nodes.slice(index + 1)];
    const rerouted =
      displaced === undefined
        ? list
        : list.map((entry, position) => (position === index ? retarget(entry, displaced.id, node.id) : entry));
    update({ ...definition, start: rerouted[0]?.id ?? node.id, nodes: rewire(rerouted) });
  };

  const remove = (index: number) => {
    if (nodes.length <= 1) return; // a process always keeps one step
    const list = nodes.filter((_node, position) => position !== index);
    update({ ...definition, start: list[0]?.id ?? '', nodes: rewire(list) });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= nodes.length) return;
    const list = [...nodes];
    const [moved] = list.splice(index, 1);
    if (moved === undefined) return;
    list.splice(target, 0, moved);
    // The flow starts at the top of the list, so moving a step to the top makes it the start.
    update({ ...definition, start: list[0]?.id ?? definition.start, nodes: rewire(list) });
  };

  const patchNode = (nodeId: string, patch: Partial<ProcessNode>) => {
    update({
      ...definition,
      nodes: definition.nodes.map((node) => (node.id === nodeId ? ({ ...node, ...patch } as ProcessNode) : node)),
    });
  };

  const addUserTask = (after: number): void => {
    insertAfter(after, {
      id: `u${Date.now().toString(36)}`,
      type: 'userTask',
      name: t('web.processEditor.defaultUserTaskName'),
      // The record's own owner is the safest default assignee: it exists wherever the process runs
      // and the author can narrow it to a person or a role.
      assignee: { type: 'recordField', value: 'assignedUserId' },
      outcomes: [{ value: 'approved', label: t('web.processEditor.defaultApprove'), next: '' }],
    });
  };

  const addServiceTask = (after: number, actionName: string): void => {
    const spec = actions.find((action) => action.name === actionName);
    insertAfter(after, {
      id: `s${Date.now().toString(36)}`,
      type: 'serviceTask',
      name: spec?.label ?? actionName,
      action: actionName,
      params: defaultParamsOf(actionName),
      next: '',
    });
  };

  const addGateway = (after: number): void => {
    insertAfter(after, {
      id: `g${Date.now().toString(36)}`,
      type: 'gateway',
      name: t('web.processEditor.defaultGatewayName'),
      // `true` keeps the draft valid — the author replaces it with the real condition; the branch
      // order decides which match wins.
      branches: [{ when: 'true', next: '' }],
      default: '',
    });
  };

  const addEnd = (after: number): void => {
    insertAfter(after, { id: `e${Date.now().toString(36)}`, type: 'end', name: t('web.processEditor.defaultEndName') });
  };

  const entityOptions = Object.values(metadata.data ?? {})
    .filter((entity) => entity.isEntity)
    .map((entity) => ({ value: entity.name, label: entity.label }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <Link to="/admin/processes">
              <Button size="small" icon={<ArrowLeftOutlined />} />
            </Link>
            {process.data.name}
          </Space>
        }
        extra={
          <Space>
            <Button icon={<SaveOutlined />} onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              {t('web.workflowEditor.saveDraft')}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => publish.mutate()}
              loading={publish.isPending}
              disabled={dirty || issues.length > 0}
            >
              {t('web.workflows.publish')}
            </Button>
          </Space>
        }
      >
        <Row gutter={16}>
          <Col span={8}>
            <Typography.Text type="secondary">{t('web.common.name')}</Typography.Text>
            <Input value={name} onChange={(event) => setName(event.target.value)} onBlur={() => setDirty(true)} />
          </Col>
          <Col span={6}>
            <Typography.Text type="secondary">{t('web.processes.key')}</Typography.Text>
            <Input value={process.data.key} disabled />
          </Col>
          <Col span={6}>
            <Typography.Text type="secondary">{t('web.processes.recordType')}</Typography.Text>
            <Select
              style={{ width: '100%' }}
              showSearch
              value={definition.entityType ?? '*'}
              options={[{ value: '*', label: t('web.workflows.anyEntity') }, ...entityOptions]}
              onChange={(entityType) => {
                setDirty(true);
                setDefinition({ ...definition, entityType });
              }}
            />
          </Col>
          <Col span={4}>
            <Typography.Text type="secondary">{t('web.workflows.enabled')}</Typography.Text>
            <div>
              <Switch
                size="small"
                checked={process.data.isActive}
                disabled={process.data.publishedVersion === null}
                onChange={(enabled) => toggle.mutate(enabled)}
              />
            </div>
          </Col>
        </Row>

        <Row gutter={16} style={{ marginTop: 8 }}>
          <Col span={24}>
            <Typography.Text type="secondary">{t('web.processEditor.description')}</Typography.Text>
            <Input
              value={description}
              placeholder={t('web.processEditor.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => setDirty(true)}
            />
          </Col>
        </Row>

        <Space style={{ marginTop: 12 }} wrap>
          <Tag color={process.data.currentVersionStatus === 'published' ? 'blue' : 'default'}>
            {t('web.workflows.draftVersion', { version: String(process.data.currentVersion ?? '—') })}
          </Tag>
          {process.data.publishedVersion !== null ? <Tag color="blue">{t('web.workflows.publishedVersion', { version: String(process.data.publishedVersion) })}</Tag> : <Tag>{t('web.workflows.notPublished')}</Tag>}
          {dirty ? <Tag color="orange">{t('web.workflowEditor.unsaved')}</Tag> : null}
        </Space>

        {issues.length > 0 ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            message={t('web.workflowEditor.cannotRun')}
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

      <Card title={t('web.workflowEditor.flow')}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {nodes.length === 0 ? <Empty description={t('web.processEditor.noSteps')} /> : null}
          {nodes.map((node, index) => (
            <NodeEditor
              key={node.id}
              node={node}
              nodes={nodes}
              catalog={catalog.data}
              isStart={index === 0}
              issues={issues.filter((issue) => issue.path === node.id || issue.path?.startsWith(`${node.id}.`) === true)}
              onChange={(patch) => patchNode(node.id, patch)}
              onRemove={() => remove(index)}
              onMove={(delta) => move(index, delta)}
              onAddUserTask={() => addUserTask(index)}
              onAddServiceTask={(action) => addServiceTask(index, action)}
              onAddGateway={() => addGateway(index)}
              onAddEnd={() => addEnd(index)}
            />
          ))}
        </Space>
      </Card>

      <Card title={t('web.processEditor.instances')}>
        <InstanceMiniTable instances={instances.data?.list ?? []} loading={instances.isFetching} />
      </Card>
    </Space>
  );
}

/** One step of the flow: type-specific inputs, plus the targets this step owns. */
function NodeEditor({
  node,
  nodes,
  catalog,
  isStart,
  issues,
  onChange,
  onRemove,
  onMove,
  onAddUserTask,
  onAddServiceTask,
  onAddGateway,
  onAddEnd,
}: {
  node: ProcessNode;
  nodes: ProcessNode[];
  catalog: ProcessCatalog | undefined;
  isStart: boolean;
  issues: { message: string }[];
  onChange: (patch: Partial<ProcessNode>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  onAddUserTask: () => void;
  onAddServiceTask: (action: string) => void;
  onAddGateway: () => void;
  onAddEnd: () => void;
}) {
  const targetOptions = nodes.map((entry) => ({ value: entry.id, label: entry.name || entry.id }));
  const users = useQuery({
    queryKey: ['users', 'picker'],
    queryFn: () => api.users({ maxSize: 200 }),
    staleTime: 60_000,
    retry: false,
  });
  const roles = useQuery({ queryKey: ['roles', 'picker'], queryFn: () => api.roles(), staleTime: 60_000, retry: false });

  const userOptions = (users.data?.list ?? [])
    .filter((user) => user.isActive)
    .map((user) => ({ value: user.id, label: user.name }));
  const roleOptions = (roles.data?.list ?? []).map((role) => ({ value: role.name, label: role.name }));

  return (
    <Card
      size="small"
      style={{ width: '100%' }}
      title={
        <Space>
          {node.name}
          {isStart ? <Tag color="blue">{t('web.workflowEditor.startTag')}</Tag> : null}
          <Tag>{node.type}</Tag>
        </Space>
      }
      extra={
        <Space size={4}>
          <Button size="small" onClick={() => onMove(-1)} aria-label={t('web.processEditor.moveUpAria', { name: node.name })}>
            {t('web.workflowEditor.up')}
          </Button>
          <Button size="small" onClick={() => onMove(1)} aria-label={t('web.processEditor.moveDownAria', { name: node.name })}>
            {t('web.workflowEditor.down')}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={onRemove} aria-label={t('web.workflowEditor.removeAria', { name: node.name })} disabled={nodes.length <= 1}>
            {t('web.common.remove')}
          </Button>
        </Space>
      }
    >
      {issues.length > 0 ? (
        <Alert style={{ marginBottom: 8 }} type="error" message={issues.map((issue) => issue.message).join(' ')} />
      ) : null}

      {node.type === 'end' ? (
        <Row gutter={12}>
          <Col span={8}>
            <Typography.Text type="secondary">{t('web.workflowEditor.stepName')}</Typography.Text>
            <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
          </Col>
          <Col span={8}>
            <Typography.Text type="secondary">{t('web.processEditor.outcomeLabel')}</Typography.Text>
            <Input value={node.outcome ?? ''} placeholder="approved" onChange={(event) => onChange({ outcome: event.target.value })} />
          </Col>
        </Row>
      ) : null}

      {node.type === 'userTask' ? (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Row gutter={12}>
            <Col span={8}>
              <Typography.Text type="secondary">{t('web.workflowEditor.stepName')}</Typography.Text>
              <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
            </Col>
            <Col span={8}>
              <Typography.Text type="secondary">{t('web.processEditor.assignedTo')}</Typography.Text>
              <AssigneePicker spec={node.assignee} users={userOptions} roles={roleOptions} onChange={(assignee) => onChange({ assignee })} />
            </Col>
            <Col span={4}>
              <Typography.Text type="secondary">{t('web.processEditor.dueAfter')}</Typography.Text>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                value={node.dueSeconds ?? null}
                onChange={(value) => onChange({ dueSeconds: value === null ? undefined : Number(value) })}
              />
            </Col>
            <Col span={4}>
              <Typography.Text type="secondary">{t('web.processEditor.escalateAfter')}</Typography.Text>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                value={node.escalateAfterSeconds ?? null}
                onChange={(value) => onChange({ escalateAfterSeconds: value === null ? undefined : Number(value) })}
              />
            </Col>
          </Row>

          {node.escalateAfterSeconds !== undefined ? (
            <Row gutter={12}>
              <Col span={8}>
                <Typography.Text type="secondary">{t('web.processEditor.escalateTo')}</Typography.Text>
                <AssigneePicker
                  spec={node.escalateTo}
                  users={userOptions}
                  roles={roleOptions}
                  optional
                  onChange={(escalateTo) => onChange({ escalateTo })}
                />
              </Col>
              <Col span={16}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.processEditor.escalateHint')}
                </Typography.Text>
              </Col>
            </Row>
          ) : null}

          <Typography.Text type="secondary">{t('web.processEditor.answers')}</Typography.Text>
          {(node.outcomes ?? []).map((outcome, index) => (
            <Row key={`${node.id}-outcome-${String(index)}`} gutter={8} align="middle">
              <Col span={5}>
                <Input
                  size="small"
                  value={outcome.label}
                  placeholder="Approve"
                  onChange={(event) => {
                    const outcomes = [...(node.outcomes ?? [])];
                    const current = outcomes[index];
                    if (current === undefined) return;
                    outcomes[index] = { ...current, label: event.target.value, value: slug(event.target.value) };
                    onChange({ outcomes });
                  }}
                />
              </Col>
              <Col span={4}>
                <Input
                  size="small"
                  value={outcome.value}
                  placeholder="approved"
                  onChange={(event) => {
                    const outcomes = [...(node.outcomes ?? [])];
                    const current = outcomes[index];
                    if (current === undefined) return;
                    outcomes[index] = { ...current, value: event.target.value };
                    onChange({ outcomes });
                  }}
                />
              </Col>
              <Col span={8}>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={outcome.next || null}
                  placeholder={t('web.processEditor.continuesAtPlaceholder')}
                  options={targetOptions}
                  onChange={(next) => {
                    const outcomes = [...(node.outcomes ?? [])];
                    const current = outcomes[index];
                    if (current === undefined) return;
                    outcomes[index] = { ...current, next };
                    onChange({ outcomes });
                  }}
                />
              </Col>
              <Col span={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.processEditor.goesTo', { target: (nodes.find((entry) => entry.id === outcome.next)?.name) || '…' })}
                </Typography.Text>
              </Col>
              <Col>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={t('web.processEditor.removeAnswerAria', { label: outcome.label })}
                  onClick={() => onChange({ outcomes: (node.outcomes ?? []).filter((_entry, position) => position !== index) })}
                />
              </Col>
            </Row>
          ))}
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              const outcomes: ProcessOutcomeSpec[] = [...(node.outcomes ?? []), { value: 'new-answer', label: t('web.processEditor.defaultAnswer'), next: node.outcomes?.[0]?.next ?? '' }];
              onChange({ outcomes });
            }}
          >
            {t('web.processEditor.addAnswer')}
          </Button>
        </Space>
      ) : null}

      {node.type === 'serviceTask' ? (
        <Row gutter={12}>
          <Col span={6}>
            <Typography.Text type="secondary">{t('web.workflowEditor.action')}</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={node.action ?? null}
              options={(catalog?.actions ?? []).map((action) => ({ value: action.name, label: action.label }))}
              onChange={(action: string) =>
                onChange({ action, name: catalog?.actions.find((entry) => entry.name === action)?.label ?? action, params: defaultParamsOf(action) })
              }
            />
          </Col>
          <Col span={5}>
            <Typography.Text type="secondary">{t('web.workflowEditor.stepName')}</Typography.Text>
            <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
          </Col>
          <Col span={7}>
            <Typography.Text type="secondary">{t('web.workflowEditor.parameters')}</Typography.Text>
            <ParamsEditor action={node.action ?? ''} params={node.params ?? {}} onChange={(params) => onChange({ params })} />
          </Col>
          <Col span={4}>
            <Typography.Text type="secondary">{t('web.processEditor.continuesAt')}</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={node.next || null}
              placeholder={t('web.processEditor.nextStepPlaceholder')}
              options={targetOptions}
              onChange={(next) => onChange({ next })}
            />
          </Col>
          <Col span={2}>
            <Typography.Text type="secondary">{t('web.processEditor.onError')}</Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={node.onError ?? 'fail'}
              options={[
                { value: 'fail', label: t('web.processEditor.stop') },
                { value: 'continue', label: t('web.processEditor.continueLabel') },
              ]}
              onChange={(onError: 'fail' | 'continue') => onChange({ onError })}
            />
          </Col>
        </Row>
      ) : null}

      {node.type === 'gateway' ? (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Row gutter={12}>
            <Col span={6}>
              <Typography.Text type="secondary">{t('web.workflowEditor.stepName')}</Typography.Text>
              <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
            </Col>
            <Col span={8}>
              <Typography.Text type="secondary">{t('web.processEditor.defaultTarget')}</Typography.Text>
              <Select
                style={{ width: '100%' }}
                value={node.default || null}
                placeholder={t('web.processEditor.defaultStepPlaceholder')}
                options={targetOptions}
                onChange={(value) => onChange({ default: value })}
              />
            </Col>
          </Row>
          {(node.branches ?? []).map((branch, index) => (
            <Row key={`${node.id}-branch-${String(index)}`} gutter={8} align="middle">
              <Col span={10}>
                <Input
                  size="small"
                  value={branch.when}
                  placeholder={"number(field('amount')) > 10000"}
                  onChange={(event) => {
                    const branches = [...(node.branches ?? [])];
                    const current = branches[index];
                    if (current === undefined) return;
                    branches[index] = { ...current, when: event.target.value };
                    onChange({ branches });
                  }}
                />
              </Col>
              <Col span={8}>
                <Select
                  size="small"
                  style={{ width: '100%' }}
                  value={branch.next || null}
                  placeholder={t('web.processEditor.goesToPlaceholder')}
                  options={targetOptions}
                  onChange={(next) => {
                    const branches = [...(node.branches ?? [])];
                    const current = branches[index];
                    if (current === undefined) return;
                    branches[index] = { ...current, next };
                    onChange({ branches });
                  }}
                />
              </Col>
              <Col span={4}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.processEditor.firstMatchWins')}
                </Typography.Text>
              </Col>
              <Col>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={t('web.processEditor.removeBranchAria', { index: String(index + 1) })}
                  onClick={() => onChange({ branches: (node.branches ?? []).filter((_entry, position) => position !== index) })}
                />
              </Col>
            </Row>
          ))}
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => onChange({ branches: [...(node.branches ?? []), { when: '', next: node.default ?? '' }] })}
          >
            {t('web.processEditor.addCondition')}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.processEditor.formulaHint')}
          </Typography.Text>
        </Space>
      ) : null}

      <Space style={{ marginTop: 8 }} wrap>
        <Select
          size="small"
          style={{ width: 220 }}
          placeholder={t('web.workflowEditor.addStep')}
          // A "picker" rather than a value: choosing an entry inserts that step after this node.
          value={null}
          onChange={(value: string) => {
            if (value === '__userTask') onAddUserTask();
            else if (value === '__gateway') onAddGateway();
            else if (value === '__end') onAddEnd();
            else onAddServiceTask(value);
          }}
          options={[
            { value: '__userTask', label: t('web.processEditor.addUserTask') },
            { value: '__gateway', label: t('web.processEditor.addGateway') },
            { value: '__end', label: t('web.processEditor.addEnd') },
            ...(catalog?.actions ?? []).map((action) => ({ value: action.name, label: t('web.processEditor.addServiceTask', { label: action.label }) })),
          ]}
        />
        <Tooltip title={t('web.processEditor.continueHint')}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ↓ {t('web.processEditor.continuesBelow')}
          </Typography.Text>
        </Tooltip>
      </Space>
    </Card>
  );
}

/** Who is responsible for a task: a user, the members of a role, or whoever the record points at. */
function AssigneePicker({
  spec,
  users,
  roles,
  onChange,
  optional,
}: {
  spec: ProcessAssigneeSpec | undefined;
  users: { value: string; label: string }[];
  roles: { value: string; label: string }[];
  onChange: (spec: ProcessAssigneeSpec | undefined) => void;
  optional?: boolean;
}) {
  const type = spec?.type ?? 'user';
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Select
        size="small"
        style={{ width: '42%' }}
        value={type}
        options={[
          { value: 'user', label: t('web.processEditor.assigneeUser') },
          { value: 'role', label: t('web.processEditor.assigneeRole') },
          { value: 'recordField', label: t('web.processEditor.assigneeRecordField') },
        ]}
        onChange={(nextType: ProcessAssigneeSpec['type']) => onChange({ type: nextType, value: spec?.value ?? '' })}
      />
      {type === 'recordField' ? (
        <Input
          size="small"
          value={spec?.value ?? ''}
          placeholder="assignedUserId"
          onChange={(event) => onChange({ type: 'recordField', value: event.target.value })}
        />
      ) : (
        <Select
          size="small"
          showSearch
          style={{ width: '58%' }}
          value={spec?.value || null}
          placeholder={type === 'role' ? t('web.processEditor.roleNamePlaceholder') : t('web.processEditor.userPlaceholder')}
          options={type === 'role' ? roleOptionsWithEmpty(roles, optional) : userOptionsWithEmpty(users, optional)}
          onChange={(value: string) => onChange({ type, value })}
          notFoundContent={type === 'role' ? t('web.processEditor.noRoles') : t('web.processEditor.noUsers')}
        />
      )}
    </Space.Compact>
  );
}

function userOptionsWithEmpty(users: { value: string; label: string }[], optional: boolean | undefined): { value: string; label: string }[] {
  return optional === true ? [{ value: '', label: '—' }, ...users] : users;
}

function roleOptionsWithEmpty(roles: { value: string; label: string }[], optional: boolean | undefined): { value: string; label: string }[] {
  return optional === true ? [{ value: '', label: '—' }, ...roles] : roles;
}

/** Instance history for this one process: what it did, on which records, and how it ended. */
function InstanceMiniTable({ instances, loading }: { instances: ProcessInstanceView[]; loading: boolean }) {
  const shown = useMemo(() => instances.slice(0, 10), [instances]);
  return (
    <Table<ProcessInstanceView>
      rowKey="id"
      size="small"
      loading={loading}
      dataSource={shown}
      pagination={false}
      locale={{ emptyText: t('web.processEditor.noInstances') }}
      columns={[
        { title: t('web.adminAudit.record'), render: (_value: unknown, row) => `${row.entityType}/${row.entityId}` },
        {
          title: t('web.common.status'),
          dataIndex: 'status',
          render: (status: string, row) => (
            <Space size={4}>
              <Tag>{status}</Tag>
              {row.outcome !== null ? <Typography.Text type="secondary">{row.outcome}</Typography.Text> : null}
            </Space>
          ),
        },
        { title: t('web.workflows.started'), render: (_value: unknown, row) => row.startedAt.slice(0, 19).replace('T', ' ') },
        { title: t('web.workflows.error'), dataIndex: 'error', render: (error: string | null) => error ?? '—' },
      ]}
    />
  );
}

/** A button-friendly answer value: the label, lowercased and dashed. */
function slug(label: string): string {
  const value = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value === '' ? 'answer' : value;
}
