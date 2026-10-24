import {
  ApiOutlined,
  CheckCircleOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Collapse, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { ESignatureCapabilityEntry, ESignatureHealthView } from '../api/types.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { t } from '../state/i18n.js';
import { ESignatureConnectionsPanel } from './esignature/ESignatureConnectionsPanel.js';
import { ESignatureOperationsPanel } from './esignature/ESignatureOperationsPanel.js';
import { ESignatureReportsPanel } from './esignature/ESignatureReportsPanel.js';
import { ESignatureRequestsPanel } from './esignature/ESignatureRequestsPanel.js';
import { ESignatureTemplatesPanel } from './esignature/ESignatureTemplatesPanel.js';

/**
 * Phase 19-ES.1 — the ESignature module page
 * (`PLAN_Phase_19_ESignature.md` §13.1, §18 `19-ES.1`).
 *
 * ES.1 registered the module and its security contract; ES.4 added the provider connections, because
 * an administrator cannot reach the state the gate reports without a way to create and authorize one.
 * ES.6–ES.19 added the request workspace, the send guard, reporting and the recovery queues, and those
 * panels compose this page. What it answers first is what an operator needs before any of them can
 * work: whether the module is switched on, which connection stands behind it, why the gate is closed,
 * and which rights the caller holds.
 *
 * The layout answers that in three layers, so the page opens on work rather than on diagnostics:
 *
 *  1. the module's state — on or off, and the one action that changes it (reload);
 *  2. four status tiles, each a server answer: send readiness, features in effect, bound adapters and
 *     the foundation checks;
 *  3. the work area (requests, reports, operations, templates, connections), with the feature and
 *     capability inventories folded into a diagnostics section an administrator opens deliberately.
 *
 * Everything on screen is the server's answer. A right the caller lacks is reported by the server and
 * the matching endpoint refuses it too — rendering is never the enforcement (AGENTS.md §5.3).
 */

/** One tone per tile, from the design system's soft icon palette (never a free colour). */
type StatTone = 'blue' | 'green' | 'cyan' | 'yellow' | 'purple';

export function ESignaturePage() {
  const [searchParams] = useSearchParams();
  const [reportDays, setReportDays] = useState(30);
  const sourceEntityType = searchParams.get('sourceEntityType');
  const sourceRecordId = searchParams.get('sourceRecordId');
  const sourceRecordLabel = searchParams.get('sourceRecordLabel');
  const initialSource =
    sourceEntityType !== null && sourceRecordId !== null
      ? {
          entityType: sourceEntityType,
          recordId: sourceRecordId,
          ...(sourceRecordLabel === null ? {} : { recordLabel: sourceRecordLabel }),
        }
      : null;
  const initialRequestId = searchParams.get('request');
  const health = useQuery({
    queryKey: ['eSignature', 'health'],
    queryFn: () => api.eSignatureHealth(),
    staleTime: 30_000,
  });
  const capabilities = useQuery({
    queryKey: ['eSignature', 'capabilities'],
    queryFn: () => api.eSignatureCapabilities(),
    staleTime: 30_000,
  });

  if (health.isLoading || capabilities.isLoading) return <LoadingSkeleton rows={8} />;
  if (health.isError || health.data === undefined) {
    return (
      <ErrorState
        message={`${t('esignature.page.loadFailed')} ${
          health.error instanceof Error ? health.error.message : t('esignature.page.loadFailedHint')
        }`}
        onRetry={() => void health.refetch()}
      />
    );
  }

  const view: ESignatureHealthView = health.data;
  const entries = capabilities.data?.capabilities ?? [];
  const granted = new Set(entries.filter((entry) => entry.granted).map((entry) => entry.key));
  const canReadConnections = granted.has('connectionRead');
  const canManageConnections = granted.has('connectionManage');
  const effectiveFeatures = view.features.filter((feature) => feature.effective).length;
  const passedChecks = view.checks.filter((check) => check.ok).length;
  const adapterModes = view.providerAdapters.map((adapter) => t(`esignature.connections.adapterModes.${adapter.mode}`)).join(' · ');

  return (
    <div className="carocrm-page">
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">
            <Space size={10}>
              <FileSearchOutlined style={{ color: '#438eff' }} />
              {t('esignature.page.title')}
            </Space>
          </h1>
          <p className="carocrm-page-sub">{t('esignature.page.subtitle')}</p>
        </div>
        <Space size={8} wrap>
          <Tag color={view.gate.moduleEnabled ? 'green' : 'default'}>
            {view.gate.moduleEnabled ? t('esignature.page.moduleOn') : t('esignature.page.moduleOff')}
          </Tag>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              void health.refetch();
              void capabilities.refetch();
            }}
          >
            {t('core.common.reload')}
          </Button>
        </Space>
      </div>

      {view.gate.ready ? null : (
        <Alert
          type={view.gate.moduleEnabled ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 16 }}
          message={view.gate.moduleEnabled ? t('esignature.page.gateClosed') : t('esignature.page.notEnabled')}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>{gateReason(view.gate.reason)}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('esignature.page.adminNote')}
              </Typography.Text>
            </Space>
          }
          action={<Button onClick={() => void health.refetch()}>{t('core.common.reload')}</Button>}
        />
      )}

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label={t('esignature.page.stats.gate')}
            value={view.gate.ready ? t('esignature.page.stats.ready') : t('esignature.page.stats.notReady')}
            valueColor={view.gate.ready ? '#2f9e6b' : '#d98a1f'}
            hint={gateReason(view.gate.reason)}
            hintTitle={gateReason(view.gate.reason)}
            tone={view.gate.ready ? 'green' : 'yellow'}
            icon={<SafetyCertificateOutlined />}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label={t('esignature.page.stats.features')}
            value={`${effectiveFeatures}/${view.features.length}`}
            hint={t('esignature.page.stats.featuresHint')}
            tone="blue"
            icon={<CheckCircleOutlined />}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label={t('esignature.page.stats.providers')}
            value={String(view.providerAdapters.length)}
            hint={adapterModes === '' ? t('esignature.page.stats.providersHint') : adapterModes}
            hintTitle={adapterModes}
            tone="purple"
            icon={<ApiOutlined />}
          />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <StatTile
            label={t('esignature.page.stats.checks')}
            value={`${passedChecks}/${view.checks.length}`}
            valueColor={passedChecks === view.checks.length ? '#2f9e6b' : '#d98a1f'}
            hint={t('esignature.page.stats.checksHint')}
            tone={passedChecks === view.checks.length ? 'cyan' : 'yellow'}
            icon={<ExperimentOutlined />}
          />
        </Col>
      </Row>

      {granted.has('use') ? (
        <ESignatureRequestsPanel
          canPrepare={granted.has('manageDraft')}
          canSend={granted.has('send')}
          canVoid={granted.has('void')}
          canDownload={granted.has('downloadCompleted')}
          canCorrect={granted.has('correct')}
          canApprove={granted.has('approve')}
          initialSource={initialSource}
          initialRequestId={initialRequestId}
        />
      ) : null}

      {granted.has('use') ? <ESignatureReportsPanel days={reportDays} onDaysChange={setReportDays} /> : null}

      {canReadConnections ? <ESignatureOperationsPanel /> : null}

      {granted.has('templateMappingManage') ? <ESignatureTemplatesPanel /> : null}

      {canReadConnections ? <ESignatureConnectionsPanel canManage={canManageConnections} /> : null}

      {/* The inventories an administrator needs when something is wrong, not on every visit. The
          switch states, the caller's rights and the adapter's declared capabilities are all here,
          one deliberate click away, so the page above them stays about the work. */}
      <Collapse
        style={{ marginTop: 8 }}
        items={[
          {
            key: 'diagnostics',
            label: (
              <Space size={8}>
                <ExperimentOutlined />
                <Typography.Text strong>{t('esignature.page.diagnostics')}</Typography.Text>
              </Space>
            ),
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('esignature.page.diagnosticsHint')}
                </Typography.Text>

                <Card size="small" className="carocrm-card" title={t('esignature.features.title')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('esignature.features.hint')}</Typography.Text>}>
                  <Table<ESignatureHealthView['features'][number]>
                    size="small"
                    rowKey="key"
                    pagination={false}
                    dataSource={[...view.features]}
                    columns={featureColumns()}
                  />
                </Card>

                <Card size="small" className="carocrm-card" title={t('esignature.capabilities.title')}>
                  {entries.length === 0 ? (
                    <EmptyState title={t('esignature.capabilities.title')} description={t('esignature.page.loadFailedHint')} />
                  ) : (
                    <Table<ESignatureCapabilityEntry>
                      size="small"
                      rowKey="key"
                      pagination={false}
                      dataSource={[...entries]}
                      columns={capabilityColumns()}
                    />
                  )}
                </Card>

                <Card size="small" className="carocrm-card" title={t('esignature.provider.title')} extra={adapterSummary(view)}>
                  <Space size={[8, 8]} wrap>
                    {Object.entries(view.providerCapabilities).map(([key, supported]) => (
                      <Tag key={key} color={supported ? 'green' : 'default'}>
                        {t(`esignature.provider.${key}`)}
                      </Tag>
                    ))}
                  </Space>
                </Card>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}

