import { Alert, Button, Divider, Form, Input } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '../api/client.js';
import type { OidcProvider } from '../api/types.js';
import { t } from '../state/i18n.js';
import { useSession } from '../state/session.js';
import { DEFAULT_BRAND, useSettings } from '../state/settings.js';
import { oidcStartUrl, readOidcCallbackParams, stripOidcCallbackParams } from './login-oidc.js';

/**
 * The sign-in screen.
 *
 * Phase 23.3 (PLAN §17.3) added the external-identity part: the screen offers every configured
 * OpenID Connect provider, and the browser leaves for the provider and comes back with the same
 * session cookies the password sign-in issues. Two query parameters the platform's own callback
 * sets are honoured here:
 *
 *  - `?oidc_error=…` — the external sign-in was refused. The reason is a **stable code**, never the
 *    provider's own text, so nothing the provider said about the person reaches the browser.
 *  - `?oidc_challenge=…` — the external identity is known, but the account still has a second
 *    factor. The challenge is the platform's own, so the same code form finishes it.
 */
export function LoginPage() {
  const { signIn, completeChallenge, adoptChallenge, clearChallenge, loading, error, pendingChallenge } = useSession();
  const settings = useSettings();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form] = Form.useForm<{ userName: string; password: string }>();
  const [challengeForm] = Form.useForm<{ code: string }>();
  const [submitting, setSubmitting] = useState(false);
  const [providers, setProviders] = useState<readonly OidcProvider[]>([]);
  const [externalError, setExternalError] = useState<string | null>(null);

  // The providers are configuration, so the list is asked for once per screen — and a failure is
  // not fatal: an installation without a provider simply shows the password form alone.
  useEffect(() => {
    let cancelled = false;
    void api.oidcProviders().then((result) => {
      if (!cancelled) setProviders(result.list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The two parameters the platform's own callback sets are read once and then removed from the
   * address bar.
   *
   *  - `?oidc_challenge=…` is a **single-use credential**. It travels in the redirect, is handed to
   *    the session store — the same store the password sign-in uses, so there is one challenge
   *    surface — and is then dropped, so it cannot survive a reload or leak through the browser's
   *    history or a shared link.
   *  - `?oidc_error=…` is a stable code, never the provider's own text. It is shown once and then
   *    dropped, so a reload does not keep showing a failure that is over.
   */
  useEffect(() => {
    const { challenge, error: failure } = readOidcCallbackParams(params);
    if (challenge === null && failure === null) return;

    if (challenge !== null) adoptChallenge(challenge);
    if (failure !== null) setExternalError(failure);

    navigate({ pathname: '/login', search: stripOidcCallbackParams(params) }, { replace: true });
  }, [params, adoptChallenge, navigate]);

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
        {externalError !== null ? (
          <Alert type="error" showIcon message={t('web.login.externalFailed')} style={{ marginBottom: 16 }} />
        ) : null}
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
          <Button type="link" block onClick={() => navigate('/password-reset')} style={{ marginTop: 8 }}>
            {t('web.passwordReset.forgotLink')}
          </Button>
        </Form>
        {providers.length > 0 ? (
          <>
            <Divider plain style={{ margin: '20px 0 12px' }}>
              {t('web.login.externalDivider')}
            </Divider>
            <div style={{ display: 'grid', gap: 8 }}>
              {providers.map((provider) => (
                <Button
                  key={provider.key}
                  size="large"
                  block
                  onClick={() => {
                    // A full navigation, not a fetch: the provider answers with a redirect.
                    window.location.assign(oidcStartUrl(provider.key));
                  }}
                >
                  {t('web.login.externalAction', { provider: provider.displayName })}
                </Button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
