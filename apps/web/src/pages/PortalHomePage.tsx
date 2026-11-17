import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Col, Descriptions, Row, Skeleton, Space, Typography } from 'antd';
import { Link } from 'react-router-dom';

import { api } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { t } from '../state/i18n.js';
import { portalBase, usePortalContext } from '../state/portal.js';
import { DashletResult } from './DashletResult.js';

/**
 * Phase 18 — the portal user's home (PLAN §37). Shows the contact the user is, the portal
 * navigation and the portal dashboard; every dashlet executes server-side under the portal
 * ACL, which is why nothing here needs a permission check of its own.
 */
export function PortalHomePage() {
  const context = usePortalContext();

  const dashboard = context.data?.dashboard ?? null;
  // 24.10.3: dashlet execution is a query keyed by the dashboard — and allSettled, so a dashlet the
  // portal ACL refuses fails alone instead of emptying the whole dashboard (the comment's intent,
  // which Promise.all never actually delivered).
  const dashlets = useQuery({
    queryKey: ['portal', 'dashlets', dashboard?.id ?? ''],
    queryFn: async () => {
      if (dashboard === null) return {};
      const settled = await Promise.allSettled(dashboard.dashlets.map((dashlet) => api.runPortalDashlet(dashlet.id)));
      const out: Record<string, Record<string, unknown>> = {};
      settled.forEach((result, index) => {
        const dashlet = dashboard.dashlets[index];
        if (result.status === 'fulfilled' && dashlet !== undefined) out[dashlet.id] = result.value;
      });
      return out;
    },
    enabled: dashboard !== null && dashboard.dashlets.length > 0,
  });
  const results = dashlets.data ?? {};
  const running = dashlets.isFetching;

  if (context.isLoading) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }
  if (context.error || !context.data) {
    return <Alert type="error" message={t('web.portal.unavailable')} />;
  }

  const { portal, user, contact, roles, nav } = context.data;
  const base = portalBase('portal');

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card className="carocrm-card" title={t('web.portal.welcome', { portal: portal.name, user: user.firstName ?? user.userName })}>
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label={t('web.portal.signedInAs')}>{user.userName}</Descriptions.Item>
          <Descriptions.Item label={t('web.portal.contact')}>
            {contact ? `${contact.name ?? contact.id}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={t('web.portal.roles')}>{roles.length > 0 ? roles.map((role) => role.name).join(', ') : '—'}</Descriptions.Item>
          <Descriptions.Item label={t('web.portal.portal')}>{portal.name}</Descriptions.Item>
        </Descriptions>
      </Card>

      {nav.length > 0 ? (
        <Card className="carocrm-card" size="small" title={t('web.portal.navigate')}>
          <Row gutter={[12, 12]}>
            {nav.map((item) => (
              <Col key={item.id} xs={12} sm={8} md={6}>
                <Card size="small" hoverable>
                  <Link to={item.entity ? `${base}/${item.entity}` : (item.route ?? base)}>{item.label}</Link>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      ) : null}

      <Card className="carocrm-card" title={dashboard?.name ?? t('web.portal.dashboard')} loading={running}>
        {dashboard && dashboard.dashlets.length > 0 ? (
          <Row gutter={[12, 12]}>
            {dashboard.dashlets.map((dashlet) => (
              <Col key={dashlet.id} xs={24} md={12}>
                <Card size="small" title={dashlet.name}>
                  <DashletResult dashlet={dashlet} result={results[dashlet.id]} />
                </Card>
              </Col>
            ))}
          </Row>
        ) : (
          <EmptyState description={t('web.portal.noDashboard')} />
        )}
      </Card>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {t('web.portal.footnote')}
      </Typography.Paragraph>
    </Space>
  );
}