/** One status tile: a label, the server's answer, and the sentence that qualifies it. */
function StatTile(props: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly tone: StatTone;
  readonly icon: React.ReactNode;
  readonly valueColor?: string | undefined;
  readonly hintTitle?: string | undefined;
}) {
  return (
    <Card className="carocrm-card" styles={{ body: { padding: 18 } }}>
      <div className="carocrm-stat">
        <div style={{ minWidth: 0 }}>
          <div className="carocrm-label">{props.label}</div>
          <div className="carocrm-stat-value" style={{ fontSize: 22, color: props.valueColor }}>
            {props.value}
          </div>
          <div
            className="carocrm-stat-hint"
            title={props.hintTitle ?? props.hint}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {props.hint}
          </div>
        </div>
        <span className={`carocrm-stat-icon carocrm-stat-icon--${props.tone}`}>{props.icon}</span>
      </div>
    </Card>
  );
}

/**
 * Which adapter answers for the provider, in words an operator can act on.
 *
 * A fake adapter is a real fact about the installation: nothing it "sends" ever reaches a signer, so
 * the page says which one is bound rather than letting a green tick imply a live integration.
 */
function adapterSummary(view: ESignatureHealthView): string {
  if (view.providerAdapters.length === 0) return t('esignature.provider.adapterNone');
  return view.providerAdapters
    .map((adapter) => {
      if (adapter.mode === 'fake') return t('esignature.provider.adapterFake', { version: adapter.adapterVersion });
      return t('esignature.provider.adapterLive', { version: adapter.adapterVersion });
    })
    .join(' · ');
}

