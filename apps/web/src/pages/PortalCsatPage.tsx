/**
 * Phase 19-SD.14 — the customer's CSAT response page (PLAN §5.8, §9.6).
 *
 * The page receives only the opaque survey token; it never names or loads the case, so a leaked
 * link cannot be used to browse CRM data. The server verifies the hash, expiry and single-use flag.
 */

import { App as AntApp, Button, Card, Form, Input, Rate, Result, Typography } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import { t } from '../state/i18n.js';

interface CsatForm {
  rating: number;
  feedback?: string;
}

export function PortalCsatPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { message } = AntApp.useApp();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  if (token === '') {
    return <Result status="warning" title={t('web.portalCsat.missingToken')} />;
  }
  if (submitted) {
    return <Result status="success" title={t('web.portalCsat.thanks')} />;
  }

  const submit = async (values: CsatForm): Promise<void> => {
    setSaving(true);
    try {
      await api.serviceDeskCsatSubmit({
        token,
        rating: values.rating,
        ...(values.feedback?.trim() ? { feedback: values.feedback.trim() } : {}),
      });
      setSubmitted(true);
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.portalCsat.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="carocrm-card" title={t('web.portalCsat.title')} style={{ maxWidth: 520, margin: '0 auto' }}>
      <Typography.Paragraph type="secondary">{t('web.portalCsat.intro')}</Typography.Paragraph>
      <Form<CsatForm> layout="vertical" onFinish={(values) => void submit(values)}>
        <Form.Item name="rating" label={t('web.portalCsat.rating')} rules={[{ required: true, message: t('web.portalCsat.ratingRequired') }]}>
          <Rate />
        </Form.Item>
        <Form.Item name="feedback" label={t('web.portalCsat.feedback')}>
          <Input.TextArea rows={4} maxLength={4000} showCount />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>
          {t('web.portalCsat.submit')}
        </Button>
      </Form>
    </Card>
  );
}
