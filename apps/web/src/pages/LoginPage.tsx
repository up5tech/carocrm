import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { t } from '../state/i18n.js';
import { useSession } from '../state/session.js';
import { DEFAULT_BRAND, useSettings } from '../state/settings.js';

export function LoginPage() {
  const { signIn, completeChallenge, clearChallenge, loading, error, pendingChallenge } = useSession();
  const settings = useSettings();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ userName: string; password: string }>();
  const [challengeForm] = Form.useForm<{ code: string }>();
  const [submitting, setSubmitting] = useState(false);

  const brand = (
    <div className="carocrm-auth-brand">
      {settings.data?.logoUrl ? (
        <img className="carocrm-brand-logo carocrm-brand-logo--auth" src={settings.data.logoUrl} alt="" />
      ) : (
        <span className="carocrm-brand-mark">C</span>
      )}
      <span>{settings.data?.pageTitle ?? DEFAULT_BRAND}</span>
    </div>
  );

  if (pendingChallenge !== null) {
    return (
      <div className="carocrm-auth">
        <div className="carocrm-auth-card">
          {brand}
          <p className="carocrm-auth-sub">{t('web.login.twoFactorSubtitle')}</p>
          <Form
            form={challengeForm}
            layout="vertical"
            onFinish={async (values) => {
              setSubmitting(true);
              const ok = await completeChallenge(values.code);
              setSubmitting(false);
              if (ok) navigate('/home', { replace: true });
            }}
          >
            <Form.Item name="code" label={t('web.login.twoFactorCode')} rules={[{ required: true }]}>
              <Input autoFocus autoComplete="one-time-code" size="large" />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={submitting || loading}>
              {t('web.login.submit')}
            </Button>
            <Button type="link" block onClick={() => clearChallenge()} style={{ marginTop: 8 }}>
              {t('web.login.backToPassword')}
            </Button>
          </Form>
        </div>
      </div>
    );
  }

  return (
    <div className="carocrm-auth">
      <div className="carocrm-auth-card">
        {brand}
        <p className="carocrm-auth-sub">{t('web.login.subtitle')}</p>
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            setSubmitting(true);
            const ok = await signIn(values.userName, values.password);
            setSubmitting(false);
            if (ok) navigate('/home', { replace: true });
          }}
        >
          <Form.Item name="userName" label={t('web.login.userName')} rules={[{ required: true }]}>
            <Input autoFocus autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item name="password" label={t('web.login.password')} rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
          <Button type="primary" htmlType="submit" size="large" block loading={submitting || loading}>
            {t('web.login.submit')}
          </Button>
        </Form>
      </div>
    </div>
  );
}