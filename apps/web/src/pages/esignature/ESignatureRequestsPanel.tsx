import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { api } from '../../api/client.js';
import type { ESignatureRequestDocument, ESignatureRequestListRow, ESignatureRequestRecipient, ESignatureRequestView } from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.6 — the signature request list and draft editor
 * (`PLAN_Phase_19_ESignature.md` §8.2, §13.2, §13.3, §18 `19-ES.6`).
 *
 * The acceptance the screen exists for: a user can **create, edit and view a draft**. Everything it
 * shows is the server's answer — the list query is filtered and scoped server-side, the detail carries
 * `editable` from the state machine, and a linked CRM record whose own ACL hides it arrives with
 * `accessible: false` and no name, which this screen renders as "restricted" rather than inventing one.
 *
 * Sending is not here: the wizard (§13.3) and the send guard arrive with ES.8–ES.10. Until then a draft
 * stops at documents and recipients, which is exactly what this phase owns.
 */

const SOURCE_ENTITIES = ['Account', 'Contact', 'Quote', 'Project', 'Case', 'Campaign', 'CustomerSuccessProfile'] as const;
const STATUS_FILTERS = ['draft', 'pending_approval', 'ready_to_send', 'sending', 'sent', 'completed', 'declined', 'voided', 'expired'] as const;

interface RecipientDraft {
  name: string;
  email: string;
  recipientType: 'signer' | 'carbon_copy';
  routingOrder: number;
}

interface EditorValues {
  name: string;
  subject?: string;
  message?: string;
  sourceEntityType?: string;
  sourceRecordId?: string;
  recipients: RecipientDraft[];
}

type DrawerState = { mode: 'create' } | { mode: 'view' | 'edit'; id: string };

export function ESignatureRequestsPanel(props: { readonly canPrepare: boolean }) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  const requests = useQuery({
    queryKey: ['eSignature', 'requests', status],
    queryFn: () => api.eSignatureRequests({ status, limit: 100 }),
    staleTime: 10_000,
  });

  const reload = () => void queryClient.invalidateQueries({ queryKey: ['eSignature', 'requests'] });
  // The detail is its own query: a save or a document change must invalidate it too, or the drawer
  // keeps rendering the copy it fetched before the edit.
  const reloadDetail = (id: string) => void queryClient.invalidateQueries({ queryKey: ['eSignature', 'request', id] });

  const columns: ColumnsType<ESignatureRequestListRow> = [
    {
      title: t('esignature.requests.columnName'),
      dataIndex: 'name',
      render: (name: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sourceText(row.source)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('esignature.requests.columnStatus'),
      dataIndex: 'status',
      width: 180,
      render: (value: string) => <Tag color={statusColor(value)}>{t(`esignature.requests.statuses.${value}`)}</Tag>,
    },
    {
      title: t('esignature.requests.columnApproval'),
      dataIndex: 'approvalStatus',
      width: 150,
      render: (value: string) =>
        value === 'not_required' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tag color={value === 'approved' ? 'green' : value === 'rejected' ? 'red' : 'orange'}>{t(`esignature.requests.approvalStatuses.${value}`)}</Tag>
        ),
    },
    {
      title: t('esignature.requests.columnUpdated'),
      dataIndex: 'modifiedAt',
      width: 190,
      render: (value: string) => <Typography.Text type="secondary">{formatMoment(value)}</Typography.Text>,
    },
  ];

  if (requests.isLoading) return <LoadingSkeleton rows={4} />;
  if (requests.isError || requests.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.requests.loadFailed')} ${requests.error instanceof Error ? requests.error.message : ''}`}
        onRetry={() => void requests.refetch()}
      />
    );
  }

  return (
    <Card
      className="carocrm-card"
      title={t('esignature.requests.title')}
      extra={
        <Space size={8} wrap>
          <Select
            size="small"
            style={{ minWidth: 160 }}
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: t('esignature.requests.allStatuses') },
              ...STATUS_FILTERS.map((value) => ({ value, label: t(`esignature.requests.statuses.${value}`) })),
            ]}
          />
          <Button size="small" onClick={() => void requests.refetch()}>
            {t('core.common.reload')}
          </Button>
          {props.canPrepare ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ mode: 'create' })}>
              {t('esignature.requests.create')}
            </Button>
          ) : null}
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {requests.data.list.length === 0 ? (
        <EmptyState title={t('esignature.requests.empty')} description={t('esignature.requests.emptyHint')} />
      ) : (
        <Table<ESignatureRequestListRow>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={[...requests.data.list]}
          columns={columns}
          onRow={(row) => ({ onClick: () => setDrawer({ mode: 'view', id: row.id }), style: { cursor: 'pointer' } })}
        />
      )}

      <Drawer
        open={drawer !== null}
        width={720}
        title={drawer?.mode === 'create' ? t('esignature.requests.create') : t('esignature.requests.detail')}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        {drawer === null ? null : drawer.mode === 'create' ? (
          <RequestEditor
            mode="create"
            canPrepare={props.canPrepare}
            onSaved={(saved) => {
              message.success(t('esignature.requests.created'));
              reload();
              setDrawer({ mode: 'view', id: saved.id });
            }}

          />
        ) : (
          <RequestDetail
            key={drawer.id}
            id={drawer.id}
            mode={drawer.mode}
            canPrepare={props.canPrepare}
            onEdit={() => setDrawer({ mode: 'edit', id: drawer.id })}
            onSaved={() => {
              message.success(t('esignature.requests.saved'));
              reload();
              reloadDetail(drawer.id);
              setDrawer({ mode: 'view', id: drawer.id });
            }}
            onDocumentsChanged={() => {
              reload();
              reloadDetail(drawer.id);
            }}
          />
        )}
      </Drawer>
    </Card>
  );
}

