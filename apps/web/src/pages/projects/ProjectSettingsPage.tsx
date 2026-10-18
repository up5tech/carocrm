import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Checkbox, DatePicker, Form, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';
import { ProjectShell,useErrorReporter, useProjectCapabilities, useProjectPlan, useProjectRefresh  } from './projectShared.js';

/**
 * Project settings and cloning (PLAN_Phase_19_Projects.md §4.11, §4.15).
 *
 * Each switch is a rule the API enforces as well: turning a feature off hides its controls here and
 * makes the server refuse a direct write to it — but nothing stored is erased, so switching it back
 * on shows the values again.
 */

const FEATURES = [
  { key: 'dependenciesEnabled', label: 'web.projects.featureDependencies' },
  { key: 'collaboratorsEnabled', label: 'web.projects.featureCollaborators' },
  { key: 'priorityEnabled', label: 'web.projects.featurePriority' },
  { key: 'pointsEnabled', label: 'web.projects.featurePoints' },
  { key: 'estimatedHoursEnabled', label: 'web.projects.featureHours' },
  { key: 'ganttEnabled', label: 'web.projects.featureGantt' },
] as const;

export function ProjectSettingsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const refresh = useProjectRefresh(id);
  const plan = useProjectPlan(id);
  const capabilities = useProjectCapabilities(id);
  const project = plan.data?.project ?? {};
  const features = capabilities.data?.features ?? {};
  const canEdit = capabilities.data?.capabilities['editProject'] === true;

  const groups = useQuery({
    queryKey: ['projectGroupsForSettings', id],
    queryFn: async () => {
      const result = await api.list('ProjectGroup', { where: [{ field: 'projectId', operator: 'equals', value: id }], orderBy: 'sortOrder', maxSize: 200, total: false });
      return result.list.map((row) => ({ value: String(row['id']), label: String(row['name'] ?? '') }));
    },
  });

  const save = async (input: Record<string, unknown>): Promise<void> => {
    try {
      await api.projectSettings(id, input);
      void message.success(t('web.projects.settingsSaved'));
      refresh();
    } catch (error) {
      report(error);
    }
  };

  return (
    <ProjectShell project={project} capabilities={capabilities.data} active="settings" loading={plan.isLoading} error={plan.error}>
      <Card className="carocrm-card" title={t('web.projects.featureSettings')} size="small">
        <Space direction="vertical" size={6}>
          {FEATURES.map((feature) => (
            <Space key={feature.key} align="center">
              <Switch
                checked={features[feature.key] === true}
                disabled={!canEdit}
                onChange={(checked) => void save({ [feature.key]: checked })}
                aria-label={t(feature.label)}
              />
              <Typography.Text>{t(feature.label)}</Typography.Text>
            </Space>
          ))}
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
          {t('web.projects.featureNote')}
        </Typography.Paragraph>
      </Card>

      <Card className="carocrm-card" title={t('web.projects.defaultGroup')} size="small" style={{ marginTop: 12 }}>
        <Select
          style={{ width: 240 }}
          disabled={!canEdit}
          allowClear
          value={typeof project['activeGroupId'] === 'string' ? project['activeGroupId'] : null}
          options={groups.data ?? []}
          placeholder={t('web.projects.noDefaultGroup')}
          onChange={(value) => void save({ activeGroupId: value ?? null })}
        />
      </Card>

      <ClonePanel projectId={id} projectName={String(project['name'] ?? '')} canClone={canEdit} />
    </ProjectShell>
  );
}

function ClonePanel({ projectId, projectName, canClone }: { projectId: string; projectName: string; canClone: boolean }) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const report = useErrorReporter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ name: string; dateStart?: dayjs.Dayjs | null; copyMembers: boolean; copyTaskOwners: boolean; copyTaskAssignees: boolean; copyAttachments: boolean }>();

  const run = async (): Promise<void> => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const result = await api.cloneProject(projectId, {
        name: values.name,
        ...(values.dateStart !== undefined && values.dateStart !== null ? { dateStart: values.dateStart.format('YYYY-MM-DD') } : {}),
        copyMembers: values.copyMembers,
        copyTaskOwners: values.copyTaskOwners,
        copyTaskAssignees: values.copyTaskAssignees,
        copyAttachments: values.copyAttachments,
      });
      void message.success(t('web.projects.cloneDone'));
      // The clone is a new project: go to it, which is also how the user verifies it worked.
      navigate(`/Project/${encodeURIComponent(result.projectId)}/plan`);
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="carocrm-card" title={t('web.projects.cloneTitle')} size="small" style={{ marginTop: 12 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('web.projects.cloneNote')}
      </Typography.Paragraph>
      <Button type="primary" disabled={!canClone} onClick={() => { setOpen(true); form.setFieldsValue({ name: `${projectName} (copy)`, dateStart: dayjs(), copyMembers: true, copyTaskOwners: true, copyTaskAssignees: false, copyAttachments: false }); }}>
        {t('web.projects.cloneAction')}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} confirmLoading={saving} onOk={() => void run()} okText={t('web.projects.cloneAction')} title={t('web.projects.cloneTitle')} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('web.projects.cloneName')} rules={[{ required: true, message: t('web.projects.nameRequired') }]}>
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="dateStart" label={t('web.projects.cloneStartDate')}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.projects.cloneShiftNote')}
          </Typography.Text>
          <Form.Item name="copyMembers" valuePropName="checked">
            <Checkbox>{t('web.projects.cloneMembers')}</Checkbox>
          </Form.Item>
          <Form.Item name="copyTaskOwners" valuePropName="checked">
            <Checkbox>{t('web.projects.cloneOwners')}</Checkbox>
          </Form.Item>
          <Form.Item name="copyTaskAssignees" valuePropName="checked">
            <Checkbox>{t('web.projects.cloneAssignees')}</Checkbox>
          </Form.Item>
          <Form.Item name="copyAttachments" valuePropName="checked">
            <Checkbox>{t('web.projects.cloneAttachments')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

