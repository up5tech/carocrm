import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Checkbox, Drawer, Form, type FormInstance, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api,ApiError } from '../../api/client.js';
import type {
  ESignatureConnectionView,
  ESignatureTemplateCatalog,
  ESignatureTemplateDetail,
  ESignatureTemplateMapping,
  ESignatureTemplateSummary,
} from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.7 — the template catalog and mapping screen
 * (`PLAN_Phase_19_ESignature.md` §6.7, §13.1, §18 `19-ES.7`).
 *
 * Two halves, deliberately separate: the **catalog** is what the provider's account holds right now, and
 * the **mapping** is the CRM's configuration built from it. Refresh reads the first; nothing here ever
 * writes it back (the adapter has no method for that, plan §6.7).
 *
 * The editor generates its role and tab rows from the *live* template detail, so an administrator
 * chooses from names the provider actually has. The server validates again — this screen is a
 * convenience, not the enforcement — and its problems are rendered verbatim as the list of names that
 * did not line up.
 */

interface RoleRowValues {
  roleName: string;
  recipientType: 'signer' | 'carbon_copy';
  routingOrder: number;
  source: 'crmField' | 'manual';
  crmField: string;
}

interface FieldRowValues {
  tabName: string;
  crmField: string;
  required: boolean;
}

interface MappingFormValues {
  name: string;
  supportedSourceEntities: string[];
  roles: RoleRowValues[];
  fields: FieldRowValues[];
  defaultSubject?: string;
  defaultMessage?: string;
}

type DrawerState =
  | { mode: 'create'; template: ESignatureTemplateSummary; detail: ESignatureTemplateDetail }
  | { mode: 'edit'; mapping: ESignatureTemplateMapping; detail: ESignatureTemplateDetail };

const SOURCE_ENTITIES = ['Account', 'Contact', 'Quote', 'Project', 'Case', 'Campaign', 'CustomerSuccessProfile'] as const;

/** Tabs the signer fills themselves; they are shown but not expected to carry a CRM value. */
const SIGNER_FILLED = new Set(['signHere', 'initialHere', 'dateSigned', 'note', 'approve', 'decline']);

