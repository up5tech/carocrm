import { ReloadOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Space, Tabs, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { LeadScoreHealthView, LeadScoreModelRecord } from '../api/types.js';
import { ErrorState } from '../components/ErrorState.js';
import { PageHeader } from '../components/PageHeader.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { t } from '../state/i18n.js';
import { ModelsTab } from './lead-score/ModelsTab.js';
import { OperationsTab } from './lead-score/OperationsTab.js';
import { PreviewTab } from './lead-score/PreviewTab.js';
import { SettingsTab } from './lead-score/SettingsTab.js';
import { errorText, statusLabel, useEditorCatalog } from './lead-score/shared.js';

/**
 * Phase 19-LS.8 — the scoring model workspace
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §12, §16 `19-LS.8`; audit §11).
 *
 * The plan's exit criterion is that an administrator can manage a deterministic model **without editing raw
 * JSON manually or running code**, so the tabs are the four verbs of that job in the order §15.2 rolls them
 * out: draft a model, preview it on a sample, publish and rebuild, and control the module. The rule every one
 * of them follows is that the *server* answers what is legal — fields, operators, budgets from
 * `action/editor`, the verdict from `action/model/validate` — and this page only renders those answers.
 *
 * Tabs appear from capabilities, not from a guess about roles: a caller who may read scores but not manage
 * models gets the panel on the Lead (19-LS.7) and nothing here, and the endpoint behind each control enforces
 * the same answer (AGENTS.md §5.3).
 */

type TabKey = 'models' | 'preview' | 'operations' | 'settings';

export function LeadScorePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [previewModelId, setPreviewModelId] = useState<string | undefined>(undefined);

  const health = useQuery({ queryKey: ['leadScore', 'health'], queryFn: () => api.leadScoreHealth(), staleTime: 30_000, retry: false });
  const capabilities = useQuery({ queryKey: ['leadScore', 'capabilities'], queryFn: () => api.leadScoreCapabilities(), staleTime: 30_000, retry: false });
  const settings = useQuery({ queryKey: ['leadScore', 'settings'], queryFn: () => api.leadScoreSettings(), staleTime: 10_000, retry: false });
  const models = useQuery({
    queryKey: ['leadScore', 'models'],
    queryFn: async () => ((await api.list('LeadScoreModel', { maxSize: 200, orderBy: 'name,asc' })).list as unknown) as LeadScoreModelRecord[],
    staleTime: 15_000,
    retry: false,
  });
  const catalog = useEditorCatalog();

  if (health.isLoading || capabilities.isLoading) return <LoadingSkeleton rows={8} />;
  if (health.isError || health.data === undefined) {
    return <ErrorState message={`${t('leadscore.admin.page.loadFailed')} ${errorText(health.error)}`} onRetry={() => void health.refetch()} />;
  }

  const granted = new Set((capabilities.data?.capabilities ?? []).filter((entry) => entry.granted).map((entry) => entry.key));
  if (!granted.has('modelRead') && !granted.has('settingsManage')) {
    return <PermissionDenied hint={t('leadscore.admin.page.denied')} />;
  }

  const view: LeadScoreHealthView = health.data;
  const activeModelId = view.settings.scoring.activeModelId;

  function openTab(tab: TabKey, modelId?: string): void {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (modelId === undefined) next.delete('model');
    else next.set('model', modelId);
    setSearchParams(next);
    if (modelId !== undefined) setPreviewModelId(modelId);
  }

  const items = [
    ...(granted.has('modelRead')
      ? [
          {
            key: 'models',
            label: t('leadscore.admin.tab.models'),
            children: (
              <ModelsTab
                granted={granted}
                catalog={catalog.data}
                activeModelId={activeModelId}
                onPreview={(modelId) => openTab('preview', modelId)}
              />
            ),
          },
        ]
      : []),
    ...(granted.has('modelManage')
      ? [
          {
            key: 'preview',
            label: t('leadscore.admin.tab.preview'),
            children: <PreviewTab models={models.data ?? []} catalog={catalog.data} initialModelId={previewModelId ?? searchParams.get('model') ?? undefined} />,
          },
        ]
      : []),
    ...(granted.has('modelRead')
      ? [
          {
            key: 'operations',
            label: t('leadscore.admin.tab.operations'),
            children: <OperationsTab granted={granted} catalog={catalog.data} models={models.data ?? []} activeModelId={activeModelId} />,
          },
        ]
      : []),
    ...(granted.has('settingsManage')
      ? [
          {
            key: 'settings',
            label: t('leadscore.admin.tab.settings'),
            children: <SettingsTab settings={settings.data} health={view} models={models.data ?? []} canWrite />,
          },
        ]
      : []),
  ];

  return (
    <div className="carocrm-page">
      <PageHeader
        title={t('leadscore.admin.page.title')}
        subtitle={t('leadscore.admin.page.subtitle')}
        actions={
          <Space size={8} wrap>
            <Tag color={view.settings.enabled ? 'green' : 'default'}>
              {view.settings.enabled ? t('leadscore.admin.page.moduleOn') : t('leadscore.admin.page.moduleOff')}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {activeModelText(view)}
            </Typography.Text>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['leadScore'] });
                void catalog.refetch();
              }}
            >
              {t('core.common.reload')}
            </Button>
          </Space>
        }
      />

      {!view.ready ? (
        <Alert
          type={view.settings.enabled ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 16 }}
          message={view.settings.enabled ? t('leadscore.admin.page.gateClosed') : t('leadscore.admin.page.notEnabled')}
          description={view.reason}
        />
      ) : null}

      <Tabs activeKey={(searchParams.get('tab') as TabKey | null) ?? 'models'} items={items} onChange={(key) => openTab(key as TabKey)} />
    </div>
  );
}

/**
 * The model a score would be computed under, in the health view's own vocabulary.
 *
 * `state` is the *failure* vocabulary — `unset`, `missing`, `notPublished` — and it is null when the row is
 * published and usable, so a null state beside an id is the good news, not the bad.
 */
function activeModelText(health: LeadScoreHealthView): string {
  const scoring = health.settings.scoring;
  if (scoring.activeModelId === null) return t('leadscore.admin.page.noActiveModel');
  if (scoring.state !== null) return namedState(scoring.state);
  return t('leadscore.admin.page.activeModel', { version: String(scoring.modelVersion ?? ''), status: statusLabel(String(scoring.status ?? '')) });
}

function namedState(state: string | null): string {
  const key = `leadscore.admin.page.modelState.${state ?? 'unset'}`;
  const translated = t(key);
  return translated === key ? String(state) : translated;
}
