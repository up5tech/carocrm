import { RobotOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Skeleton, Space, Tabs, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { t } from '../state/i18n.js';
import { AIAgentsAgentsTab } from './ai-agents/AIAgentsAgentsTab.js';
import { AIAgentsApprovalsTab } from './ai-agents/AIAgentsApprovalsTab.js';
import { AIAgentsConversationsTab } from './ai-agents/AIAgentsConversationsTab.js';
import { AIAgentsEvaluationsTab } from './ai-agents/AIAgentsEvaluationsTab.js';
import { AIAgentsOverview } from './ai-agents/AIAgentsOverview.js';
import { AIAgentsProvidersTab } from './ai-agents/AIAgentsProvidersTab.js';
import { AIAgentsRunsTab } from './ai-agents/AIAgentsRunsTab.js';
import { AIAgentsSettingsTab } from './ai-agents/AIAgentsSettingsTab.js';
import { AIAgentsUsageTab } from './ai-agents/AIAgentsUsageTab.js';

/**
 * Phase 19-AI.5–19-AI.10 — the AI Agents workspace
 * (PLAN_Phase_19_AI_Agents.md §15, §20).
 *
 * One page, five surfaces: diagnostics, definitions, the run console, the approval inbox and usage.
 * A tab exists only when the caller holds the capability it needs, but the server enforces every
 * endpoint regardless — the tabs are orientation, not authorization.
 */
export function AIAgentsPage() {
  const capabilities = useQuery({
    queryKey: ['aiAgents', 'capabilities'],
    queryFn: () => api.aiAgentsCapabilities(),
    staleTime: 30_000,
  });
  const [tab, setTab] = useState('overview');
  const [focusRunId, setFocusRunId] = useState<string | undefined>(undefined);

  const granted = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const capability of capabilities.data?.capabilities ?? []) map[capability.key] = capability.granted;
    return map;
  }, [capabilities.data]);

  const openRun = useCallback((runId: string) => {
    setFocusRunId(runId);
    setTab('runs');
  }, []);

  const consumeFocus = useCallback(() => setFocusRunId(undefined), []);

  if (capabilities.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (capabilities.isError || capabilities.data === undefined) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('web.aiAgents.loadFailed')}
        description={capabilities.error instanceof Error ? capabilities.error.message : t('web.aiAgents.loadFailedHint')}
        action={<Button onClick={() => void capabilities.refetch()}>{t('core.common.reload')}</Button>}
      />
    );
  }

  const execution = capabilities.data.execution;
  const items = [
    { key: 'overview', label: t('web.aiAgents.overview'), children: <AIAgentsOverview /> },
    {
      key: 'agents',
      label: t('web.aiAgents.agentsTab'),
      children: (
        <AIAgentsAgentsTab
          capabilities={granted}
          executionAvailable={execution.available}
          onOpenRun={openRun}
        />
      ),
    },
    {
      key: 'runs',
      label: t('web.aiAgents.runsTab'),
      children: (
        <AIAgentsRunsTab
          capabilities={granted}
          focusRunId={focusRunId}
          onFocusConsumed={consumeFocus}
          onOpenApprovals={() => setTab('approvals')}
        />
      ),
    },
  ];
  if (capabilities.data.memory.enabled && granted['use']) {
    items.push({
      key: 'conversations',
      label: t('web.aiAgents.conversationsTab'),
      children: <AIAgentsConversationsTab capabilities={granted} />,
    });
  }
  if (granted['approval']) {
    items.push({
      key: 'approvals',
      label: t('web.aiAgents.approvalsTab'),
      children: <AIAgentsApprovalsTab capabilities={granted} />,
    });
  }
  if (granted['usage']) {
    items.push({
      key: 'usage',
      label: t('web.aiAgents.usageTab'),
      children: <AIAgentsUsageTab capabilities={granted} />,
    });
  }
  if (granted['evaluation']) {
    items.push({
      key: 'evaluations',
      label: t('web.aiAgents.evaluationsTab'),
      children: <AIAgentsEvaluationsTab capabilities={granted} />,
    });
  }
  // Administration surfaces. They are ordinary tabs of the module page, not a separate console:
  // an administrator configuring a provider is already in the module, and the tab is rendered only
  // when the server reports the matching capability. The endpoints re-check it regardless.
  if (granted['providerAdmin']) {
    items.push({
      key: 'providers',
      label: t('web.aiAgents.providersTab'),
      children: <AIAgentsProvidersTab />,
    });
  }
  if (granted['policyAdmin']) {
    items.push({
      key: 'settings',
      label: t('web.aiAgents.settingsTab'),
      children: <AIAgentsSettingsTab capabilities={granted} />,
    });
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <header style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          <Space size={8}>
            <RobotOutlined />
            {t('web.aiAgents.title')}
            <DocsLink docKey="user/ai-agents" compact />
          </Space>
        </Typography.Title>
        <Space size={[8, 4]} wrap>
          <Typography.Text type="secondary">{t('web.aiAgents.subtitle')}</Typography.Text>
          {execution.available ? null : (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {execution.paused ? t('web.aiAgents.executionPausedShort') : t('web.aiAgents.executionDisabledShort')}
            </Typography.Text>
          )}
        </Space>
      </header>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={items}
        tabBarStyle={{ marginBottom: 16 }}
      />
    </div>
  );
}
