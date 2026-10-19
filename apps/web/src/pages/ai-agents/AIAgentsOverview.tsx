import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Col, Descriptions, List, Row, Skeleton, Space, Statistic, Tag, Typography } from 'antd';

import { api } from '../../api/client.js';
import { t } from '../../state/i18n.js';

/**
 * Phase 19-AI.2–19-AI.4 — the module's diagnostic overview, unchanged in substance: it reports what
 * the running platform actually has, not what the settings claim. The agent, run and approval
 * surfaces live in their own tabs.
 */
export function AIAgentsOverview() {
  const health = useQuery({ queryKey: ['aiAgents', 'health'], queryFn: () => api.aiAgentsHealth(), staleTime: 30_000 });
  const capabilities = useQuery({
    queryKey: ['aiAgents', 'capabilities'],
    queryFn: () => api.aiAgentsCapabilities(),
    staleTime: 30_000,
  });

  if (health.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;

  if (health.isError || health.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('web.aiAgents.loadFailed')}
        description={health.error instanceof Error ? health.error.message : t('web.aiAgents.loadFailedHint')}
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void health.refetch()}>
            {t('core.common.reload')}
          </Button>
        }
      />
    );
  }

  const view = health.data;
  const granted = (capabilities.data?.capabilities ?? []).filter((capability) => capability.granted);
  const withheld = (capabilities.data?.capabilities ?? []).filter((capability) => !capability.granted);

  return (
    <div>
      {!view.execution.enabled ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('web.aiAgents.executionDisabled')}
          description={t('web.aiAgents.executionDisabledHint')}
        />
      ) : view.execution.paused ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('web.aiAgents.executionPaused')}
          description={view.execution.reason ?? t('web.aiAgents.executionPausedHint')}
        />
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic
              title={t('web.aiAgents.healthTitle')}
              value={view.ok ? t('web.aiAgents.healthy') : t('web.aiAgents.attention')}
              valueStyle={{ fontSize: 16, color: view.ok ? '#389e0d' : '#d46b08' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic title={t('web.aiAgents.providers')} value={view.providers.count} suffix={`/ ${String(view.providers.enabledCount)}`} />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic title={t('web.aiAgents.adapters')} value={view.providers.adapterKeys.length} />
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={6}>
          <Card className="carocrm-card" size="small">
            <Statistic
              title={t('web.aiAgents.settingsVersion', { version: view.settings.version })}
              value={view.settings.updatedAt === null ? t('web.aiAgents.neverUpdated') : new Date(view.settings.updatedAt).toLocaleDateString()}
              valueStyle={{ fontSize: 14 }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card className="carocrm-card" size="small" title={t('web.aiAgents.dependencies')}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
              {t('web.aiAgents.dependenciesHint')}
            </Typography.Paragraph>
            <List
              size="small"
              dataSource={[...view.dependencies]}
              renderItem={(dependency) => (
                <List.Item>
                  <Space>
                    <Badge status={dependency.present ? 'success' : 'error'} />
                    <Typography.Text>{dependency.label}</Typography.Text>
                  </Space>
                  <Tag color={dependency.present ? 'green' : 'red'}>
                    {dependency.present ? t('web.aiAgents.present') : t('web.aiAgents.missing')}
                  </Tag>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="carocrm-card" size="small" title={t('web.aiAgents.features')} style={{ marginBottom: 12 }}>
            <Space size={[8, 8]} wrap>
              {view.features.map((feature) => (
                <Tag key={feature.key} color={feature.enabled ? 'blue' : 'default'} style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>
                  {feature.label}: {feature.enabled ? t('web.aiAgents.enabled') : t('web.aiAgents.disabled')}
                </Tag>
              ))}
            </Space>
          </Card>
          <Card className="carocrm-card" size="small" title={t('web.aiAgents.providers')}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label={t('web.aiAgents.adapters')}>
                {view.providers.adapters.length === 0 ? (
                  t('web.aiAgents.noAdapters')
                ) : (
                  <Space size={[8, 8]} wrap>
                    {view.providers.adapters.map((adapter) => (
                      <Tag key={adapter.key} style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>{adapter.label}</Tag>
                    ))}
                  </Space>
                )}
              </Descriptions.Item>
              {view.providers.defaultKey === null ? null : (
                <Descriptions.Item label={t('web.aiAgents.default')}>{view.providers.defaultKey}</Descriptions.Item>
              )}
              <Descriptions.Item label={t('web.aiAgents.encryption')}>
                <Tag color={view.providers.encryptionConfigured ? 'green' : 'orange'} style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>
                  {view.providers.encryptionConfigured
                    ? t('web.aiAgents.encryptionConfigured')
                    : t('web.aiAgents.encryptionMissing')}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('web.aiAgents.credentials')}>{view.providers.credentialCount}</Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              {t('web.aiAgents.providersHint')}
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card className="carocrm-card" size="small" title={t('web.aiAgents.checks')}>
            <List
              size="small"
              dataSource={[...view.checks]}
              renderItem={(check) => (
                <List.Item>
                  <Space align="start">
                    <Badge status={check.ok ? 'success' : 'error'} />
                    <div>
                      <Typography.Text strong>{check.name}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {check.detail}
                      </Typography.Text>
                    </div>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="carocrm-card" size="small" title={t('web.aiAgents.capabilities')}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
              {t('web.aiAgents.capabilitiesHint')}
            </Typography.Paragraph>
            {granted.length === 0 ? (
              <Typography.Text type="secondary">{t('web.aiAgents.noCapabilities')}</Typography.Text>
            ) : (
              <Space size={[8, 8]} wrap>
                {granted.map((capability) => (
                  <Tag key={capability.key} color="blue" title={capability.description} style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>
                    {capability.label}
                  </Tag>
                ))}
              </Space>
            )}
            {withheld.length === 0 ? null : (
              <>
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 4, fontSize: 12 }}>
                  {t('web.aiAgents.notGranted')}
                </Typography.Paragraph>
                <Space size={[8, 8]} wrap>
                  {withheld.map((capability) => (
                    <Tag key={capability.key} title={capability.description} style={{ whiteSpace: 'normal', height: 'auto', lineHeight: 1.4 }}>
                      {capability.label}
                    </Tag>
                  ))}
                </Space>
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