function RequestDetail(props: {
  id: string;
  mode: 'view' | 'edit';
  canPrepare: boolean;
  onEdit: () => void;
  onSaved: () => void;
  onDocumentsChanged: () => void;
}) {
  const detail = useQuery({ queryKey: ['eSignature', 'request', props.id], queryFn: () => api.eSignatureRequest(props.id) });
  if (detail.isLoading) return <LoadingSkeleton rows={8} />;
  if (detail.isError || detail.data === undefined) {
    return <ErrorState message={`${t('esignature.requests.loadFailed')} ${detail.error instanceof Error ? detail.error.message : ''}`} onRetry={() => void detail.refetch()} />;
  }
  const request = detail.data;
  if (props.mode === 'edit') {
    return (
      <RequestEditor
        mode="edit"
        request={request}
        canPrepare={props.canPrepare}
        onSaved={props.onSaved}
        onDocumentsChanged={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
    );
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Tag color={statusColor(request.status)}>{t(`esignature.requests.statuses.${request.status}`)}</Tag>
        {request.editable ? <Tag color="blue">{t('esignature.requests.editable')}</Tag> : <Tag>{t('esignature.requests.frozen')}</Tag>}
        {request.approvalStatus === 'not_required' ? null : <Tag color="orange">{t(`esignature.requests.approvalStatuses.${request.approvalStatus}`)}</Tag>}
        {request.editable && props.canPrepare ? (
          <Button size="small" icon={<EditOutlined />} onClick={props.onEdit}>
            {t('esignature.requests.edit')}
          </Button>
        ) : null}
      </Space>

      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label={t('esignature.requests.fieldName')}>{request.name}</Descriptions.Item>
        <Descriptions.Item label={t('esignature.requests.fieldSource')}>{sourceText(request.source)}</Descriptions.Item>
        <Descriptions.Item label={t('esignature.requests.fieldSubject')}>{request.subject ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('esignature.requests.fieldMessage')}>{request.message ?? '—'}</Descriptions.Item>
        <Descriptions.Item label={t('esignature.requests.fieldExpiresAt')}>{request.expiresAt === null ? '—' : formatMoment(request.expiresAt)}</Descriptions.Item>
        <Descriptions.Item label={t('esignature.requests.fieldUpdated')}>{formatMoment(request.modifiedAt)}</Descriptions.Item>
      </Descriptions>

      <RecipientsTable recipients={[...request.recipients]} />
      <DocumentsList
        requestId={request.id}
        documents={[...request.documents]}
        editable={request.editable && props.canPrepare}
        onChanged={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
    </Space>
  );
}

function RequestEditor(props: {
  mode: 'create' | 'edit';
  request?: ESignatureRequestView;
  canPrepare: boolean;
  onSaved: (saved: ESignatureRequestView) => void;
  onDocumentsChanged?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<EditorValues>();
  const request = props.request;
  const [pending, setPending] = useState(false);

  const initial: EditorValues =
    request === undefined
      ? { name: '', recipients: [{ name: '', email: '', recipientType: 'signer', routingOrder: 1 }] }
      : {
          name: request.name,
          ...(request.subject === null ? {} : { subject: request.subject }),
          ...(request.message === null ? {} : { message: request.message }),
          ...(request.source === null ? {} : { sourceEntityType: request.source.entityType, sourceRecordId: request.source.recordId }),
          recipients: request.recipients.map((recipient) => ({
            name: recipient.name,
            email: recipient.email,
            recipientType: recipient.recipientType,
            routingOrder: recipient.routingOrder,
          })),
        };

  const save = async (values: EditorValues): Promise<void> => {
    setPending(true);
    try {
      const recipients = values.recipients
        .filter((entry) => entry.name.trim() !== '' && entry.email.trim() !== '')
        .map((entry, index) => ({ ...entry, routingOrder: entry.routingOrder ?? index + 1 }));
      const source: Record<string, unknown> =
        props.mode === 'create'
          ? // Creation omits an unset link; the strict create shape has no nullable source fields.
            {
              ...(values.sourceEntityType === undefined || values.sourceEntityType === '' ? {} : { sourceEntityType: values.sourceEntityType }),
              ...(values.sourceRecordId === undefined || values.sourceRecordId === '' ? {} : { sourceRecordId: values.sourceRecordId }),
            }
          : // An edit may *clear* the link, which the update shape spells as null.
            { sourceEntityType: values.sourceEntityType ?? null, sourceRecordId: values.sourceRecordId ?? null };
      const body: Record<string, unknown> = {
        name: values.name,
        subject: values.subject ?? '',
        message: values.message ?? '',
        ...source,
      };
      const saved =
        props.mode === 'create'
          ? await api.createESignatureRequest(body)
          : await api.updateESignatureRequest(String(request?.id), { ...body, version: request?.version });
      if (recipients.length > 0) await api.saveESignatureRequestRecipients(saved.id, recipients);
      props.onSaved(saved);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.requests.saveFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Form form={form} layout="vertical" initialValues={initial} onFinish={(values) => void save(values)}>
      {props.mode === 'create' ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('esignature.requests.createHint')} /> : null}
      <Form.Item name="name" label={t('esignature.requests.fieldName')} rules={[{ required: true, max: 200 }]}>
        <Input maxLength={200} />
      </Form.Item>
      <Form.Item name="subject" label={t('esignature.requests.fieldSubject')}>
        <Input maxLength={300} />
      </Form.Item>
      <Form.Item name="message" label={t('esignature.requests.fieldMessage')}>
        <Input.TextArea rows={3} maxLength={5000} showCount />
      </Form.Item>
      <Space size={8} style={{ display: 'flex' }}>
        <Form.Item name="sourceEntityType" label={t('esignature.requests.fieldSourceEntity')} style={{ flex: 1 }}>
          <AutoComplete options={SOURCE_ENTITIES.map((value) => ({ value }))} placeholder="Quote" />
        </Form.Item>
        <Form.Item name="sourceRecordId" label={t('esignature.requests.fieldSourceRecord')} style={{ flex: 2 }}>
          <Input maxLength={64} placeholder={t('esignature.requests.sourceRecordHint')} />
        </Form.Item>
      </Space>

      <Typography.Title level={5}>{t('esignature.requests.recipients')}</Typography.Title>
      <Form.List name="recipients">
        {(fields, { add, remove }) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {fields.map((field) => (
              <Space key={field.key} align="baseline" style={{ display: 'flex' }}>
                <Form.Item name={[field.name, 'name']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                  <Input placeholder={t('esignature.requests.recipientName')} maxLength={200} />
                </Form.Item>
                <Form.Item name={[field.name, 'email']} rules={[{ required: true, type: 'email' }]} style={{ marginBottom: 0 }}>
                  <Input placeholder={t('esignature.requests.recipientEmail')} maxLength={320} />
                </Form.Item>
                <Form.Item name={[field.name, 'recipientType']} style={{ marginBottom: 0 }}>
                  <Select
                    style={{ width: 130 }}
                    options={[
                      { value: 'signer', label: t('esignature.requests.recipientTypes.signer') },
                      { value: 'carbon_copy', label: t('esignature.requests.recipientTypes.carbon_copy') },
                    ]}
                  />
                </Form.Item>
                <Form.Item name={[field.name, 'routingOrder']} style={{ marginBottom: 0 }}>
                  <InputNumber min={1} max={100} style={{ width: 70 }} />
                </Form.Item>
                <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label={t('esignature.requests.removeRecipient')} />
              </Space>
            ))}
            <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => add({ name: '', email: '', recipientType: 'signer', routingOrder: fields.length + 1 })}>
              {t('esignature.requests.addRecipient')}
            </Button>
          </Space>
        )}
      </Form.List>

      {props.mode === 'edit' && request !== undefined ? (
        <>
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('esignature.requests.documents')}
          </Typography.Title>
          <DocumentsList
            requestId={request.id}
            documents={[...request.documents]}
            editable={request.editable && props.canPrepare}
            onChanged={() => props.onDocumentsChanged?.()}
          />
        </>
      ) : null}

      <Space style={{ marginTop: 20 }}>
        <Button type="primary" htmlType="submit" loading={pending}>
          {t('core.common.save')}
        </Button>
      </Space>
    </Form>
  );
}

function RecipientsTable(props: { recipients: ESignatureRequestRecipient[] }) {
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('esignature.requests.recipients')}
      </Typography.Title>
      {props.recipients.length === 0 ? (
        <Typography.Text type="secondary">{t('esignature.requests.noRecipients')}</Typography.Text>
      ) : (
        <Table<ESignatureRequestRecipient>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={props.recipients}
          columns={[
            { title: t('esignature.requests.recipientName'), dataIndex: 'name' },
            { title: t('esignature.requests.recipientEmail'), dataIndex: 'email' },
            { title: t('esignature.requests.recipientType'), dataIndex: 'recipientType', render: (value: string) => t(`esignature.requests.recipientTypes.${value}`) },
            { title: t('esignature.requests.routingOrder'), dataIndex: 'routingOrder', width: 100 },
          ]}
        />
      )}
    </Space>
  );
}