function featureColumns(): ColumnsType<ESignatureHealthView['features'][number]> {
  return [
    { title: t('esignature.features.columnFeature'), dataIndex: 'key', render: (key: string) => t(`esignature.features.${key}`) },
    {
      title: t('esignature.features.columnState'),
      dataIndex: 'effective',
      width: 160,
      render: (_effective: boolean, feature) => {
        if (feature.pendingPhase !== null) {
          return <Tag>{t('esignature.features.pendingPhase', { phase: feature.pendingPhase })}</Tag>;
        }
        return (
          <Tag color={feature.effective ? 'green' : feature.enabled ? 'orange' : 'default'}>
            {feature.effective ? t('core.common.yes') : t('core.common.no')}
          </Tag>
        );
      },
    },
    { title: t('esignature.features.columnSettingsPath'), dataIndex: 'settingsPath', width: 260 },
  ];
}

function capabilityColumns(): ColumnsType<ESignatureCapabilityEntry> {
  return [
    { title: t('esignature.capabilities.columnCapability'), dataIndex: 'key', width: 220, render: (key: string) => t(`esignature.capabilities.${key}`) },
    { title: t('esignature.capabilities.columnDescription'), dataIndex: 'description' },
    {
      title: t('esignature.capabilities.columnGranted'),
      dataIndex: 'granted',
      width: 120,
      render: (granted: boolean) => (
        <Tag color={granted ? 'green' : 'default'}>{granted ? t('core.common.yes') : t('core.common.no')}</Tag>
      ),
    },
  ];
}

/** The gate's stable reason, translated; an unknown reason falls back to the server's own sentence. */
function gateReason(reason: string): string {
  const key = `esignature.page.gateReasons.${reason}`;
  const translated = t(key);
  return translated === key ? reason : translated;
}