export function ESignatureTemplatesPanel() {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = useState<string>('');
  const [catalog, setCatalog] = useState<ESignatureTemplateCatalog | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const connections = useQuery({
    queryKey: ['eSignature', 'connections'],
    queryFn: () => api.eSignatureConnections(),
    staleTime: 30_000,
  });
  const selected = connectionId === '' ? undefined : connectionId;

  const mappings = useQuery({
    queryKey: ['eSignature', 'templateMappings', selected],
    queryFn: () => (selected === undefined ? Promise.resolve([]) : api.eSignatureTemplateMappings(selected)),
    enabled: selected !== undefined,
  });

  const refresh = async (): Promise<void> => {
    if (selected === undefined) return;
    setRefreshing(true);
    try {
      setCatalog(await api.eSignatureTemplateCatalog(selected));
      await queryClient.invalidateQueries({ queryKey: ['eSignature', 'templateMappings', selected] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.templates.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const openForTemplate = async (template: ESignatureTemplateSummary): Promise<void> => {
    if (selected === undefined) return;
    const existing = mappingRows.find((mapping) => mapping.providerTemplateId === template.templateId);
    if (existing !== undefined) {
      await openEdit(existing);
      return;
    }
    try {
      const detail = await api.eSignatureTemplateDetail(selected, template.templateId);
      setDrawer({ mode: 'create', template, detail });
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.templates.detailFailed'));
    }
  };

  const openEdit = async (mapping: ESignatureTemplateMapping): Promise<void> => {
    try {
      const detail = await api.eSignatureTemplateDetail(mapping.connectionId, mapping.providerTemplateId);
      setDrawer({ mode: 'edit', mapping, detail });
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.templates.detailFailed'));
    }
  };

  const toggleActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) => api.setESignatureTemplateMappingActive(input.id, input.active),
    onSuccess: () => {
      message.success(t('esignature.templates.saved'));
      void queryClient.invalidateQueries({ queryKey: ['eSignature', 'templateMappings', selected] });
    },
    onError: (error: Error) => message.error(error.message),
  });

  const options: readonly ESignatureConnectionView[] = connections.data ?? [];
  const rows = catalog?.templates ?? [];
  const mappingRows = mappings.data ?? [];

  return (
    <Card
      className="carocrm-card"
      title={t('esignature.templates.title')}
      extra={
        <Space size={8} wrap>
          <Select
            size="small"
            style={{ minWidth: 220 }}
            placeholder={t('esignature.templates.selectConnection')}
            value={selected ?? null}
            onChange={(value: string) => {
              setConnectionId(value);
              setCatalog(null);
            }}
            options={options.map((connection) => ({
              value: connection.id,
              label: `${connection.name} · ${t(`esignature.connections.environments.${connection.environment}`)}`,
            }))}
          />
          <Button size="small" icon={<ReloadOutlined />} loading={refreshing} disabled={selected === undefined} onClick={() => void refresh()}>
            {t('esignature.templates.refresh')}
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {connections.isError ? (
        <ErrorState message={t('esignature.templates.loadFailed')} onRetry={() => void connections.refetch()} />
      ) : options.length === 0 ? (
        <EmptyState title={t('esignature.templates.noConnections')} description={t('esignature.templates.noConnectionsHint')} />
      ) : selected === undefined ? (
        <Typography.Text type="secondary">{t('esignature.templates.selectConnectionHint')}</Typography.Text>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {catalog === null ? (
            <Typography.Text type="secondary">{t('esignature.templates.refreshHint')}</Typography.Text>
          ) : (
            <Table<ESignatureTemplateSummary>
              size="small"
              rowKey="templateId"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={[...rows]}
              columns={[
                {
                  title: t('esignature.templates.columnTemplate'),
                  dataIndex: 'name',
                  render: (name: string, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.templateId}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t('esignature.templates.columnShared'),
                  dataIndex: 'shared',
                  width: 120,
                  render: (shared: boolean) => (shared ? <Tag color="blue">{t('esignature.templates.shared')}</Tag> : <Tag>{t('esignature.templates.private')}</Tag>),
                },
                {
                  title: '',
                  key: 'actions',
                  width: 120,
                  render: (_unknown: unknown, row) => (
                    <Button size="small" onClick={() => void openForTemplate(row)}>
                      {mappingRows.some((mapping) => mapping.providerTemplateId === row.templateId) ? t('esignature.templates.editMapping') : t('esignature.templates.mapTemplate')}
                    </Button>
                  ),
                },
              ]}
            />
          )}

          {mappings.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : mappings.isError ? (
            <ErrorState message={t('esignature.templates.loadFailed')} onRetry={() => void mappings.refetch()} />
          ) : mappingRows.length === 0 ? (
            <EmptyState title={t('esignature.templates.noMappings')} description={t('esignature.templates.noMappingsHint')} />
          ) : (
            <Table<ESignatureTemplateMapping>
              size="small"
              rowKey="id"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={[...mappingRows]}
              columns={[
                {
                  title: t('esignature.templates.columnMapping'),
                  dataIndex: 'name',
                  render: (name: string, row) => (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{name}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.providerTemplateName ?? row.providerTemplateId}
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: t('esignature.templates.columnEntities'),
                  dataIndex: 'supportedSourceEntities',
                  render: (entities: readonly string[]) => (
                    <Space size={[4, 4]} wrap>
                      {entities.map((entity) => (
                        <Tag key={entity}>{entity}</Tag>
                      ))}
                    </Space>
                  ),
                },
                {
                  title: t('esignature.templates.columnActive'),
                  dataIndex: 'isActive',
                  width: 110,
                  render: (active: boolean, row) => (
                    <Switch size="small" checked={active} onChange={(checked) => toggleActive.mutate({ id: row.id, active: checked })} />
                  ),
                },
                {
                  title: '',
                  key: 'actions',
                  width: 110,
                  render: (_unknown: unknown, row) => (
                    <Button size="small" onClick={() => void openEdit(row)}>
                      {t('esignature.requests.edit')}
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Space>
      )}

      <Drawer
        open={drawer !== null}
        width={760}
        title={drawer?.mode === 'create' ? t('esignature.templates.mapTemplate') : t('esignature.templates.editMapping')}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        {drawer === null ? null : (
          <MappingEditor
            key={drawer.mode === 'create' ? drawer.template.templateId : drawer.mapping.id}
            drawer={drawer}
            onSaved={() => {
              message.success(t('esignature.templates.saved'));
              setDrawer(null);
              void queryClient.invalidateQueries({ queryKey: ['eSignature', 'templateMappings', selected] });
            }}
          />
        )}
      </Drawer>
    </Card>
  );
}

function MappingEditor(props: { drawer: DrawerState; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { drawer } = props;
  const [form] = Form.useForm<MappingFormValues>();
  const [pending, setPending] = useState(false);
  const [problems, setProblems] = useState<readonly { code: string; message: string; where: string }[]>([]);

  const initial: MappingFormValues = useMemo(() => {
    if (drawer.mode === 'edit') {
      const stored = drawer.mapping;
      return {
        name: stored.name,
        supportedSourceEntities: [...stored.supportedSourceEntities],
        roles: stored.roleMappings.map((role) => ({
          roleName: role.roleName,
          recipientType: role.recipientType,
          routingOrder: role.routingOrder,
          source: role.source,
          crmField: role.crmField ?? '',
        })),
        fields: stored.fieldMappings.map((field) => ({ tabName: field.tabName, crmField: field.crmField, required: field.required })),
        ...(stored.defaultSubject === null ? {} : { defaultSubject: stored.defaultSubject }),
        ...(stored.defaultMessage === null ? {} : { defaultMessage: stored.defaultMessage }),
      };
    }
    return {
      name: '',
      supportedSourceEntities: [],
      roles: drawer.detail.roles.map((role, index) => ({
        roleName: role.roleName,
        recipientType: role.recipientType === 'carbon_copy' ? 'carbon_copy' : 'signer',
        routingOrder: role.routingOrder ?? index + 1,
        source: 'manual',
        crmField: '',
      })),
      fields: drawer.detail.fields
        .filter((field) => !SIGNER_FILLED.has(field.fieldType ?? ''))
        .map((field) => ({ tabName: field.tabLabel, crmField: '', required: field.required })),
    };
  }, [drawer]);

  const save = async (values: MappingFormValues): Promise<void> => {
    setPending(true);
    setProblems([]);
    try {
      const roles = values.roles
        .filter((role) => (role.source === 'crmField' ? role.crmField.trim() !== '' : true))
        .map((role) => ({
          roleName: role.roleName,
          recipientType: role.recipientType,
          routingOrder: role.routingOrder,
          source: role.source,
          ...(role.source === 'crmField' ? { crmField: role.crmField.trim() } : { crmField: null }),
        }));
      const fields = values.fields
        .filter((field) => field.crmField.trim() !== '')
        .map((field) => ({ tabName: field.tabName, crmField: field.crmField.trim(), required: field.required === true }));
      const body = {
        name: values.name,
        supportedSourceEntities: values.supportedSourceEntities,
        roleMappings: roles,
        fieldMappings: fields,
        defaultSubject: values.defaultSubject ?? null,
        defaultMessage: values.defaultMessage ?? null,
      };
      if (drawer.mode === 'edit') {
        await api.updateESignatureTemplateMapping(drawer.mapping.id, { ...body, version: drawer.mapping.version });
      } else {
        await api.createESignatureTemplateMapping({
          ...body,
          mappingType: 'workflow',
          connectionId: drawer.detail.connectionId,
          providerTemplateId: drawer.template.templateId,
          isActive: true,
        });
      }
      props.onSaved();
    } catch (error) {
      if (error instanceof ApiError) {
        const raw = error.details?.['problems'];
        if (Array.isArray(raw)) setProblems(raw as { code: string; message: string; where: string }[]);
        else message.error(error.message);
      } else {
        message.error(error instanceof Error ? error.message : t('esignature.templates.saveFailed'));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Form form={form} layout="vertical" initialValues={initial} onFinish={(values) => void save(values)}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('esignature.templates.templateInfo', { name: drawer.detail.name })}
        description={t('esignature.templates.templateInfoHint')}
      />
      {problems.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('esignature.templates.problems')}
          description={
            <ul className="carocrm-admin-warnings">
              {problems.map((problem) => (
                <li key={`${problem.code}:${problem.where}`}>{problem.message}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <Form.Item name="name" label={t('esignature.templates.mappingName')} rules={[{ required: true, max: 160 }]}>
        <Input maxLength={160} />
      </Form.Item>
      <Form.Item
        name="supportedSourceEntities"
        label={t('esignature.templates.sourceEntities')}
        extra={t('esignature.templates.sourceEntitiesHint')}
        rules={[{ required: true, message: t('esignature.templates.sourceEntitiesRequired') }]}
      >
        <Select mode="tags" tokenSeparators={[',', ' ']} options={SOURCE_ENTITIES.map((value) => ({ value }))} />
      </Form.Item>

      <Typography.Title level={5}>{t('esignature.templates.roles')}</Typography.Title>
      <RolesEditor form={form} />
      <Typography.Title level={5}>{t('esignature.templates.fields')}</Typography.Title>
      <FieldsEditor form={form} detail={drawer.detail} />

      <Form.Item name="defaultSubject" label={t('esignature.templates.defaultSubject')}>
        <Input maxLength={300} />
      </Form.Item>
      <Form.Item name="defaultMessage" label={t('esignature.templates.defaultMessage')}>
        <Input.TextArea rows={2} maxLength={2000} />
      </Form.Item>

      <Button type="primary" htmlType="submit" loading={pending}>
        {t('core.common.save')}
      </Button>
    </Form>
  );
}

/** Role rows are generated from the template, so a role name cannot be typed wrong. */
function RolesEditor(props: { form: FormInstance<MappingFormValues> }) {
  return (
    <Form.List name="roles">
      {(rows) => (
        <Table<{ key: number; name: number }>
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={rows.map((row) => ({ key: row.key, name: row.name }))}
          columns={[
            {
              title: t('esignature.templates.roleName'),
              render: (_unknown, row) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>{String(props.form.getFieldValue(['roles', row.name, 'roleName']) ?? '')}</Typography.Text>
                  <Form.Item name={[row.name, 'roleName']} hidden>
                    <Input />
                  </Form.Item>
                </Space>
              ),
            },
            {
              title: t('esignature.templates.roleSource'),
              width: 170,
              render: (_unknown, row) => (
                <Form.Item name={[row.name, 'source']} style={{ marginBottom: 0 }}>
                  <Select
                    options={[
                      { value: 'crmField', label: t('esignature.templates.sourceCrmField') },
                      { value: 'manual', label: t('esignature.templates.sourceManual') },
                    ]}
                  />
                </Form.Item>
              ),
            },
            {
              title: t('esignature.templates.roleField'),
              width: 220,
              render: (_unknown, row) => (
                <Form.Item name={[row.name, 'crmField']} style={{ marginBottom: 0 }}>
                  <Input placeholder="emailAddress" maxLength={120} />
                </Form.Item>
              ),
            },
            {
              title: t('esignature.requests.routingOrder'),
              width: 90,
              render: (_unknown, row) => (
                <Form.Item name={[row.name, 'routingOrder']} style={{ marginBottom: 0 }}>
                  <Input type="number" min={1} max={99} />
                </Form.Item>
              ),
            },
          ]}
        />
      )}
    </Form.List>
  );
}

/** Field rows are generated from the template's data tabs; signer-filled tabs are not listed. */
function FieldsEditor(props: { form: FormInstance<MappingFormValues>; detail: ESignatureTemplateDetail }) {
  return (
    <Form.List name="fields">
      {(rows) => (
        <Table<{ key: number; name: number }>
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={rows.map((row) => ({ key: row.key, name: row.name }))}
          columns={[
            {
              title: t('esignature.templates.tabName'),
              render: (_unknown, row) => {
                const tabLabel = String(props.form.getFieldValue(['fields', row.name, 'tabName']) ?? '');
                const meta = props.detail.fields.find((field) => field.tabLabel === tabLabel);
                return (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{tabLabel}</Typography.Text>
                    <Form.Item name={[row.name, 'tabName']} hidden>
                      <Input />
                    </Form.Item>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {[meta?.roleName ?? t('esignature.templates.anyRole'), meta?.fieldType ?? ''].filter(Boolean).join(' · ')}
                    </Typography.Text>
                  </Space>
                );
              },
            },
            {
              title: t('esignature.templates.fieldSource'),
              width: 240,
              render: (_unknown, row) => (
                <Form.Item name={[row.name, 'crmField']} style={{ marginBottom: 0 }}>
                  <Input placeholder="name" maxLength={120} />
                </Form.Item>
              ),
            },
            {
              title: t('esignature.templates.fieldRequired'),
              width: 120,
              render: (_unknown, row) => (
                <Form.Item name={[row.name, 'required']} valuePropName="checked" style={{ marginBottom: 0 }}>
                  <Checkbox />
                </Form.Item>
              ),
            },
          ]}
        />
      )}
    </Form.List>
  );
}
