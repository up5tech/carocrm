/**
 * Phase 19-MA.5 — the public preference and unsubscribe page
 * (PLAN_Phase_19_Marketing_Automation.md §5.3.1, §5.3.2, §8.3).
 *
 * The page receives only the opaque token from the link: it never names, loads or searches a CRM record, so
 * a leaked URL cannot be used to browse anything, and someone testing addresses against it learns nothing —
 * every invalid link produces the same screen. Nothing here decides eligibility; the server does, and the
 * page only shows the states it is given and posts the deliberate action (§9.2, AGENTS.md §8).
 *
 * A GET renders and changes nothing. The opt-out is the POST behind the button, because mail clients and
 * link-preview crawlers fetch URLs and must not be able to unsubscribe a recipient by looking at a message
 * (§5.3.1).
 */

import { App as AntApp, Button, Card, Result, Space, Table, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { MarketingPreferenceView } from '../api/types.js';
import { formatDateTime, t } from '../state/i18n.js';

export function MarketingPreferencesPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { message } = AntApp.useApp();
  const [view, setView] = useState<MarketingPreferenceView | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<'unsubscribed' | 'all' | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.marketingPreferences(token));
      setFailed(false);
    } catch {
      // The server's answer is deliberately generic; so is this screen.
      setFailed(true);
    }
  }, [token]);

  useEffect(() => {
    if (token !== '') void load();
  }, [token, load]);

  if (token === '') {
    return <Result status="warning" title={t('web.marketing.preferences.missingToken')} />;
  }
  if (failed) {
    return <Result status="warning" title={t('web.marketing.preferences.invalid')} />;
  }
  if (done !== undefined) {
    return (
      <Result
        status="success"
        title={done === 'all' ? t('web.marketing.preferences.doneAll') : t('web.marketing.preferences.done')}
        subTitle={t('web.marketing.preferences.doneHint')}
      />
    );
  }
  if (view === undefined) {
    return <Card className="lizant-card" loading style={{ maxWidth: 640, margin: '0 auto' }} />;
  }

  const act = async (all: boolean): Promise<void> => {
    setBusy(true);
    try {
      await api.marketingUnsubscribe(token, { all });
      setDone(all ? 'all' : 'unsubscribed');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.marketing.preferences.invalid'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="lizant-card"
      title={<Typography.Text strong>{t('web.marketing.preferences.title')}</Typography.Text>}
      style={{ maxWidth: 640, margin: '0 auto' }}
    >
      <Typography.Paragraph type="secondary">{t('web.marketing.preferences.intro')}</Typography.Paragraph>

      {view.globallySuppressed ? (
        <Result
          status="info"
          style={{ padding: '12px 0' }}
          title={t('web.marketing.preferences.globallySuppressed')}
          subTitle={t('web.marketing.preferences.globallySuppressedHint')}
        />
      ) : null}

      <Table
        size="small"
        rowKey="purpose"
        pagination={false}
        dataSource={[...view.categories]}
        columns={[
          {
            title: t('web.marketing.preferences.category'),
            dataIndex: 'purpose',
            render: (purpose: string) => t(`marketing.purpose.${purpose}`),
          },
          {
            title: t('web.marketing.preferences.state'),
            dataIndex: 'status',
            width: 180,
            render: (status: string) => (
              <Tag color={status === 'Consented' ? 'green' : status === 'OptedOut' ? 'red' : 'default'}>
                {t(`marketing.consentStatus.${status}`)}
              </Tag>
            ),
          },
        ]}
      />

      <Space wrap style={{ marginTop: 16 }}>
        <Button danger type="primary" loading={busy} onClick={() => void act(false)}>
          {t('web.marketing.preferences.unsubscribe')}
        </Button>
        <Button loading={busy} onClick={() => void act(true)}>
          {t('web.marketing.preferences.unsubscribeAll')}
        </Button>
      </Space>

      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        {t('web.marketing.preferences.expires', {
          date: view.expiresAt === null ? '—' : formatDateTime(view.expiresAt),
        })}
      </Typography.Paragraph>
    </Card>
  );
}
