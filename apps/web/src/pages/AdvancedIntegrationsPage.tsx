import { ApiOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Skeleton, Space, Tabs, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';
import { IntegrationsCatalogTab } from './advanced-integrations/IntegrationsCatalogTab.js';
import { IntegrationsConflictsTab } from './advanced-integrations/IntegrationsConflictsTab.js';
import { IntegrationsConnectionsTab } from './advanced-integrations/IntegrationsConnectionsTab.js';
import { IntegrationsMappingTab } from './advanced-integrations/IntegrationsMappingTab.js';
import { IntegrationsRunsTab } from './advanced-integrations/IntegrationsRunsTab.js';

/**
 * Phase 19-INT.14 / 19-INT.15 — the Advanced Integrations workspace
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15; `19-INT.14`, `19-INT.15`).
 *
 * One page, five surfaces: the connector catalog, the connections to those connectors, the
 * mapping builder, the sync run history and the conflict workbench.
 *
 * A tab appears only when the caller holds the capability behind it, but the server enforces every
 * endpoint regardless — the tabs are orientation, not authorization.
 */
export function AdvancedIntegrationsPage() {
  const capabilities = useQuery({
    queryKey: ['advancedIntegrations', 'capabilities'],
    queryFn: () => api.advancedIntegrationsCapabilities(),
    staleTime: 30_000,
  });
  const [tab, setTab] = useState('catalog');

  const granted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const capability of capabilities.data?.capabilities ?? []) map[capability.key] = capability.granted;
    return map;
  }, [capabilities.data]);

  if (capabilities.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (capabilities.isError || capabilities.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('advancedintegrations.page.loadFailed')}
        description={
          capabilities.error instanceof Error
            ? capabilities.error.message
            : t('advancedintegrations.page.loadFailedHint')
        }
        action={<Button onClick={() => void capabilities.refetch()}>{t('core.common.reload')}</Button>}
      />
    );
  }

  // A tab appears only when the caller holds the capability behind it. The server enforces every
  // endpoint regardless — the tabs are orientation, not authorization.
  const items = [
    granted['providerAdmin']
      ? {
          key: 'catalog',
          label: t('advancedintegrations.providers.title'),
          children: <IntegrationsCatalogTab />,
        }
      : null,
    granted['use']
      ? {
          key: 'connections',
          label: t('advancedintegrations.connections.title'),
          children: <IntegrationsConnectionsTab />,
        }
      : null,
    granted['use']
      ? {
          key: 'mappings',
          label: t('advancedintegrations.mapping.title'),
          children: <IntegrationsMappingTab />,
        }
      : null,
    granted['use']
      ? {
          key: 'runs',
          label: t('advancedintegrations.runs.title'),
          children: <IntegrationsRunsTab />,
        }
      : null,
    granted['use']
      ? {
          key: 'conflicts',
          label: t('advancedintegrations.conflicts.title'),
          children: <IntegrationsConflictsTab />,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) {
    return (
      <Alert
        type="warning"
        showIcon
        message={t('advancedintegrations.page.loadFailed')}
        description={t('advancedintegrations.page.loadFailedHint')}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <header className="carocrm-page-head" style={{ display: 'block' }}>
        {/* A real heading, so the page has an accessible name and the browser's heading
            navigation works. */}
        <Typography.Title level={4} className="carocrm-page-title" style={{ margin: 0 }}>
          <Space size={8}>
            <ApiOutlined />
            {t('advancedintegrations.page.title')}
          </Space>
        </Typography.Title>
        <p className="carocrm-page-sub">{t('advancedintegrations.page.subtitle')}</p>
      </header>
      <Tabs activeKey={tab} onChange={setTab} items={items} tabBarStyle={{ marginBottom: 16 }} />
    </div>
  );
}