function DocumentsList(props: {
  requestId: string;
  documents: ESignatureRequestDocument[];
  editable: boolean;
  onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const attachment = await api.uploadAttachment(file);
      await api.attachESignatureRequestDocument(props.requestId, attachment.id);
      message.success(t('esignature.requests.documentAttached'));
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.requests.documentFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space size={8}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('esignature.requests.documents')}
        </Typography.Title>
        {props.editable ? (
          <Upload
            accept=".pdf,.doc,.docx"
            showUploadList={false}
            beforeUpload={(file) => {
              void upload(file);
              return false;
            }}
          >
            <Button size="small" icon={<UploadOutlined />} loading={busy}>
              {t('esignature.requests.attachDocument')}
            </Button>
          </Upload>
        ) : null}
      </Space>
      {props.documents.length === 0 ? (
        <Typography.Text type="secondary">{t('esignature.requests.noDocuments')}</Typography.Text>
      ) : (
        <Table<ESignatureRequestDocument>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={props.documents}
          columns={[
            { title: '#', dataIndex: 'documentOrder', width: 50 },
            { title: t('esignature.requests.documentName'), dataIndex: 'displayName' },
            {
              title: t('esignature.requests.documentSize'),
              dataIndex: 'byteSize',
              width: 110,
              render: (value: number) => `${Math.max(1, Math.round(value / 1024))} KB`,
            },
            {
              title: t('esignature.requests.documentChecksum'),
              dataIndex: 'contentHashSha256',
              width: 180,
              render: (value: string) => (
                <Typography.Text code style={{ fontSize: 11 }}>
                  {value.slice(0, 16)}…
                </Typography.Text>
              ),
            },
            {
              title: '',
              key: 'actions',
              width: 90,
              render: (_unknown: unknown, row) => (
                <Space size={2}>
                  <Button
                    size="small"
                    type="text"
                    icon={<DownloadOutlined />}
                    aria-label={t('esignature.requests.download')}
                    onClick={() => {
                      void api
                        .downloadESignatureDocument(props.requestId, row.id, row.displayName)
                        .catch(() => message.error(t('esignature.requests.downloadFailed')));
                    }}
                  />
                  {props.editable ? (
                    <Popconfirm
                      title={t('esignature.requests.removeDocumentConfirm')}
                      okText={t('core.common.confirm')}
                      cancelText={t('core.common.cancel')}
                      onConfirm={() => {
                        void api
                          .detachESignatureRequestDocument(props.requestId, row.id)
                          .then(() => props.onChanged())
                          .catch((error: unknown) => message.error(error instanceof Error ? error.message : t('esignature.requests.documentFailed')));
                      }}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('esignature.requests.removeDocument')} />
                    </Popconfirm>
                  ) : null}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Space>
  );
}

/** A linked record: its name when the server could resolve one, "restricted" when it could not. */
function sourceText(source: ESignatureRequestListRow['source']): string {
  if (source === null) return t('esignature.requests.noSource');
  if (source.missing) return t('esignature.requests.sourceMissing', { entity: source.entityType });
  if (!source.accessible) return t('esignature.requests.sourceRestricted', { entity: source.entityType });
  return `${source.entityType}: ${source.label ?? source.recordId}`;
}

function statusColor(status: string): string {
  if (status === 'completed') return 'green';
  if (status === 'declined' || status === 'expired' || status === 'provider_error') return 'red';
  if (status === 'voided' || status === 'needs_reconciliation' || status === 'reconciliation_required') return 'volcano';
  if (status === 'sent' || status === 'delivered' || status === 'partially_signed') return 'blue';
  if (status === 'draft') return 'default';
  return 'gold';
}

function formatMoment(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
