import { App as AntApp, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { ProjectCapabilities, ProjectPlanView, ProjectStageRow, ProjectTaskRow } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { PROJECT_STATUS_COLORS, useErrorReporter, useProjectRefresh } from './projectShared.js';

/**
 * The task and milestone editor (PLAN_Phase_19_Projects.md §8.2).
 *
 * A control appears only when the project has that feature on *and* the server says the caller may
 * use it; the same rule is enforced again by the API, so this is presentation, never permission
 * (§8.3). Status is shown but never editable — it follows the stage (§4.3).
 */

const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

interface FormValue {
  name: string;
  description?: string | undefined;
  groupId: string;
  stageId?: string | undefined;
  assigneeUserId?: string | null | undefined;
  dateStart?: Dayjs | null | undefined;
  dateEnd?: Dayjs | null | undefined;
  priority?: string | undefined;
  points?: number | null | undefined;
  estimateHours?: number | null | undefined;
}

interface Props {
  projectId: string;
  plan: ProjectPlanView | undefined;
  stages: ProjectStageRow[];
  capabilities: ProjectCapabilities | undefined;
  /** The task being edited, or null when creating. */
  task: ProjectTaskRow | null;
  defaultGroupId?: string | undefined;
  /** Set when creating a subtask: sent to the server as the parent. */
  parentTaskId?: string | null | undefined;
  milestone?: boolean;
  open: boolean;
  onClose: () => void;
  users: { value: string; label: string }[];
}

/** The form holds a Dayjs; the API wants a calendar day. */
function day(value: Dayjs | null | undefined): string | undefined {
  return value === undefined || value === null ? undefined : value.format('YYYY-MM-DD');
}

function toDayjs(value: string | null | undefined): Dayjs | null {
  if (value === null || value === undefined || value === '') return null;
  return dayjs(String(value).slice(0, 10));
}

export function ProjectTaskModal({ projectId, plan, stages, capabilities, task, defaultGroupId, parentTaskId, milestone = false, open, onClose, users }: Props) {
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(projectId);
  const [form] = Form.useForm<FormValue>();
  const [saving, setSaving] = useState(false);
  const features = capabilities?.features ?? {};

  const groups = useMemo(
    () => (plan?.groups ?? []).map((entry) => ({ value: String(entry.group['id']), label: String(entry.group['name'] ?? '') })),
    [plan],
  );

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: task?.name ?? '',
      description: undefined,
      groupId: task?.groupId ?? defaultGroupId ?? groups[0]?.value ?? '',
      stageId: task?.stageId ?? undefined,
      assigneeUserId: task?.assigneeUserId ?? null,
      dateStart: toDayjs(task?.dateStart),
      dateEnd: toDayjs(task?.dateEnd),
      priority: task?.priority ?? undefined,
      points: task?.points ?? null,
      estimateHours: task?.estimateHours ?? null,
    });
  }, [open, task, defaultGroupId, groups, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const start = day(values.dateStart);
    const end = day(values.dateEnd);
    const payload: Record<string, unknown> = {
      name: values.name,
      groupId: values.groupId,
      taskType: milestone || task?.taskType === 'Milestone' ? 'Milestone' : 'Task',
      ...(values.description !== undefined && values.description !== '' ? { description: values.description } : {}),
      ...(values.stageId !== undefined ? { stageId: values.stageId } : {}),
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      ...(values.assigneeUserId !== undefined ? { assigneeUserId: values.assigneeUserId } : {}),
      ...(start !== undefined ? { dateStart: start } : {}),
      ...(end !== undefined ? { dateEnd: end } : {}),
      ...(features['priorityEnabled'] === true && values.priority !== undefined ? { priority: values.priority } : {}),
      ...(features['pointsEnabled'] === true && values.points !== undefined && values.points !== null ? { points: values.points } : {}),
      ...(features['estimatedHoursEnabled'] === true && values.estimateHours !== undefined && values.estimateHours !== null ? { estimateHours: values.estimateHours } : {}),
    };

    setSaving(true);
    try {
      if (task !== null) {
        await api.updateProjectTask(task.id, { ...payload, version: task.version });
        void message.success(t('web.projects.taskSaved'));
      } else if (milestone) {
        await api.createProjectMilestone(projectId, {
          groupId: values.groupId,
          name: values.name,
          dateStart: start ?? dayjs().format('YYYY-MM-DD'),
          ...(values.description !== undefined && values.description !== '' ? { description: values.description } : {}),
        });
        void message.success(t('web.projects.milestoneCreated'));
      } else {
        await api.createProjectTask(projectId, { projectId, ...payload });
        void message.success(t('web.projects.taskCreated'));
      }
      refresh();
      onClose();
    } catch (error) {
      // The server explains the refusal — a blocked dependency, a foreign stage, a disabled feature.
      report(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={saving}
      okText={task === null ? t('web.projects.create') : t('web.projects.save')}
      title={task === null ? (milestone ? t('web.projects.newMilestone') : t('web.projects.newTask')) : t('web.projects.editTask')}
      destroyOnHidden
      width={560}
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="name" label={t('web.projects.fieldName')} rules={[{ required: true, message: t('web.projects.nameRequired') }]}>
          <Input autoFocus maxLength={255} />
        </Form.Item>
        <Form.Item name="description" label={t('web.projects.fieldDescription')}>
          <Input.TextArea rows={3} />
        </Form.Item>
        <Space wrap>
          <Form.Item name="groupId" label={t('web.projects.fieldGroup')} rules={[{ required: true, message: t('web.projects.groupRequired') }]}>
            <Select style={{ width: 170 }} options={groups} />
          </Form.Item>
          <Form.Item name="stageId" label={t('web.projects.fieldStage')} hidden={milestone}>
            <Select style={{ width: 150 }} allowClear options={stages.map((stage) => ({ value: stage.id, label: stage.name }))} />
          </Form.Item>
          <Form.Item name="assigneeUserId" label={t('web.projects.fieldAssignee')}>
            <Select style={{ width: 170 }} allowClear showSearch optionFilterProp="label" options={users} placeholder={t('web.projects.unassigned')} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item name="dateStart" label={milestone ? t('web.projects.fieldMilestoneDate') : t('web.projects.fieldStart')}>
            <DatePicker />
          </Form.Item>
          <Form.Item name="dateEnd" label={t('web.projects.fieldEnd')} hidden={milestone}>
            <DatePicker />
          </Form.Item>
          {features['priorityEnabled'] === true ? (
            <Form.Item name="priority" label={t('web.projects.fieldPriority')}>
              <Select style={{ width: 110 }} allowClear options={PRIORITIES.map((value) => ({ value, label: value }))} />
            </Form.Item>
          ) : null}
          {features['pointsEnabled'] === true ? (
            <Form.Item name="points" label={t('web.projects.fieldPoints')}>
              <InputNumber style={{ width: 90 }} min={0} step={1} />
            </Form.Item>
          ) : null}
          {features['estimatedHoursEnabled'] === true ? (
            <Form.Item name="estimateHours" label={t('web.projects.fieldHours')}>
              <InputNumber style={{ width: 100 }} min={0} step={0.5} />
            </Form.Item>
          ) : null}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {task === null ? (
            <Tag>{t('web.projects.statusFollowsStage')}</Tag>
          ) : (
            <>
              {t('web.projects.currentStatus')} <Tag color={PROJECT_STATUS_COLORS[task.status ?? ''] ?? 'default'}>{task.status}</Tag>
            </>
          )}
        </Typography.Text>
      </Form>
    </Modal>
  );
}

/** The status pill every Projects view shares. */
export function statusTag(status: string | null): React.ReactNode {
  if (status === null || status === '') return null;
  return <Tag color={PROJECT_STATUS_COLORS[status] ?? 'default'}>{status}</Tag>;
}
