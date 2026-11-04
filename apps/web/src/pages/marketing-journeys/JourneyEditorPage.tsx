import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntApp, Button, Card, Descriptions, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '../../api/client.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState } from '../../components/ErrorState.js';
import { LoadingSkeleton } from '../../components/LoadingSkeleton.js';
import { PermissionDenied } from '../../components/PermissionDenied.js';
import { formatDateTime, t } from '../../state/i18n.js';
import {
  emptyGraph,
  insertAfter,
  JOURNEY_ACTIONS,
  JOURNEY_NODE_TYPES,
  type JourneyGraph,
  type JourneyNodeType,
  moveNode,
  parseDraft,
  patchNode,
  type PortName,
  portOptions,
  portsFor,
  removeNode,
  serializeDraft,
  setPort,
} from './journeyGraph.js';

/**
 * Phase 19-MA.12 — the journey editor.
 *
 * The plan asked for "a simple editor/list-view UI using an existing graph library if available"
 * (`plans/PLAN_Phase_19_Marketing_Automation.md` §MA.12 task 5). No graph library is installed and adding one
 * to render a list of steps would be the larger risk, so this is the same shape the platform's own process
 * editor uses: an ordered table of nodes, each carrying its outgoing ports, over the server's
 * `{ start, nodes[] }` document.
 *
 * What the screen owns is presentation and editing only. Whether a graph may be published is answered by
 * `POST action/journey/:id/validate` and enforced again by `…/publish`, which refuses an invalid graph before
 * it writes an immutable version; the findings are rendered as the sentences the server wrote, not re-derived
 * here. A published version is never editable — the editor always works on the draft, and the draft is stored
 * in the journey's own free-form `settings` field, so nothing here can rewrite history.
 */

const ENROLLMENT_STATE_COLORS: Record<string, string> = {
  Active: 'green',
  Waiting: 'blue',
  Suspended: 'gold',
  Exited: 'default',
  Completed: 'success',
};

