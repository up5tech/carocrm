import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import { t } from '../state/i18n.js';
import { DEFAULT_BRAND, useSettings } from '../state/settings.js';

/**
 * Phase 23.2 (PLAN §8 task 2): the self-service reset surface. Step one asks for the account
 * identifier and always answers the same way (no enumeration); step two consumes the single-use
 * token from the email. A `?token=` link lands directly on step two.
 */
export function PasswordResetPage() {
  const settings = useSettings();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [requestForm] = Form.useForm<{ identifier: string }>();
  const [confirmForm] = Form.useForm<{ token: string; newPassword: string }>();
  const [requested, setRequested] = useState(params.get('token') !== null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const messageOf = (cause: unknown): string =>
    cause instanceof ApiError ? cause.message : t('web.passwordReset.failed');

  return (
    <div className="carocrm-auth">
      <div className="carocrm-auth-card">
        {brand}
        <p className="carocrm-auth-sub">{t('web.passwordReset.title')}</p>
        {done ? (
          <>
            <Alert type="success" showIcon message={t('web.passwordReset.success')} style={{ marginBottom: 16 }} />
            <Button type="primary" size="large" block onClick={() => navigate('/login', { replace: true })}>
              {t('web.passwordReset.backToLogin')}
            </Button>
          </>
        ) : !requested ? (
          <Form
            form={requestForm}
            layout="vertical"
            onFinish={async (values) => {
              setBusy(true);
              setError(null);
              try {
                await api.requestPasswordReset(values.identifier);
                setRequested(true);
              } catch (cause) {
                setError(messageOf(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="carocrm-auth-sub">{t('web.passwordReset.requestSubtitle')}</p>
            <Form.Item name="identifier" label={t('web.passwordReset.identifier')} rules={[{ required: true }]}>
              <Input autoFocus autoComplete="username" size="large" />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={busy}>
              {t('web.passwordReset.sendToken')}
            </Button>
            <Button type="link" block onClick={() => navigate('/login')} style={{ marginTop: 8 }}>
              {t('web.passwordReset.backToLogin')}
            </Button>
          </Form>
        ) : (
          <Form
            form={confirmForm}
            layout="vertical"
            initialValues={{ token: params.get('token') ?? '' }}
            onFinish={async (values) => {
              setBusy(true);
              setError(null);
              try {
                await api.confirmPasswordReset(values.token, values.newPassword);
                setDone(true);
              } catch (cause) {
                setError(messageOf(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Alert type="info" showIcon message={t('web.passwordReset.requested')} style={{ marginBottom: 16 }} />
            <Form.Item name="token" label={t('web.passwordReset.token')} rules={[{ required: true }]}>
              <Input autoFocus autoComplete="off" size="large" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label={t('web.passwordReset.newPassword')}
              rules={[{ required: true }, { min: 8, message: t('web.passwordReset.minPassword') }]}
            >
              <Input.Password autoComplete="new-password" size="large" />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={busy}>
              {t('web.passwordReset.confirm')}
            </Button>
            <Button type="link" block onClick={() => navigate('/login')} style={{ marginTop: 8 }}>
              {t('web.passwordReset.backToLogin')}
            </Button>
          </Form>
        )}
      </div>
    </div>
  );
}