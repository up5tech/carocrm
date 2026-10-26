import { DeleteOutlined, DownloadOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, AutoComplete, Button, Card, Checkbox, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Timeline, Tooltip, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import type {
  ESignatureRequestDocument,
  ESignatureRequestListRow,
  ESignatureRequestRecipient,
  ESignatureRequestView,
  ESignatureTimelineEntry,
} from '../../api/types.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-ES.6 — the signature request list and draft editor
 * (`PLAN_Phase_19_ESignature.md` §8.2, §13.2, §13.3, §18 `19-ES.6`).
 *
 * The list and the drawer are one screen on purpose: a request is reviewed, corrected and sent in the
 * same place it is found. Everything shown is the server's answer — the list query is filtered and
 * scoped server-side, the detail carries `editable` from the state machine, and a linked CRM record
 * whose own ACL hides it arrives with `accessible: false` and no name, which this screen renders as
 * "restricted" rather than inventing one.
 *
 * Sending is guarded server-side (§11.1): the preview, the confirmation, the approval policy and the
 * single-flight attempt live in `ESignatureRequestService`, and this screen only offers the verbs the
 * caller holds. A provider with no unsent draft (`providerDrafting: 'direct'`) skips the draft step,
 * because its create call *is* the send.
 */

const SOURCE_ENTITIES = ['Account', 'Contact', 'Quote', 'Project', 'Case', 'Campaign', 'CustomerSuccessProfile'] as const;
const STATUS_FILTERS = ['draft', 'pending_approval', 'ready_to_send', 'sending', 'sent', 'completed', 'declined', 'voided', 'expired'] as const;

interface RecipientDraft {
  name: string;
  email: string;
  recipientType: 'signer' | 'carbon_copy';
  authenticationMethod?: 'embedded' | null;
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

export function ESignatureRequestsPanel(props: {
  readonly canPrepare: boolean;
  readonly canSend: boolean;
  readonly canVoid: boolean;
  readonly canDownload: boolean;
  readonly canCorrect: boolean;
  readonly canApprove: boolean;
  readonly initialSource?: { readonly entityType: string; readonly recordId: string; readonly recordLabel?: string } | null | undefined;
  readonly initialRequestId?: string | null | undefined;
}) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const [approvalStatus, setApprovalStatus] = useState<string>('');
  const [q, setQ] = useState('');
  const [recipient, setRecipient] = useState('');
  // The inputs keep their own text so a "clear filters" action can empty them too; the query keys
  // above are what the server saw, and only a submitted search moves them.
  const [qInput, setQInput] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const openedFromLink = useRef(false);

  // A CRM record page hands the user to this screen with the source already chosen; a request link
  // opens the detail directly. It only happens once, so closing the drawer stays closed.
  useEffect(() => {
    if (openedFromLink.current) return;
    openedFromLink.current = true;
    if (props.initialRequestId !== null && props.initialRequestId !== undefined && props.initialRequestId !== '') {
      setDrawer({ mode: 'view', id: props.initialRequestId });
    } else if (props.canPrepare && props.initialSource !== null && props.initialSource !== undefined) {
      setDrawer({ mode: 'create' });
    }
  }, [props.canPrepare, props.initialRequestId, props.initialSource]);

  const requests = useQuery({
    queryKey: ['eSignature', 'requests', status, approvalStatus, q, recipient],
    queryFn: () => api.eSignatureRequests({ status, approvalStatus, q, recipient, limit: 100 }),
    staleTime: 10_000,
  });

  const reload = () => void queryClient.invalidateQueries({ queryKey: ['eSignature', 'requests'] });
  const hasFilters = status !== '' || approvalStatus !== '' || q !== '' || recipient !== '';
  const clearFilters = () => {
    setStatus('');
    setApprovalStatus('');
    setQ('');
    setRecipient('');
    setQInput('');
    setRecipientInput('');
  };
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
      title: t('esignature.requests.columnSigners'),
      key: 'progress',
      width: 130,
      render: (_value: unknown, row) => (
        <Typography.Text type="secondary">
          {row.progress.signers === 0
            ? '—'
            : t('esignature.requests.progress', { done: row.progress.completed, total: row.progress.signers })}
        </Typography.Text>
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
      title={
        <div>
          <div>{t('esignature.requests.title')}</div>
          <div style={{ marginTop: 2, color: 'var(--carocrm-ink-secondary)', fontSize: 12, fontWeight: 400 }}>{t('esignature.requests.hint')}</div>
        </div>
      }
      extra={
        <Space size={8} wrap>
          {requests.data.total === 0 ? null : <Tag>{t('esignature.requests.resultCount', { count: requests.data.total })}</Tag>}
          <Tooltip title={t('core.common.reload')}>
            <Button size="small" icon={<ReloadOutlined />} aria-label={t('core.common.reload')} onClick={() => void requests.refetch()} />
          </Tooltip>
          {props.canPrepare ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ mode: 'create' })}>
              {t('esignature.requests.create')}
            </Button>
          ) : null}
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          size="small"
          style={{ width: 200 }}
          value={qInput}
          aria-label={t('esignature.requests.searchPlaceholder')}
          placeholder={t('esignature.requests.searchPlaceholder')}
          onChange={(event) => setQInput(event.target.value)}
          onSearch={(value) => setQ(value.trim())}
        />
        <Input.Search
          allowClear
          size="small"
          style={{ width: 200 }}
          value={recipientInput}
          aria-label={t('esignature.requests.recipientSearchPlaceholder')}
          placeholder={t('esignature.requests.recipientSearchPlaceholder')}
          onChange={(event) => setRecipientInput(event.target.value)}
          onSearch={(value) => setRecipient(value.trim())}
        />
        <Select
          size="small"
          style={{ minWidth: 170 }}
          aria-label={t('esignature.requests.columnApproval')}
          value={approvalStatus}
          onChange={setApprovalStatus}
          options={[
            { value: '', label: t('esignature.requests.allApprovals') },
            { value: 'pending', label: t('esignature.requests.approvalStatuses.pending') },
            { value: 'approved', label: t('esignature.requests.approvalStatuses.approved') },
            { value: 'rejected', label: t('esignature.requests.approvalStatuses.rejected') },
          ]}
        />
        <Select
          size="small"
          style={{ minWidth: 170 }}
          aria-label={t('esignature.requests.columnStatus')}
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('esignature.requests.allStatuses') },
            ...STATUS_FILTERS.map((value) => ({ value, label: t(`esignature.requests.statuses.${value}`) })),
          ]}
        />
        {hasFilters ? (
          <Button size="small" type="link" onClick={clearFilters}>
            {t('esignature.requests.clearFilters')}
          </Button>
        ) : null}
      </Space>
      {requests.data.list.length === 0 ? (
        <Space direction="vertical" size={14} style={{ width: '100%', alignItems: 'center' }}>
          <EmptyState
            title={hasFilters ? t('esignature.requests.emptyFiltered') : t('esignature.requests.empty')}
            description={t('esignature.requests.emptyHint')}
          />
          {hasFilters ? (
            <Button onClick={clearFilters}>{t('esignature.requests.clearFilters')}</Button>
          ) : props.canPrepare ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawer({ mode: 'create' })}>
              {t('esignature.requests.create')}
            </Button>
          ) : null}
        </Space>
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
            initialSource={props.initialSource ?? null}
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
            canSend={props.canSend}
            canVoid={props.canVoid}
            canDownload={props.canDownload}
            canCorrect={props.canCorrect}
            canApprove={props.canApprove}
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
  canSend: boolean;
  canVoid: boolean;
  canDownload: boolean;
  canCorrect: boolean;
  canApprove: boolean;
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

      <RecipientsTable
        requestId={request.id}
        recipients={[...request.recipients]}
        canEmbedded={request.status === 'sent' || request.status === 'delivered' || request.status === 'partially_signed'}
      />
      <ApprovalSection
        request={request}
        canApprove={props.canApprove}
        onChanged={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
      <PreviewSection
        request={request}
        canPrepare={props.canPrepare}
        canSend={props.canSend}
        onPrepared={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
      <LifecycleActions
        request={request}
        canPrepare={props.canPrepare}
        canSend={props.canSend}
        canVoid={props.canVoid}
        canDownload={props.canDownload}
        canCorrect={props.canCorrect}
        onChanged={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
      <DocumentsList
        requestId={request.id}
        documents={[...request.documents]}
        editable={request.editable && props.canPrepare}
        canDownloadDerived={props.canDownload}
        onChanged={() => {
          props.onDocumentsChanged();
          void detail.refetch();
        }}
      />
      <TimelineSection requestId={request.id} />
    </Space>
  );
}

function RequestEditor(props: {
  mode: 'create' | 'edit';
  request?: ESignatureRequestView;
  canPrepare: boolean;
  /** The record a CRM detail page started from, pre-filled into the source fields. */
  initialSource?: { readonly entityType: string; readonly recordId: string; readonly recordLabel?: string } | null;
  onSaved: (saved: ESignatureRequestView) => void;
  onDocumentsChanged?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<EditorValues>();
  const request = props.request;
  const [pending, setPending] = useState(false);

  const initial: EditorValues =
    request === undefined
      ? {
          name: '',
          ...(props.initialSource === null || props.initialSource === undefined
            ? {}
            : { sourceEntityType: props.initialSource.entityType, sourceRecordId: props.initialSource.recordId }),
          recipients: [{ name: '', email: '', recipientType: 'signer', routingOrder: 1 }],
        }
      : {
          name: request.name,
          ...(request.subject === null ? {} : { subject: request.subject }),
          ...(request.message === null ? {} : { message: request.message }),
          ...(request.source === null ? {} : { sourceEntityType: request.source.entityType, sourceRecordId: request.source.recordId }),
          recipients: request.recipients.map((recipient) => ({
            name: recipient.name,
            email: recipient.email,
            recipientType: recipient.recipientType,
            ...(recipient.authenticationMethod === 'embedded' ? { authenticationMethod: 'embedded' as const } : {}),
            routingOrder: recipient.routingOrder,
          })),
        };

  const save = async (values: EditorValues): Promise<void> => {
    setPending(true);
    try {
      const recipients = values.recipients
        .filter((entry) => entry.name.trim() !== '' && entry.email.trim() !== '')
        .map((entry, index) => ({
          ...entry,
          routingOrder: entry.routingOrder ?? index + 1,
          authenticationMethod: entry.authenticationMethod === 'embedded' ? 'embedded' : null,
        }));
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
      {props.mode === 'create' && props.initialSource !== null && props.initialSource !== undefined ? (
        <>
          {/* Started from a CRM record: the link is fixed, so show the record's name rather than a
              raw id. The hidden fields still submit the id pair the API expects. */}
          <Descriptions
            size="small"
            column={2}
            style={{ marginBottom: 12 }}
            items={[
              { key: 'entity', label: t('esignature.requests.fieldSourceEntity'), children: props.initialSource.entityType },
              {
                key: 'record',
                label: t('esignature.requests.sourceRecordLabel'),
                children: props.initialSource.recordLabel ?? props.initialSource.recordId,
              },
            ]}
          />
          <Form.Item name="sourceEntityType" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="sourceRecordId" hidden>
            <Input />
          </Form.Item>
        </>
      ) : (
        <Space size={8} style={{ display: 'flex' }}>
          <Form.Item name="sourceEntityType" label={t('esignature.requests.fieldSourceEntity')} style={{ flex: 1 }}>
            <AutoComplete options={SOURCE_ENTITIES.map((value) => ({ value }))} placeholder="Quote" />
          </Form.Item>
          <Form.Item name="sourceRecordId" label={t('esignature.requests.fieldSourceRecord')} style={{ flex: 2 }}>
            <Input maxLength={64} placeholder={t('esignature.requests.sourceRecordHint')} />
          </Form.Item>
        </Space>
      )}

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
                <Form.Item name={[field.name, 'authenticationMethod']} style={{ marginBottom: 0 }}>
                  <Select
                    allowClear
                    style={{ width: 170 }}
                    placeholder={t('esignature.requests.signingModes.email')}
                    options={[
                      { value: 'embedded', label: t('esignature.requests.signingModes.embedded') },
                      { value: null, label: t('esignature.requests.signingModes.email') },
                    ]}
                  />
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

/**
 * The send preview (ES.8): exactly what a send would carry, and everything that blocks it.
 *
 * The digest shown here is the identity of those bytes — preparing records it, and any later edit
 * produces a different one, which is why the request drops back to `draft` rather than keeping a
 * preview nobody reviewed.
 */
function PreviewSection(props: { request: ESignatureRequestView; canPrepare: boolean; canSend: boolean; onPrepared: () => void }) {
  const { message } = AntApp.useApp();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const preview = useQuery({
    queryKey: ['eSignature', 'request', props.request.id, 'preview'],
    queryFn: () => api.eSignatureRequestPreview(props.request.id),
  });
  const view = preview.data;
  const canPrepare = props.request.editable && props.canPrepare && view?.ready === true;

  const prepare = async (): Promise<void> => {
    if (view === null || view === undefined) return;
    setPending(true);
    try {
      await api.prepareESignatureRequest(props.request.id, { version: view.requestVersion, confirm: true });
      message.success(t('esignature.preview.prepared'));
      props.onPrepared();
      await preview.refetch();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.preview.failed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card
      size="small"
      title={t('esignature.preview.title')}
      extra={
        view?.digest === null || view?.digest === undefined ? null : (
          <Typography.Text code style={{ fontSize: 11 }}>
            {view.digest.slice(0, 16)}…
          </Typography.Text>
        )
      }
      style={{ marginTop: 8 }}
    >
      {preview.isError ? (
        <Typography.Text type="danger">{t('esignature.preview.failed')}</Typography.Text>
      ) : view === undefined ? (
        <Typography.Text type="secondary">{t('esignature.preview.loading')}</Typography.Text>
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {view.problems.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message={t('esignature.preview.blocked')}
              description={
                <ul className="carocrm-admin-warnings">
                  {view.problems.map((problem) => (
                    <li key={`${problem.code}:${problem.where}`}>{problem.message}</li>
                  ))}
                </ul>
              }
            />
          ) : (
            <Alert type="success" showIcon message={t('esignature.preview.ready')} />
          )}
          {view.staleStoredPreview ? <Alert type="warning" showIcon message={t('esignature.preview.stale')} /> : null}
          {view.approvalRequired && view.approvalReasons.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={t('esignature.preview.approvalPolicy')}
              description={
                <ul className="carocrm-admin-warnings">
                  {view.approvalReasons.map((reason) => (
                    <li key={`${reason.code}:${reason.label}`}>{reason.label}</li>
                  ))}
                </ul>
              }
            />
          ) : null}
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label={t('esignature.preview.documents')}>{view.data?.documents.length ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('esignature.preview.recipients')}>{view.data?.recipients.length ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('esignature.preview.account')}>
              {view.data === null ? '—' : `${view.data.environment} · ${view.data.accountId ?? '—'}`}
            </Descriptions.Item>
            <Descriptions.Item label={t('esignature.preview.approval')}>
              {view.approvalRequired ? <Tag color="orange">{t('esignature.preview.approvalRequired')}</Tag> : <Tag>{t('esignature.preview.approvalNotRequired')}</Tag>}
            </Descriptions.Item>
          </Descriptions>
          {view.data === null ? null : (
            <Table
              size="small"
              rowKey={(row: { email: string; routingOrder: number }) => `${row.email}:${String(row.routingOrder)}`}
              pagination={false}
              dataSource={[...view.data.recipients]}
              columns={[
                { title: t('esignature.requests.routingOrder'), dataIndex: 'routingOrder', width: 80 },
                { title: t('esignature.requests.recipientName'), dataIndex: 'name' },
                { title: t('esignature.requests.recipientEmail'), dataIndex: 'email' },
                { title: t('esignature.requests.recipientType'), dataIndex: 'recipientType', render: (value: string) => t(`esignature.requests.recipientTypes.${value}`) },
                { title: t('esignature.preview.role'), dataIndex: 'roleName', render: (value: string | null) => value ?? '—' },
              ]}
            />
          )}
          {canPrepare ? (
            <Space size={10} wrap>
              <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
                {t('esignature.preview.confirm')}
              </Checkbox>
              <Button type="primary" size="small" disabled={!confirmed} loading={pending} onClick={() => void prepare()}>
                {t('esignature.preview.prepare')}
              </Button>
            </Space>
          ) : null}
          {props.request.providerDrafting === 'direct' ? null : (
            <EnvelopeSection request={props.request} canPrepare={props.canPrepare} onChanged={props.onPrepared} />
          )}
          <SendSection request={props.request} canSend={props.canSend} onChanged={props.onPrepared} />
        </Space>
      )}
    </Card>
  );
}

/**
 * The provider draft (ES.9): created from the prepared snapshot, and abandoned while nothing is sent.
 *
 * A draft envelope invites nobody — the signers are not emailed until ES.10 sends — so abandoning it is
 * a safe recovery from a preparation made against the wrong request.
 */
function EnvelopeSection(props: { request: ESignatureRequestView; canPrepare: boolean; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [pending, setPending] = useState(false);
  // A direct provider has no unsent draft to create or abandon: its send is the create call.
  const ready = props.request.status === 'ready_to_send' && props.request.providerDrafting !== 'direct';
  if (!ready) return null;

  const create = async (): Promise<void> => {
    setPending(true);
    try {
      const result = await api.createESignatureEnvelope(props.request.id, { version: props.request.version });
      message.success(result.envelope.created ? t('esignature.preview.envelopeCreated') : t('esignature.preview.envelopeExisting'));
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.preview.envelopeFailed'));
    } finally {
      setPending(false);
    }
  };

  const abandon = async (): Promise<void> => {
    setPending(true);
    try {
      await api.abandonESignatureEnvelope(props.request.id);
      message.success(t('esignature.preview.envelopeAbandoned'));
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.preview.envelopeFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Space size={8} wrap>
      {props.request.providerEnvelopeId === null ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('esignature.preview.envelopeHint')}
          </Typography.Text>
          {props.canPrepare ? (
            <Button size="small" loading={pending} onClick={() => void create()}>
              {t('esignature.preview.envelopeCreate')}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <Tag color="blue">{t('esignature.preview.envelopeId', { id: props.request.providerEnvelopeId })}</Tag>
          <Tag>{props.request.providerStatusRaw ?? 'draft'}</Tag>
          {props.canPrepare ? (
            <Popconfirm
              title={t('esignature.preview.envelopeAbandonConfirm')}
              okText={t('core.common.confirm')}
              cancelText={t('core.common.cancel')}
              onConfirm={() => void abandon()}
            >
              <Button size="small" danger loading={pending}>
                {t('esignature.preview.envelopeAbandon')}
              </Button>
            </Popconfirm>
          ) : null}
        </>
      )}
    </Space>
  );
}

/**
 * Sending, and the two recoveries (ES.10).
 *
 * A send is the one irreversible act, so it carries its own confirmation. `send_unknown` offers
 * **reconciliation only** — never a second send — and `provider_error` offers the recovery that makes a
 * deliberate retry possible again.
 */
function SendSection(props: { request: ESignatureRequestView; canSend: boolean; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const { status } = props.request;

  const act = async (work: () => Promise<unknown>, success: string, fail: string): Promise<void> => {
    setPending(true);
    try {
      await work();
      message.success(success);
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : fail);
    } finally {
      setPending(false);
    }
  };

  if (status === 'send_unknown') {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('esignature.send.unknown')}
        action={
          <Button size="small" loading={pending} onClick={() => void act(() => api.reconcileESignatureRequest(props.request.id), t('esignature.send.reconciled'), t('esignature.send.reconcileFailed'))}>
            {t('esignature.send.reconcile')}
          </Button>
        }
      />
    );
  }
  if (status === 'provider_error') {
    return (
      <Alert
        type="error"
        showIcon
        message={t('esignature.send.failed', { code: props.request.providerStatusRaw ?? 'send' })}
        action={
          <Button size="small" loading={pending} onClick={() => void act(() => api.recoverESignatureSend(props.request.id), t('esignature.send.recovered'), t('esignature.send.recoverFailed'))}>
            {t('esignature.send.recover')}
          </Button>
        }
      />
    );
  }
  const sendable =
    status === 'ready_to_send' &&
    (props.request.providerEnvelopeId !== null || props.request.providerDrafting === 'direct');
  if (!sendable) return null;
  return (
    <Space size={10} wrap>
      <Checkbox checked={confirmed} disabled={!props.canSend} onChange={(event) => setConfirmed(event.target.checked)}>
        {t('esignature.send.confirm')}
      </Checkbox>
      {props.canSend ? (
        <Button
          danger
          type="primary"
          size="small"
          disabled={!confirmed}
          loading={pending}
          onClick={() =>
            void act(
              () => api.sendESignatureRequest(props.request.id, { version: props.request.version, confirm: true }),
              t('esignature.send.sent'),
              t('esignature.send.sendFailed'),
            )
          }
        >
          {t('esignature.send.sendNow')}
        </Button>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('esignature.send.noRight')}
        </Typography.Text>
      )}
    </Space>
  );
}

function RecipientsTable(props: {
  requestId: string;
  recipients: ESignatureRequestRecipient[];
  canEmbedded: boolean;
}) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState<string | null>(null);

  /** A one-time URL: opened in a new tab, never stored, never rendered as text. */
  const openEmbedded = async (recipient: ESignatureRequestRecipient): Promise<void> => {
    setBusy(recipient.id);
    try {
      const view = await api.createESignatureEmbeddedView(props.requestId, {
        recipientId: recipient.id,
        returnUrl: `${window.location.origin}/esignature`,
      });
      window.open(view.url, '_blank', 'noopener,noreferrer');
      message.success(t('esignature.requests.embeddedOpened'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.requests.embeddedFailed'));
    } finally {
      setBusy(null);
    }
  };

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
            { title: t('esignature.requests.routingOrder'), dataIndex: 'routingOrder', width: 70 },
            { title: t('esignature.requests.recipientName'), dataIndex: 'name' },
            { title: t('esignature.requests.recipientEmail'), dataIndex: 'email' },
            {
              title: t('esignature.requests.recipientType'),
              dataIndex: 'recipientType',
              width: 110,
              render: (value: string) => t(`esignature.requests.recipientTypes.${value}`),
            },
            {
              title: t('esignature.requests.recipientStatus'),
              dataIndex: 'status',
              width: 130,
              render: (value: string) => <Tag color={recipientStatusColor(value)}>{t(`esignature.requests.recipientStatuses.${value}`)}</Tag>,
            },
            {
              title: t('esignature.requests.signingMode'),
              dataIndex: 'authenticationMethod',
              width: 130,
              render: (value: string | null) =>
                value === 'embedded' ? <Tag color="blue">{t('esignature.requests.signingModes.embedded')}</Tag> : <Tag>{t('esignature.requests.signingModes.email')}</Tag>,
            },
            {
              title: '',
              key: 'actions',
              width: 130,
              render: (_value: unknown, row) =>
                props.canEmbedded && row.authenticationMethod === 'embedded' && row.recipientType === 'signer' &&
                row.status !== 'completed' && row.status !== 'declined' && row.status !== 'canceled' ? (
                  <Button size="small" type="link" icon={<LinkOutlined />} loading={busy === row.id} onClick={() => void openEmbedded(row)}>
                    {t('esignature.requests.signNow')}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
    </Space>
  );
}

/**
 * The approval decision (ES.17).
 *
 * A request covered by policy stops in `pending_approval`; this card is the approver's whole screen.
 * The digest and reviewed version are shown because they are the thing being decided — an approval
 * for different bytes is not an approval at all. Separation-of-duties refusals come from the server
 * with their own stable code, so the buttons never pretend the decision is available to everyone.
 */
function ApprovalSection(props: { request: ESignatureRequestView; canApprove: boolean; onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const request = props.request;
  const visible = request.approvalRequired || request.approvalStatus !== 'not_required' || request.status === 'pending_approval';
  if (!visible) return null;
  const canDecide =
    props.canApprove &&
    request.status === 'pending_approval' &&
    (request.approvalStatus === 'pending' || request.approvalStatus === 'rejected');

  const decide = async (): Promise<void> => {
    if (decision === null) return;
    const text = reason.trim();
    if (decision === 'rejected' && text.length < 3) {
      message.error(t('esignature.approval.reasonRequired'));
      return;
    }
    setPending(true);
    try {
      if (decision === 'approved') {
        await api.approveESignatureRequest(request.id, { version: request.version, ...(text === '' ? {} : { reason: text }) });
        message.success(t('esignature.approval.approved'));
      } else {
        await api.rejectESignatureRequest(request.id, { version: request.version, reason: text });
        message.success(t('esignature.approval.rejected'));
      }
      setDecision(null);
      setReason('');
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('esignature.approval.failed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card size="small" title={t('esignature.approval.title')} style={{ marginTop: 8 }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Tag color={approvalColor(request.approvalStatus)}>{t(`esignature.requests.approvalStatuses.${request.approvalStatus}`)}</Tag>
          {request.approvalReviewedVersion === null ? null : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('esignature.approval.reviewedVersion', { version: request.approvalReviewedVersion })}
            </Typography.Text>
          )}
          {request.approvalReviewedDigest === null ? null : (
            <Typography.Text code style={{ fontSize: 11 }}>
              {request.approvalReviewedDigest.slice(0, 16)}…
            </Typography.Text>
          )}
        </Space>

        {request.status === 'pending_approval' && request.approvalStatus === 'pending' ? (
          <Alert
            type="warning"
            showIcon
            message={t('esignature.approval.waiting')}
            description={
              canDecide ? t('esignature.approval.waitingAction') : t('esignature.approval.waitingNoRight')
            }
            action={
              canDecide ? (
                <Space size={6} wrap>
                  <Button size="small" type="primary" loading={pending} onClick={() => setDecision('approved')}>
                    {t('esignature.approval.approve')}
                  </Button>
                  <Button size="small" danger loading={pending} onClick={() => setDecision('rejected')}>
                    {t('esignature.approval.reject')}
                  </Button>
                </Space>
              ) : null
            }
          />
        ) : null}

        {request.approvalStatus === 'rejected' ? (
          <Alert
            type="error"
            showIcon
            message={t('esignature.approval.rejectedNotice')}
            description={request.approvalReason ?? undefined}
            action={
              canDecide ? (
                <Button size="small" loading={pending} onClick={() => setDecision('approved')}>
                  {t('esignature.approval.approveAfterReject')}
                </Button>
              ) : null
            }
          />
        ) : null}

        {request.approvalStatus === 'approved' ? (
          <Alert
            type="success"
            showIcon
            message={t('esignature.approval.approvedNotice', { version: request.approvalReviewedVersion ?? '—' })}
            description={request.approvalReason ?? undefined}
          />
        ) : null}

        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label={t('esignature.approval.requestedAt')}>
            {request.approvalRequestedAt === null ? '—' : formatMoment(request.approvalRequestedAt)}
          </Descriptions.Item>
          <Descriptions.Item label={t('esignature.approval.requestedBy')}>{request.approvalRequestedById ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('esignature.approval.decidedAt')}>
            {request.approvalDecidedAt === null ? '—' : formatMoment(request.approvalDecidedAt)}
          </Descriptions.Item>
          <Descriptions.Item label={t('esignature.approval.decidedBy')}>{request.approvalDecidedById ?? '—'}</Descriptions.Item>
        </Descriptions>
      </Space>

      <Modal
        open={decision !== null}
        title={decision === 'rejected' ? t('esignature.approval.rejectTitle') : t('esignature.approval.approveTitle')}
        okText={decision === 'rejected' ? t('esignature.approval.rejectConfirm') : t('esignature.approval.approveConfirm')}
        okButtonProps={{ danger: decision === 'rejected', loading: pending }}
        cancelText={t('core.common.cancel')}
        onOk={() => void decide()}
        onCancel={() => {
          setDecision(null);
          setReason('');
        }}
      >
        <Typography.Paragraph type="secondary">
          {t('esignature.approval.versionHint', { version: request.approvalReviewedVersion ?? request.version })}
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={decision === 'rejected' ? t('esignature.approval.rejectReason') : t('esignature.approval.approveReason')}
        />
      </Modal>
    </Card>
  );
}

function approvalColor(status: string): string {
  if (status === 'approved') return 'green';
  if (status === 'rejected') return 'red';
  if (status === 'pending') return 'orange';
  return 'default';
}

/**
 * Post-send actions (ES.12, ES.15, ES.16).
 *
 * Every button is gated twice: the capability the caller holds (the server enforces it again) and the
 * state that makes the action meaningful. A terminal request offers downloads and reconciliation, not
 * reminders or a void.
 */
function LifecycleActions(props: {
  request: ESignatureRequestView;
  canPrepare: boolean;
  canSend: boolean;
  canVoid: boolean;
  canDownload: boolean;
  canCorrect: boolean;
  onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const [pending, setPending] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const { status } = props.request;
  const open = status === 'sent' || status === 'delivered' || status === 'partially_signed';
  const reconcilable = open || status === 'sending' || status === 'send_unknown' || status === 'reconciliation_required' || status === 'completed';
  const canRequestApproval = props.canPrepare && status === 'ready_to_send' && props.request.approvalStatus === 'not_required';

  const act = async (work: () => Promise<unknown>, success: string, fail: string): Promise<void> => {
    setPending(true);
    try {
      await work();
      message.success(success);
      props.onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : fail);
    } finally {
      setPending(false);
    }
  };

  const voidIt = async (): Promise<void> => {
    const reason = voidReason.trim();
    if (reason.length < 3) {
      message.error(t('esignature.actions.voidReasonRequired'));
      return;
    }
    await act(
      () => api.voidESignatureRequest(props.request.id, { version: props.request.version, confirm: true, reason }),
      t('esignature.actions.voided'),
      t('esignature.actions.voidFailed'),
    );
    setVoidOpen(false);
    setVoidReason('');
  };

  if (!open && status !== 'completed' && !reconcilable && !canRequestApproval) return null;
  return (
    <Card size="small" title={t('esignature.actions.title')} style={{ marginTop: 8 }}>
      <Space size={8} wrap>
        {reconcilable ? (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={pending}
            onClick={() =>
              void act(
                () => api.reconcileESignatureRequest(props.request.id),
                t('esignature.actions.synced'),
                t('esignature.actions.syncFailed'),
              )
            }
          >
            {t('esignature.actions.syncStatus')}
          </Button>
        ) : null}
        {canRequestApproval ? (
          <Button
            size="small"
            loading={pending}
            onClick={() =>
              void act(
                () => api.requestESignatureApproval(props.request.id, { version: props.request.version }),
                t('esignature.actions.approvalRequested'),
                t('esignature.actions.approvalRequestFailed'),
              )
            }
          >
            {t('esignature.actions.requestApproval')}
          </Button>
        ) : null}
        {open && props.canSend ? (
          <Button
            size="small"
            loading={pending}
            onClick={() =>
              void act(
                () => api.resendESignatureNotification(props.request.id),
                t('esignature.actions.reminderSent'),
                t('esignature.actions.reminderFailed'),
              )
            }
          >
            {t('esignature.actions.remind')}
          </Button>
        ) : null}
        {open && props.canVoid ? (
          <Button danger size="small" icon={<StopOutlined />} onClick={() => setVoidOpen(true)}>
            {t('esignature.actions.void')}
          </Button>
        ) : null}
        {status === 'completed' && props.canDownload ? (
          <Button
            size="small"
            icon={<DownloadOutlined />}
            loading={pending}
            onClick={() =>
              void act(
                () => api.retrieveESignatureArtifacts(props.request.id),
                t('esignature.actions.artifactsRetrieved'),
                t('esignature.actions.artifactsFailed'),
              )
            }
          >
            {t('esignature.actions.retrieveArtifacts')}
          </Button>
        ) : null}
        {open && props.canCorrect ? (
          <Button
            size="small"
            disabled
            title={t('esignature.actions.correctUnavailable')}
          >
            {t('esignature.actions.correct')}
          </Button>
        ) : null}
      </Space>
      <Modal
        open={voidOpen}
        title={t('esignature.actions.voidTitle')}
        okText={t('esignature.actions.voidConfirm')}
        okButtonProps={{ danger: true, loading: pending }}
        cancelText={t('core.common.cancel')}
        onOk={() => void voidIt()}
        onCancel={() => setVoidOpen(false)}
      >
        <Typography.Paragraph type="secondary">{t('esignature.actions.voidHint')}</Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={500}
          value={voidReason}
          onChange={(event) => setVoidReason(event.target.value)}
          placeholder={t('esignature.actions.voidReason')}
        />
      </Modal>
    </Card>
  );
}

function TimelineSection(props: { requestId: string }) {
  const timeline = useQuery({
    queryKey: ['eSignature', 'request', props.requestId, 'events'],
    queryFn: () => api.eSignatureRequestEvents(props.requestId),
  });
  if (timeline.isError) return <Alert type="warning" showIcon message={t('esignature.timeline.loadFailed')} />;
  const entries = timeline.data?.list ?? [];
  return (
    <Card size="small" title={t('esignature.timeline.title')} style={{ marginTop: 8 }}>
      {timeline.isLoading ? (
        <Typography.Text type="secondary">{t('esignature.timeline.loading')}</Typography.Text>
      ) : entries.length === 0 ? (
        <Typography.Text type="secondary">{t('esignature.timeline.empty')}</Typography.Text>
      ) : (
        <Timeline
          items={entries.map((entry: ESignatureTimelineEntry) => ({
            color: entry.outcome === 'refused' || entry.outcome === 'failed' ? 'red' : entry.kind === 'provider' ? 'blue' : 'gray',
            children: (
              <Space direction="vertical" size={0}>
                <Space size={6} wrap>
                  <Tag color={entry.kind === 'provider' ? 'blue' : 'default'}>
                    {entry.kind === 'provider' ? t('esignature.timeline.providerEvent') : t('esignature.timeline.auditEntry')}
                  </Tag>
                  <Typography.Text strong>
                    {entry.kind === 'provider' ? t(`esignature.timeline.providerTypes.${entry.type}`) : t(`esignature.timeline.auditActions.${entry.type}`)}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatMoment(entry.at)}
                  </Typography.Text>
                </Space>
                {entry.reasonSafe === null ? null : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {entry.reasonSafe}
                  </Typography.Text>
                )}
              </Space>
            ),
          }))}
        />
      )}
    </Card>
  );
}

function DocumentsList(props: {
  requestId: string;
  documents: ESignatureRequestDocument[];
  editable: boolean;
  canDownloadDerived?: boolean;
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
              render: (_unknown: unknown, row) => {
                const derived = row.artifactKind === 'provider_signed_document' || row.artifactKind === 'completion_evidence';
                // The server refuses a derived download without `downloadCompleted`; the button says so
                // before the click instead of turning into a 403.
                if (derived && props.canDownloadDerived === false) return null;
                return (
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
                );
              },
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

function recipientStatusColor(status: string): string {
  if (status === 'completed' || status === 'signed') return 'green';
  if (status === 'declined' || status === 'expired') return 'red';
  if (status === 'canceled') return 'volcano';
  if (status === 'viewed') return 'purple';
  if (status === 'delivered' || status === 'sent') return 'blue';
  return 'default';
}

function formatMoment(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