interface Findings {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface VersionRow {
  id: string;
  version: number | null;
  status: string | null;
  graphHash: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
}

interface EnrollmentRow {
  id: string;
  state: string | null;
  version: number | null;
  personType: string | null;
  personId: string | null;
  currentNodeId: string | null;
  nextRunAt: string | null;
  branchTrace: string | null;
}

export function JourneyEditorPage() {
  const { id = '' } = useParams();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [graph, setGraph] = useState<JourneyGraph>(emptyGraph());
  const [dirty, setDirty] = useState(false);
  const [findings, setFindings] = useState<Findings | null>(null);
  const [releaseNotes, setReleaseNotes] = useState('');
  const [personType, setPersonType] = useState('Contact');
  const [personId, setPersonId] = useState('');
  const [addPick, setAddPick] = useState<string | null>(null);

  const journey = useQuery({
    queryKey: ['marketingJourney', id],
    queryFn: () => api.get('MarketingJourney', id),
    enabled: id !== '',
    retry: false,
  });

  useEffect(() => {
    if (journey.data === undefined) return;
    const parsed = parseDraft(journey.data['settings']);
    if (parsed.graph !== null) {
      setGraph(parsed.graph);
      setDirty(false);
    }
    if (parsed.unreadable) {
      // The field is free text and a person may have typed in it. The draft is not silently overwritten.
      void message.warning(t('web.journeys.draftUnreadable'));
    }
  }, [journey.data, message]);

  const versions = useQuery({
    queryKey: ['marketingJourneyVersions', id],
    queryFn: async () =>
      ((await api.list('MarketingJourneyVersion', {
        where: [{ field: 'journeyId', operator: 'equals', value: id }],
        maxSize: 50,
        orderBy: 'version,desc',
      })).list as unknown) as VersionRow[],
    enabled: id !== '',
    staleTime: 15_000,
    retry: false,
  });

  const enrollments = useQuery({
    queryKey: ['marketingJourneyEnrollments', id],
    queryFn: async () =>
      ((await api.list('MarketingJourneyEnrollment', {
        where: [{ field: 'journeyId', operator: 'equals', value: id }],
        maxSize: 50,
        orderBy: 'enteredAt,desc',
      })).list as unknown) as EnrollmentRow[],
    enabled: id !== '',
    staleTime: 15_000,
    retry: false,
  });

  const edit = useCallback((next: (current: JourneyGraph) => JourneyGraph): void => {
    setGraph((current) => next(current));
    setDirty(true);
    setFindings(null);
  }, []);

  const saveDraft = useMutation({
    mutationFn: () => api.update('MarketingJourney', id, { settings: serializeDraft(graph) }),
    onSuccess: () => {
      setDirty(false);
      void message.success(t('web.journeys.draftSaved'));
      void queryClient.invalidateQueries({ queryKey: ['marketingJourney', id] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const validate = useMutation({
    mutationFn: () => api.marketingJourneyValidate(id, graph as unknown as Record<string, unknown>),
    onSuccess: (result) => {
      setFindings({
        valid: result['valid'] === true,
        errors: (result['errors'] as string[]) ?? [],
        warnings: (result['warnings'] as string[]) ?? [],
      });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const publish = useMutation({
    mutationFn: () => api.marketingJourneyPublish(id, graph as unknown as Record<string, unknown>, releaseNotes.trim()),
    onSuccess: (result) => {
      void message.success(t('web.journeys.published', { version: String(result['version'] ?? '') }));
      setReleaseNotes('');
      void queryClient.invalidateQueries({ queryKey: ['marketingJourney', id] });
      void queryClient.invalidateQueries({ queryKey: ['marketingJourneyVersions', id] });
      void queryClient.invalidateQueries({ queryKey: ['marketingJourneyEnrollments', id] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const enroll = useMutation({
    // Enrollment takes the graph with it: the server resolves which version that graph is and pins the
    // enrollment to it, so a draft edited afterwards cannot silently move a record into new steps.
    mutationFn: () =>
      api.marketingJourneyEnroll(id, {
        graph: graph as unknown as Record<string, unknown>,
        personType,
        personId,
        source: 'Manual',
      }),
    onSuccess: (result) => {
      setPersonId('');
      void message.success(result['duplicate'] === true ? t('web.journeys.alreadyEnrolled') : t('web.journeys.enrolled'));
      void queryClient.invalidateQueries({ queryKey: ['marketingJourneyEnrollments', id] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  const enrollmentCommand = useMutation({
    mutationFn: async (input: { action: 'suspend' | 'resume' | 'exit'; enrollmentId: string }) => {
      if (input.action === 'suspend') return api.marketingEnrollmentSuspend(input.enrollmentId);
      if (input.action === 'resume') return api.marketingEnrollmentResume(input.enrollmentId);
      return api.marketingEnrollmentExit(input.enrollmentId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['marketingJourneyEnrollments', id] });
    },
    onError: (error: Error) => void message.error(error.message),
  });

  if (journey.isLoading) return <LoadingSkeleton rows={10} />;
  if (journey.isError) {
    if (journey.error instanceof ApiError && journey.error.status === 403) {
      return <PermissionDenied hint={t('web.journeys.denied')} />;
    }
    return <ErrorState message={t('web.journeys.loadFailed')} onRetry={() => void journey.refetch()} />;
  }

  const record = journey.data ?? {};
  const options = portOptions(graph);

  return (
    <div>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card
          size="small"
          title={
            <Space>
              <Link to="/marketing/journeys">{t('web.journeys.back')}</Link>
              <span>·</span>
              <span>{String(record['name'] ?? id)}</span>
              <Tag>{String(record['status'] ?? 'Draft')}</Tag>
            </Space>
          }
          extra={
            <Space>
              <Button size="small" onClick={() => validate.mutate()} loading={validate.isPending}>
                {t('web.journeys.validate')}
              </Button>
              <Button size="small" onClick={() => saveDraft.mutate()} loading={saveDraft.isPending} disabled={!dirty}>
                {t('web.journeys.saveDraft')}
              </Button>
              <Button size="small" type="primary" onClick={() => publish.mutate()} loading={publish.isPending}>
                {t('web.journeys.publish')}
              </Button>
            </Space>
          }
        >
          <Descriptions size="small" column={2}>
            <Descriptions.Item label={t('web.journeys.currentVersion')}>
              {Number(record['currentVersion'] ?? 0) === 0 ? t('web.journeys.neverPublished') : String(record['currentVersion'])}
            </Descriptions.Item>
            <Descriptions.Item label={t('web.journeys.triggerFamily')}>{String(record['triggerFamily'] ?? '—')}</Descriptions.Item>
            <Descriptions.Item label={t('web.journeys.draft')}>{dirty ? t('web.journeys.unsaved') : t('web.journeys.saved')}</Descriptions.Item>
            <Descriptions.Item label={t('web.journeys.releaseNotes')}>
              <Input
                size="small"
                value={releaseNotes}
                onChange={(event) => setReleaseNotes(event.target.value)}
                placeholder={t('web.journeys.releaseNotesPlaceholder')}
              />
            </Descriptions.Item>
          </Descriptions>
        </Card>

        {findings !== null ? (
          <Card size="small" title={t('web.journeys.findings')}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Alert
                type={findings.valid ? 'success' : 'error'}
                showIcon
                message={findings.valid ? t('web.journeys.validGraph') : t('web.journeys.invalidGraph')}
              />
              {findings.errors.map((line) => (
                <Typography.Text key={`e-${line}`} type="danger">
                  {line}
                </Typography.Text>
              ))}
              {findings.warnings.map((line) => (
                <Typography.Text key={`w-${line}`} type="warning">
                  {line}
                </Typography.Text>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.journeys.findingsNote')}
              </Typography.Text>
            </Space>
          </Card>
        ) : null}

        <Card
          size="small"
          title={t('web.journeys.steps')}
          extra={
            <Select
              size="small"
              style={{ width: 220 }}
              placeholder={t('web.journeys.addAfter')}
              value={addPick}
              onChange={(value: string) => {
                const [anchorId, type] = value.split('|');
                setAddPick(null);
                if (anchorId !== undefined && type !== undefined) edit((current) => insertAfter(current, anchorId, type as JourneyNodeType));
              }}
              options={graph.nodes.flatMap((node) =>
                JOURNEY_NODE_TYPES.filter((type) => type !== 'start').map((type) => ({
                  value: `${node.id}|${type}`,
                  label: `${t(`web.journeys.types.${type}`)} ${t('web.journeys.after')} ${node.name ?? node.id}`,
                })),
              )}
            />
          }
        >
          <Table
            size="small"
            rowKey={(row) => row.id}
            dataSource={[...graph.nodes]}
            pagination={false}
            columns={[
              {
                title: t('web.journeys.start'),
                dataIndex: 'id',
                width: 60,
                render: (value: string) => (
                  <Button
                    size="small"
                    type={graph.start === value ? 'primary' : 'text'}
                    onClick={() => edit((current) => ({ ...current, start: value }))}
                    aria-label={t('web.journeys.setStart')}
                  >
                    •
                  </Button>
                ),
              },
              {
                title: t('web.journeys.nodeId'),
                dataIndex: 'id',
                width: 110,
                render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
              },
              {
                title: t('web.journeys.type'),
                dataIndex: 'type',
                width: 130,
                render: (value: JourneyNodeType, row) => (
                  <Select
                    size="small"
                    style={{ width: 118 }}
                    value={value}
                    disabled={graph.nodes.length === 1 && row.id === graph.start}
                    onChange={(next: JourneyNodeType) => edit((current) => patchNode(current, row.id, { type: next }))}
                    options={JOURNEY_NODE_TYPES.map((type) => ({ value: type, label: t(`web.journeys.types.${type}`) }))}
                  />
                ),
              },
              {
                title: t('web.common.name'),
                dataIndex: 'name',
                render: (value: string | undefined, row) => (
                  <Input
                    size="small"
                    value={value ?? ''}
                    onChange={(event) => edit((current) => patchNode(current, row.id, { name: event.target.value }))}
                  />
                ),
              },
              {
                title: t('web.journeys.action'),
                dataIndex: 'action',
                width: 150,
                render: (value: string | undefined, row) =>
                  row.type === 'action' ? (
                    <Select
                      size="small"
                      style={{ width: 140 }}
                      value={value ?? 'createTask'}
                      onChange={(next: string) => edit((current) => patchNode(current, row.id, { action: next, params: current.nodes.find((n) => n.id === row.id)?.params ?? {} }))}
                      options={JOURNEY_ACTIONS.map((action) => ({ value: action, label: t(`web.journeys.actions.${action}`) }))}
                    />
                  ) : (
                    '—'
                  ),
              },
              {
                title: t('web.journeys.seconds'),
                dataIndex: 'seconds',
                width: 110,
                render: (value: number | undefined, row) =>
                  row.type === 'wait' ? (
                    <InputNumber
                      size="small"
                      min={0}
                      value={value ?? 0}
                      onChange={(next: number | null) => edit((current) => patchNode(current, row.id, { seconds: next ?? 0 }))}
                    />
                  ) : (
                    '—'
                  ),
              },
              {
                title: t('web.journeys.portsColumn'),
                dataIndex: 'id',
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {portsFor(row.type).map((port: PortName) => (
                      <Space key={port} size={4}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t(`web.journeys.ports.${port}`)}
                        </Typography.Text>
                        <Select
                          size="small"
                          style={{ width: 150 }}
                          allowClear
                          value={row[port]}
                          placeholder={t('web.journeys.noTarget')}
                          onChange={(next: string | undefined) => edit((current) => setPort(current, row.id, port, next ?? ''))}
                          options={options.filter((option) => option.value !== row.id)}
                        />
                      </Space>
                    ))}
                  </Space>
                ),
              },
              {
                title: '',
                dataIndex: 'controls',
                width: 110,
                render: (_: unknown, row) => (
                  <Space size={2}>
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowUpOutlined />}
                      aria-label={t('web.journeys.moveUp')}
                      onClick={() => edit((current) => moveNode(current, row.id, -1))}
                    />
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowDownOutlined />}
                      aria-label={t('web.journeys.moveDown')}
                      onClick={() => edit((current) => moveNode(current, row.id, 1))}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={t('web.journeys.remove')}
                      onClick={() => edit((current) => removeNode(current, row.id))}
                    />
                  </Space>
                ),
              },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.journeys.stepsNote')}
          </Typography.Text>
        </Card>

        <Card size="small" title={t('web.journeys.versions')}>
          {versions.isLoading ? <LoadingSkeleton rows={3} /> : null}
          {(versions.data ?? []).length === 0 && !versions.isLoading ? <EmptyState description={t('web.journeys.noVersions')} /> : null}
          {(versions.data ?? []).length > 0 ? (
            <Table<VersionRow>
              size="small"
              rowKey={(row) => row.id}
              dataSource={versions.data ?? []}
              pagination={false}
              columns={[
                { title: t('web.journeys.version'), dataIndex: 'version', width: 80 },
                { title: t('web.journeys.status'), dataIndex: 'status', width: 110, render: (value: string | null) => <Tag>{value ?? '—'}</Tag> },
                {
                  title: t('web.journeys.graphHash'),
                  dataIndex: 'graphHash',
                  width: 130,
                  render: (value: string | null) => <Typography.Text code>{(value ?? '').slice(0, 12)}</Typography.Text>,
                },
                {
                  title: t('web.journeys.publishedAt'),
                  dataIndex: 'publishedAt',
                  width: 170,
                  render: (value: string | null) => (typeof value === 'string' ? formatDateTime(value) : '—'),
                },
                { title: t('web.journeys.releaseNotes'), dataIndex: 'releaseNotes', render: (value: string | null) => value ?? '—' },
              ]}
            />
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.journeys.versionsNote')}
          </Typography.Text>
        </Card>

        <Card size="small" title={t('web.journeys.enrollments')}>
          {enrollments.isLoading ? <LoadingSkeleton rows={3} /> : null}
          {(enrollments.data ?? []).length === 0 && !enrollments.isLoading ? <EmptyState description={t('web.journeys.noEnrollments')} /> : null}
          {(enrollments.data ?? []).length > 0 ? (
            <Table<EnrollmentRow>
              size="small"
              rowKey={(row) => row.id}
              dataSource={enrollments.data ?? []}
              pagination={false}
              columns={[
                {
                  title: t('web.journeys.person'),
                  dataIndex: 'personId',
                  render: (value: string | null, row) => (
                    <Space size={4}>
                      <Typography.Text type="secondary">{row.personType ?? '—'}</Typography.Text>
                      <Link to={`/${encodeURIComponent(String(row.personType ?? 'Contact'))}/${encodeURIComponent(String(value ?? ''))}`}>{value ?? '—'}</Link>
                    </Space>
                  ),
                },
                { title: t('web.journeys.state'), dataIndex: 'state', width: 120, render: (value: string | null) => <Tag color={ENROLLMENT_STATE_COLORS[value ?? ''] ?? 'default'}>{value ?? '—'}</Tag> },
                { title: t('web.journeys.version'), dataIndex: 'version', width: 70 },
                { title: t('web.journeys.currentNode'), dataIndex: 'currentNodeId', width: 120, render: (value: string | null) => value ?? '—' },
                {
                  title: t('web.journeys.nextRun'),
                  dataIndex: 'nextRunAt',
                  width: 170,
                  render: (value: string | null) => (typeof value === 'string' ? formatDateTime(value) : '—'),
                },
                {
                  title: t('web.journeys.branchTrace'),
                  dataIndex: 'branchTrace',
                  render: (value: string | null) => (
                    <Typography.Text style={{ fontSize: 12 }} ellipsis>
                      {value ?? '—'}
                    </Typography.Text>
                  ),
                },
                {
                  title: '',
                  dataIndex: 'enrollmentControls',
                  width: 210,
                  render: (_: unknown, row) => (
                    <Space size={4}>
                      {row.state === 'Active' || row.state === 'Waiting' ? (
                        <Button size="small" loading={enrollmentCommand.isPending} onClick={() => enrollmentCommand.mutate({ action: 'suspend', enrollmentId: row.id })}>
                          {t('web.journeys.suspend')}
                        </Button>
                      ) : null}
                      {row.state === 'Suspended' ? (
                        <Button size="small" loading={enrollmentCommand.isPending} onClick={() => enrollmentCommand.mutate({ action: 'resume', enrollmentId: row.id })}>
                          {t('web.journeys.resume')}
                        </Button>
                      ) : null}
                      {row.state !== 'Exited' && row.state !== 'Completed' ? (
                        <Button size="small" danger loading={enrollmentCommand.isPending} onClick={() => enrollmentCommand.mutate({ action: 'exit', enrollmentId: row.id })}>
                          {t('web.journeys.exit')}
                        </Button>
                      ) : null}
                    </Space>
                  ),
                },
              ]}
            />
          ) : null}
          <Space style={{ marginTop: 8 }} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={personType}
              onChange={(value: string) => setPersonType(value)}
              options={[
                { value: 'Contact', label: t('web.journeys.personContact') },
                { value: 'Lead', label: t('web.journeys.personLead') },
              ]}
            />
            <Input
              size="small"
              style={{ width: 240 }}
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
              placeholder={t('web.journeys.personIdPlaceholder')}
            />
            <Button size="small" icon={<PlusOutlined />} disabled={personId.trim() === ''} loading={enroll.isPending} onClick={() => enroll.mutate()}>
              {t('web.journeys.enroll')}
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.journeys.enrollmentsNote')}
          </Typography.Text>
        </Card>
      </Space>
    </div>
  );
}
