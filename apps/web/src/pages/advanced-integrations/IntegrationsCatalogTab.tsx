import { InfoCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Modal, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../../api/client.js';
import type { IntegrationCatalogProvider, IntegrationProviderTier } from '../../api/types.js';
import { t } from '../../state/i18n.js';
import { ConnectionWizard } from './ConnectionWizard.js';
import { type ConnectionTone, PanelEmpty, SectionToolbar, TonePill } from './shared.js';

/**
 * Phase 19-INT.14 — the connector catalog
 * (`PLAN_Phase_19_Advanced_Integrations.md` §15.1).
 *
 * The catalog is a **scannable list**, not a card grid. A CRM administrator with twenty
 * connectors does not browse; they scan for one. Each row leads with a status rail — the health of
 * that connector's wires — then a quiet provider tile, then the facts that decide whether it is
 * worth connecting: how many objects it carries, how it authenticates, and what it demands.
 *
 * A category band breaks the list into the provider families the server registers, in the order
 * an operator expects to find them. A visible row never implies the connector is configured. The
 * action says exactly what happens: "Connect" opens the wizard.
 */

const TIER_TONES: Readonly<Record<IntegrationProviderTier, ConnectionTone>> = {
  core: 'ok',
  optional: 'idle',
  experimental: 'warn',
  deprecated: 'error',
};

/** The server's first-class provider families, in the order the catalog presents them. */
const CATEGORY_ORDER: readonly string[] = [
  'platform',
  'productivity',
  'marketing',
  'accounting',
  'commerce',
  'payments',
];

interface CatalogGroup {
  readonly category: string;
  readonly providers: readonly IntegrationCatalogProvider[];
}

export function IntegrationsCatalogTab() {
  const [search, setSearch] = useState('');
  const [wizardProvider, setWizardProvider] = useState<IntegrationCatalogProvider | null>(null);
  const [infoProvider, setInfoProvider] = useState<IntegrationCatalogProvider | null>(null);
  const catalog = useQuery({
    queryKey: ['advancedIntegrations', 'catalog'],
    queryFn: () => api.integrationCatalog(),
    staleTime: 30_000,
  });

  const providers = useMemo(() => {
    const list = catalog.data?.list ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return list;
    return list.filter(
      (provider) =>
        provider.displayName.toLowerCase().includes(needle) ||
        provider.providerKey.toLowerCase().includes(needle) ||
        provider.category.toLowerCase().includes(needle) ||
        provider.description.toLowerCase().includes(needle),
    );
  }, [catalog.data, search]);

  const groups = useMemo(() => groupByCategory(providers), [providers]);

  const all = catalog.data?.list ?? [];
  const summary = {
    connectors: all.length,
    connections: all.reduce((total, provider) => total + provider.connectionCount, 0),
    ready: all.filter((provider) => provider.executable).length,
  };

  return (
    <div>
      <SectionToolbar
        title={t('advancedintegrations.providers.title')}
        subtitle={t('advancedintegrations.providers.subtitle')}
        actions={
          <div className="carocrm-int-search">
            <Input.Search
              allowClear
              placeholder={t('advancedintegrations.providers.searchPlaceholder')}
              aria-label={t('advancedintegrations.providers.searchPlaceholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        }
      />

      {catalog.isLoading ? (
        <div className="carocrm-int-loading">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : catalog.isError ? (
        <div className="carocrm-int-state">
          <PanelEmpty
            text={t('advancedintegrations.providers.loadFailed')}
            action={<Button onClick={() => void catalog.refetch()}>{t('core.common.reload')}</Button>}
          />
        </div>
      ) : all.length === 0 ? (
        <div className="carocrm-int-state">
          <PanelEmpty text={t('advancedintegrations.providers.empty')} />
        </div>
      ) : (
        <>
          <div className="carocrm-int-summary">
            <SummaryFact
              value={summary.connectors}
              label={t('advancedintegrations.providers.summary.connectors')}
            />
            <SummaryFact
              value={summary.connections}
              label={t('advancedintegrations.providers.summary.connections')}
            />
            <SummaryFact
              value={summary.ready}
              label={t('advancedintegrations.providers.summary.ready')}
            />
          </div>

          {providers.length === 0 ? (
            <div className="carocrm-int-state">
              <PanelEmpty text={t('advancedintegrations.providers.noResults')} />
            </div>
          ) : (
            <div className="carocrm-int-catalog">
              {groups.map((group) => {
                const labelId = categoryAnchor(group.category);
                return (
                  <section key={group.category} className="carocrm-int-category" aria-labelledby={labelId}>
                    <div className="carocrm-int-category-head">
                      <h5 id={labelId} className="carocrm-int-category-label">
                        {categoryLabel(group.category)}
                      </h5>
                      <span className="carocrm-int-category-count">{String(group.providers.length)}</span>
                    </div>
                    <ul className="carocrm-int-provider-list">
                      {group.providers.map((provider) => (
                        <CatalogRow
                          key={provider.providerKey}
                          provider={provider}
                          onConnect={() => setWizardProvider(provider)}
                          onInfo={() => setInfoProvider(provider)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {wizardProvider === null ? null : (
        <ConnectionWizard provider={wizardProvider} onClose={() => setWizardProvider(null)} />
      )}

      <IntegrationInfoModal provider={infoProvider} onClose={() => setInfoProvider(null)} />
    </div>
  );
}

function SummaryFact({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <span className="carocrm-int-summary-item">
      <strong className="carocrm-int-summary-value">{String(value)}</strong>
      <span className="carocrm-int-summary-label">{label}</span>
    </span>
  );
}

function CatalogRow({
  provider,
  onConnect,
  onInfo,
}: {
  readonly provider: IntegrationCatalogProvider;
  readonly onConnect: () => void;
  readonly onInfo: () => void;
}) {
  const tone: ConnectionTone = provider.executable
    ? provider.healthyCount > 0
      ? 'ok'
      : 'idle'
    : 'error';
  const initial = provider.displayName.trim().charAt(0).toUpperCase() || '?';
  const disabledReason = t('advancedintegrations.providers.executableNo');
  const reasonId = `int-connect-reason-${provider.providerKey}`;
  const shownScopes = provider.requiredScopes.slice(0, 2);
  const hiddenScopes = provider.requiredScopes.slice(2);

  const connectButton = (
    <Button
      type="primary"
      disabled={!provider.executable}
      onClick={onConnect}
      aria-label={`${t('advancedintegrations.providers.connect')} — ${provider.displayName}`}
      aria-describedby={provider.executable ? undefined : reasonId}
    >
      {t('advancedintegrations.providers.connect')}
    </Button>
  );

  return (
    <li className="carocrm-int-provider">
      <span
        className={`carocrm-rail carocrm-rail--${tone}`}
        role="presentation"
        title={
          provider.executable
            ? t('advancedintegrations.providers.executableYes')
            : t('advancedintegrations.providers.executableNo')
        }
      />
      <span className="carocrm-int-tile" aria-hidden="true">
        {initial}
      </span>
      <div className="carocrm-int-provider-body">
        <div className="carocrm-int-provider-title">
          <span className="carocrm-int-provider-name">{provider.displayName}</span>
          {/* The row states how much it carries; this explains exactly which data that is. */}
          <Tooltip title={t('advancedintegrations.providers.infoHint')}>
            <Button
              type="text"
              size="small"
              className="carocrm-int-info"
              icon={<InfoCircleOutlined />}
              aria-label={t('advancedintegrations.providers.infoTitle', { provider: provider.displayName })}
              onClick={onInfo}
            />
          </Tooltip>
          <TonePill tone={TIER_TONES[provider.tier]} label={provider.tier} />
          <span className="carocrm-int-auth" title={t('advancedintegrations.providers.authentication')}>
            {provider.authentication.replaceAll('_', ' ')}
          </span>
        </div>
        <p className="carocrm-int-provider-desc" title={provider.description}>
          {provider.description}
        </p>
        <div className="carocrm-int-provider-meta">
          <span>
            {t('advancedintegrations.providers.objects')} {String(provider.objects.length)}
          </span>
          <span className="carocrm-int-meta-sep" aria-hidden="true">
            ·
          </span>
          <span>
            {t('advancedintegrations.providers.connections')} {String(provider.connectionCount)}
            {provider.healthyCount > 0
              ? ` (${String(provider.healthyCount)} ${t('advancedintegrations.providers.healthy')})`
              : ''}
          </span>
          <span className="carocrm-int-meta-sep" aria-hidden="true">
            ·
          </span>
          <span>
            {t('advancedintegrations.connections.scopes')} {String(provider.requiredScopes.length)}
          </span>
        </div>
        {provider.requiredScopes.length > 0 ? (
          <div className="carocrm-int-scopes">
            {shownScopes.map((scope) => (
              <span key={scope} className="carocrm-int-chip" title={scope}>
                {shortScope(scope)}
              </span>
            ))}
            {hiddenScopes.length > 0 ? (
              <Tooltip title={hiddenScopes.join(', ')}>
                <span
                  className="carocrm-int-chip carocrm-int-chip--more"
                  tabIndex={0}
                  title={hiddenScopes.join(', ')}
                  aria-label={hiddenScopes.join(', ')}
                >
                  +{String(hiddenScopes.length)}
                </span>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="carocrm-int-provider-actions">
        {provider.docsUrl === null ? null : (
          <a className="carocrm-int-docs" href={provider.docsUrl} target="_blank" rel="noreferrer">
            {t('advancedintegrations.providers.docs')}
          </a>
        )}
        {provider.executable ? (
          connectButton
        ) : (
          <Tooltip title={disabledReason}>
            <span className="carocrm-int-connect-wrap">{connectButton}</span>
          </Tooltip>
        )}
        {provider.executable ? null : (
          <span id={reasonId} className="carocrm-int-sr-only">
            {disabledReason}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * What one connector actually exchanges, opened from the row's info icon.
 *
 * The row can only say "six objects"; this says which six and in which direction, which is the
 * question an operator asks before granting an OAuth scope. Directions are derived from the
 * capability flags the adapter declares: `read` pulls provider records into the CRM, `write` sends
 * CRM changes back, and `webhook` means the provider pushes changes itself.
 */
function IntegrationInfoModal({
  provider,
  onClose,
}: {
  readonly provider: IntegrationCatalogProvider | null;
  readonly onClose: () => void;
}) {
  if (provider === null) return null;
  const required = provider.requiredScopes;
  const optional = provider.optionalScopes;

  return (
    <Modal
      open
      onCancel={onClose}
      width={680}
      footer={<Button onClick={onClose}>{t('advancedintegrations.providers.infoClose')}</Button>}
      title={
        <Space size={8}>
          <InfoCircleOutlined style={{ color: 'var(--carocrm-c-438eff)' }} />
          <span>{t('advancedintegrations.providers.infoTitle', { provider: provider.displayName })}</span>
        </Space>
      }
    >
      <p className="carocrm-int-info-desc">{provider.description}</p>

      <h6 className="carocrm-int-info-heading">{t('advancedintegrations.providers.infoDataTitle')}</h6>
      <p className="carocrm-int-info-hint">{t('advancedintegrations.providers.infoDataHint')}</p>
      {provider.objects.length === 0 ? (
        <Typography.Text type="secondary">{t('advancedintegrations.providers.infoNoObjects')}</Typography.Text>
      ) : (
        <ul className="carocrm-int-info-objects">
          {provider.objects.map((object) => (
            <li key={object.objectType} className="carocrm-int-info-object">
              <div className="carocrm-int-info-object-name">
                <span>{object.label}</span>
                <code>{object.objectType}</code>
              </div>
              <Space size={[4, 4]} wrap>
                {object.read ? (
                  <Tag color="blue">{t('advancedintegrations.providers.infoRead')}</Tag>
                ) : null}
                {object.write ? (
                  <Tag color="green">{t('advancedintegrations.providers.infoWrite')}</Tag>
                ) : null}
                {object.webhook ? (
                  <Tag color="gold">{t('advancedintegrations.providers.infoWebhook')}</Tag>
                ) : null}
              </Space>
            </li>
          ))}
        </ul>
      )}

      <h6 className="carocrm-int-info-heading">{t('advancedintegrations.providers.infoScopesTitle')}</h6>
      {required.length === 0 && optional.length === 0 ? (
        <Typography.Text type="secondary">
          {t('advancedintegrations.providers.infoScopesNone')}
        </Typography.Text>
      ) : (
        <div className="carocrm-int-info-scopes">
          {required.length === 0 ? null : (
            <div className="carocrm-int-info-scope-row">
              <span className="carocrm-int-info-scope-label">
                {t('advancedintegrations.providers.infoScopesRequired')}
              </span>
              <Space size={[4, 4]} wrap>
                {required.map((scope) => (
                  <Tag key={`required:${scope}`} color="blue" title={scope}>
                    {scope}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          {optional.length === 0 ? null : (
            <div className="carocrm-int-info-scope-row">
              <span className="carocrm-int-info-scope-label">
                {t('advancedintegrations.providers.infoScopesOptional')}
              </span>
              <Space size={[4, 4]} wrap>
                {optional.map((scope) => (
                  <Tag key={`optional:${scope}`} title={scope}>
                    {scope}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
        </div>
      )}

      <h6 className="carocrm-int-info-heading">{t('advancedintegrations.providers.infoAuthTitle')}</h6>
      <Typography.Text>{provider.authentication.replaceAll('_', ' ')}</Typography.Text>
    </Modal>
  );
}

/** The catalog order: the known families first, then any unknown family alphabetically. */
function groupByCategory(providers: readonly IntegrationCatalogProvider[]): CatalogGroup[] {
  const byCategory = new Map<string, IntegrationCatalogProvider[]>();
  for (const provider of providers) {
    const group = byCategory.get(provider.category);
    if (group === undefined) byCategory.set(provider.category, [provider]);
    else group.push(provider);
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({ category, providers: list }))
    .sort(
      (left, right) =>
        categoryRank(left.category) - categoryRank(right.category) ||
        left.category.localeCompare(right.category),
    );
}

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** The translated family label, or a readable fallback for a family the catalog did not define. */
function categoryLabel(category: string): string {
  const key = `advancedintegrations.providers.category.${category}`;
  const translated = t(key);
  return translated === key ? humanize(category) : translated;
}

function humanize(value: string): string {
  const text = value.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  if (text === '') return value;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function categoryAnchor(category: string): string {
  return `int-category-${category.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

/** A scope is shown as its short, recognisable tail; the full value stays in the chip title. */
function shortScope(scope: string): string {
  const trimmed = scope.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const auth = trimmed.split('/auth/')[1];
  if (auth !== undefined) return auth.replace(/\/+$/, '');
  const parts = trimmed.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? trimmed;
}
