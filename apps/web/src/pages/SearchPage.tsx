import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, Button, Card, Input, List, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import { usePageDocs } from '../components/docs/PageDocs.js';
import { PageHeader } from '../components/PageHeader.js';
import { errorMessage } from '../lib/errors.js';
import { t } from '../state/i18n.js';
import { navEntities, recordLabel, useMetadata } from '../state/metadata.js';
import { useSession } from '../state/session.js';
/** Global search (PLAN §30): one query across readable entities, ACL enforced server-side. */
export function SearchPage() {
  usePageDocs('user/search');
  const metadata = useMetadata();
  const { principal } = useSession();
  const { message } = AntApp.useApp();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [entities, setEntities] = useState<string[]>([]);
  // 24.10.3: the executed search is query state, not a fetch effect — the URL preset and the submit
  // button both write it, and React Query owns loading/error/data for that exact {q, entities} pair.
  const [submitted, setSubmitted] = useState<{ q: string; entities: string[] } | null>(null);

  const options = navEntities(metadata.data, principal?.type).map((entity) => ({ value: entity.name, label: entity.label }));

  const preset = params.get('q') ?? '';

  const search = useQuery({
    queryKey: ['globalSearch', submitted?.q ?? '', submitted?.entities ?? []],
    queryFn: () =>
      api.globalSearch({
        q: submitted?.q ?? '',
        ...(submitted !== null && submitted.entities.length > 0 ? { entities: submitted.entities.join(',') } : {}),
        limit: 10,
      }),
    enabled: submitted !== null,
  });
  const loading = search.isFetching;
  const result = search.data ?? null;

  useEffect(() => {
    if (search.isError) void message.error(errorMessage(search.error, t('web.search.failed')));
  }, [search.isError, search.error, message]);

  useEffect(() => {
    // Follows the URL query: the header search box navigates here with ?q=, and a second Enter only
    // changes the query, so this re-runs instead of firing once at mount. Deps are intentionally
    // [preset] — `entities` is read from this render's closure, matching the old runWith capture.
    if (preset.trim() === '') return;
    setQuery(preset);
    setSubmitted({ q: preset.trim(), entities });
  }, [preset]);

  const run = () => {
    const q = query.trim();
    if (q === '') {
      void message.warning(t('web.search.queryRequired'));
      return;
    }
    setSubmitted({ q, entities });
  };

  const grouped = new Map<string, { entityType: string; record: Record<string, unknown> }[]>();
  for (const hit of result?.list ?? []) {
    const list = grouped.get(hit.entityType) ?? [];
    list.push(hit);
    grouped.set(hit.entityType, list);
  }

  return (
    <Card className="carocrm-card">
      <PageHeader
        title={t('web.search.title')}
        subtitle={t('web.search.subtitle')}
      />
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
