import { SearchOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Input, List, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api, type GlobalSearchResult } from '../api/client.js';
import { DocsLink } from '../components/docs/DocsLink.js';
import { t } from '../state/i18n.js';
import { navEntities, recordLabel, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';

/** Global search (PLAN §30): one query across readable entities, ACL enforced server-side. */
export function SearchPage() {
  const metadata = useMetadata();
  const { principal } = useSession();
  const { message } = AntApp.useApp();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [entities, setEntities] = useState<string[]>([]);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  const options = navEntities(metadata.data, principal?.type).map((entity) => ({ value: entity.name, label: entity.label }));

  const preset = params.get('q') ?? '';

  useEffect(() => {
    // Follows the URL query: the header search box navigates here with ?q=, and a second Enter only
    // changes the query, so this re-runs instead of firing once at mount. Deps are intentionally
    // [preset] — runWith/entities are recreated on every render.
    if (preset.trim() === '') return;
    setQuery(preset);
    void runWith(preset, entities);
  }, [preset]);

  const runWith = async (raw: string, scoped: string[]) => {
    const q = raw.trim();
    if (q === '') {
      void message.warning(t('web.search.queryRequired'));
      return;
    }
    setLoading(true);
    try {
      const data = await api.globalSearch({ q, ...(scoped.length > 0 ? { entities: scoped.join(',') } : {}), limit: 10 });
      setResult(data);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.search.failed'));
    } finally {
      setLoading(false);
    }
  };

  const run = async () => {
    await runWith(query, entities);
  };

  const grouped = new Map<string, { entityType: string; record: Record<string, unknown> }[]>();
  for (const hit of result?.list ?? []) {
    const list = grouped.get(hit.entityType) ?? [];
    list.push(hit);
    grouped.set(hit.entityType, list);
  }

  return (
    <Card className="carocrm-card">
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.search.title')}</h1>
          <p className="carocrm-page-sub">{t('web.search.subtitle')}</p>
        
          <DocsLink docKey="user/search" compact /></div>
      </div>
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('web.search.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onPressEnter={() => void run()}
          allowClear
        />
        <Button type="primary" loading={loading} onClick={() => void run()}>
          {t('web.search.submit')}
        </Button>
      </Space.Compact>
      <Select
        mode="multiple"
        allowClear
        style={{ width: '100%', marginBottom: 16 }}
        placeholder={t('web.search.allEntities')}
        options={options}
        value={entities}
        onChange={setEntities}
      />
      {result ? (
        <>
          <Typography.Text type="secondary">
            {t('web.search.matches', { count: result.count, total: result.total, query: result.query })}
          </Typography.Text>
          {[...grouped.entries()].map(([entityType, hits]) => (
            <div key={entityType} style={{ marginTop: 16 }}>
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {metadata.data?.[entityType]?.label ?? entityType} ({hits.length})
              </Typography.Title>
              <List
                bordered
                dataSource={hits}
                renderItem={(hit) => {
                  const id = String(hit.record['id'] ?? '');
                  return (
                    <List.Item>
                      <Link to={`/${entityType}/${id}`}>{recordLabel(hit.record, metadata.data?.[entityType])}</Link>
                      <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                        {String(hit.record['emailAddress'] ?? hit.record['email'] ?? '')}
                      </Typography.Text>
                    </List.Item>
                  );
                }}
              />
            </div>
          ))}
        </>
      ) : null}
    </Card>
  );
}
