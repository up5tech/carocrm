import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Avatar, Button, Card, Col, Form, Input, Row, Select, Space, Typography, Upload } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api/client.js';
import { timezoneOptions } from '../components/timezones.js';
import { activeLocaleName, localesEnabled, t } from '../state/i18n.js';
import { useSession } from '../state/session.js';

interface ProfileForm {
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  phoneNumber?: string;
  title?: string;
}

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** The signed-in user's own page: profile details, avatar, language/timezone and password. */
export function MyProfilePage() {
  const { message } = AntApp.useApp();
  const { principal, loadPrincipal, signOut } = useSession();
  const navigate = useNavigate();
  const [profileForm] = Form.useForm<ProfileForm>();
  const [preferenceForm] = Form.useForm<{ locale: string | null; timezone: string | null }>();
  const [passwordForm] = Form.useForm<PasswordForm>();
  const [uploading, setUploading] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const locale = activeLocaleName();

  const zones = useMemo(() => timezoneOptions(), []);

  const localeOptions = useMemo(
    () => localesEnabled().map((value) => ({ value, label: t(`web.language.${value}`) })),
    // The option labels are translated, so the list has to follow the active language.
    [locale],
  );

  const saveProfile = async (values: ProfileForm): Promise<void> => {
    try {
      await api.patchMyProfile({
        firstName: values.firstName?.trim() || null,
        lastName: values.lastName?.trim() || null,
        emailAddress: values.emailAddress?.trim() || null,
        phoneNumber: values.phoneNumber?.trim() || null,
        title: values.title?.trim() || null,
      });
      await loadPrincipal();
      void message.success(t('web.profile.saved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.saveFailed'));
    }
  };

  const savePreferences = async (values: { locale: string | null; timezone: string | null }): Promise<void> => {
    try {
      await api.patchMyProfile({ locale: values.locale, timezone: values.timezone });
      await loadPrincipal();
      void message.success(t('web.profile.saved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.saveFailed'));
    }
  };

  const uploadAvatar = useCallback(
    async (file: File): Promise<boolean> => {
      if (!file.type.startsWith('image/')) {
        void message.error(t('web.profile.avatarNotImage'));
        return false;
      }
      setUploading(true);
      try {
        const stored = await api.uploadAttachment(file, { field: 'avatar', role: 'avatar' });
        await api.patchMyProfile({ avatarId: stored.id });
        await loadPrincipal();
        void message.success(t('web.profile.avatarUploaded'));
      } catch (error) {
        void message.error(error instanceof Error ? error.message : t('web.profile.avatarUploadFailed'));
      } finally {
        setUploading(false);
      }
      return false;
    },
    [loadPrincipal, message],
  );

  const removeAvatar = async (): Promise<void> => {
    try {
      await api.patchMyProfile({ avatarId: null });
      await loadPrincipal();
      void message.success(t('web.profile.avatarRemoved'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.saveFailed'));
    }
  };

  const changePassword = async (values: PasswordForm): Promise<void> => {
    try {
      await api.changeMyPassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      void message.success(t('web.profile.passwordChanged'));
      // Changing the password revokes every session server-side, so sign out and sign in again.
      await signOut();
      navigate('/login', { replace: true });
    } catch (error) {
      // 401 here can only mean the current password was wrong — the session is already authenticated.
      if (error instanceof ApiError && error.status === 401) {
        void message.error(t('web.profile.passwordWrongCurrent'));
      } else {
        void message.error(error instanceof Error ? error.message : t('web.profile.passwordChangeFailed'));
      }
    }
  };

  const beginTotpSetup = async (): Promise<void> => {
    setTotpBusy(true);
    try {
      const setup = await api.beginTotpSetup();
      setTotpSetup(setup);
      setRecoveryCodes(null);
      setTotpCode('');
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.totpSetupFailed'));
    } finally {
      setTotpBusy(false);
    }
  };

  const enableTotp = async (): Promise<void> => {
    if (totpCode.trim() === '') return;
    setTotpBusy(true);
    try {
      const result = await api.enableTotp(totpCode.trim());
      setRecoveryCodes(result.recoveryCodes);
      setTotpSetup(null);
      setTotpCode('');
      await loadPrincipal();
      void message.success(t('web.profile.twoFactorEnabled'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.totpEnableFailed'));
    } finally {
      setTotpBusy(false);
    }
  };

  const disableTotp = async (): Promise<void> => {
    if (totpCode.trim() === '') return;
    setTotpBusy(true);
    try {
      await api.disableTotp(totpCode.trim());
      setTotpSetup(null);
      setRecoveryCodes(null);
      setTotpCode('');
      await loadPrincipal();
      void message.success(t('web.profile.twoFactorDisabled'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.totpDisableFailed'));
    } finally {
      setTotpBusy(false);
    }
  };

  const regenerateRecovery = async (): Promise<void> => {
    if (totpCode.trim() === '') return;
    setTotpBusy(true);
    try {
      const result = await api.regenerateRecoveryCodes(totpCode.trim());
      setRecoveryCodes(result.recoveryCodes);
      setTotpCode('');
      void message.success(t('web.profile.recoveryRegenerated'));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : t('web.profile.totpDisableFailed'));
    } finally {
      setTotpBusy(false);
    }
  };

  if (!principal) return null;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="carocrm-page-head">
        <div>
          <h1 className="carocrm-page-title">{t('web.profile.title')}</h1>
          <p className="carocrm-page-sub">{t('web.profile.subtitle')}</p>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card className="carocrm-card" title={t('web.profile.infoTitle')}>
            <Form
              form={profileForm}
              layout="vertical"
              initialValues={{
                firstName: principal.firstName ?? '',
                lastName: principal.lastName ?? '',
                emailAddress: principal.emailAddress ?? '',
                phoneNumber: principal.phoneNumber ?? '',
                title: principal.title ?? '',
              }}
              onFinish={(values: ProfileForm) => void saveProfile(values)}
            >
              <Row gutter={[12, 0]}>
                <Col xs={24} sm={12}>
                  <Form.Item name="firstName" label={t('web.profile.firstName')}>
                    <Input autoComplete="given-name" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item name="lastName" label={t('web.profile.lastName')}>
                    <Input autoComplete="family-name" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item name="emailAddress" label={t('web.profile.emailAddress')} rules={[{ type: 'email', message: t('web.profile.emailInvalid') }]}>
                    <Input autoComplete="email" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item name="phoneNumber" label={t('web.profile.phoneNumber')}>
                    <Input autoComplete="tel" />
                  </Form.Item>
                </Col>
                <Col xs={24}>
                  <Form.Item name="title" label={t('web.profile.jobTitle')}>
                    <Input />
                  </Form.Item>
                </Col>
              </Row>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('web.profile.userNameHint', { name: principal.userName })}
              </Typography.Text>
              <div style={{ marginTop: 12 }}>
                <Button type="primary" htmlType="submit">
                  {t('web.common.save')}
                </Button>
              </div>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card className="carocrm-card" title={t('web.profile.avatarTitle')}>
            <Space align="center" size={16} wrap>
              <Avatar size={72} className="carocrm-avatar--large">
                {principal.avatarId ? (
                  <img src={`/api/v1/Attachment/${principal.avatarId}/file`} alt={principal.name} />
                ) : (
                  principal.userName.slice(0, 2).toUpperCase()
                )}
              </Avatar>
              <Space direction="vertical" size={4}>
                <Upload accept="image/*" showUploadList={false} beforeUpload={(file) => void uploadAvatar(file as unknown as File)}>
                  <Button icon={<UploadOutlined />} loading={uploading}>
                    {t('web.profile.avatarUpload')}
                  </Button>
                </Upload>
                {principal.avatarId ? (
                  <Button type="text" icon={<DeleteOutlined />} onClick={() => void removeAvatar()}>
                    {t('web.profile.avatarRemove')}
                  </Button>
                ) : null}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.profile.avatarHint')}
                </Typography.Text>
              </Space>
            </Space>
          </Card>

          <Card className="carocrm-card" title={t('web.profile.preferencesTitle')} style={{ marginTop: 16 }}>
            <Form
              form={preferenceForm}
              layout="vertical"
              initialValues={{ locale: principal.locale, timezone: principal.timezone }}
              onFinish={(values: { locale: string | null; timezone: string | null }) => void savePreferences(values)}
            >
              <Form.Item name="locale" label={t('web.language.label')}>
                <Select allowClear placeholder={t('web.profile.instanceDefault')} options={localeOptions} />
              </Form.Item>
              <Form.Item name="timezone" label={t('web.profile.timezone')}>
                <Select allowClear showSearch placeholder={t('web.profile.instanceDefault')} options={zones} />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                {t('web.common.save')}
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>

      <Card className="carocrm-card" title={t('web.profile.passwordTitle')}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {t('web.profile.passwordHint')}
        </Typography.Paragraph>
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={(values: PasswordForm) => void changePassword(values)}
        >
          <Row gutter={[12, 0]}>
            <Col xs={24} sm={8}>
              <Form.Item name="currentPassword" label={t('web.profile.passwordCurrent')} rules={[{ required: true, message: t('web.profile.passwordRequired') }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item
                name="newPassword"
                label={t('web.profile.passwordNew')}
                rules={[{ required: true, message: t('web.profile.passwordRequired') }, { min: 8, message: t('web.profile.passwordTooShort') }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8}>
              <Form.Item
                name="confirmPassword"
                label={t('web.profile.passwordConfirm')}
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: t('web.profile.passwordRequired') },
                  ({ getFieldValue }) => ({
                    validator: (_rule, value: string | undefined) =>
                      value !== undefined && value === getFieldValue('newPassword')
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('web.profile.passwordMismatch'))),
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
          </Row>
          <Button type="primary" htmlType="submit">
            {t('web.profile.passwordChange')}
          </Button>
        </Form>
      </Card>

      <Card className="carocrm-card" title={t('web.profile.twoFactorTitle')} style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          {principal.twoFactorEnabled ? t('web.profile.twoFactorEnabledHint') : t('web.profile.twoFactorDisabledHint')}
        </Typography.Paragraph>
        {principal.twoFactorEnabled ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Input.Password
              placeholder={t('web.profile.twoFactorCodePlaceholder')}
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              autoComplete="one-time-code"
            />
            <Space wrap>
              <Button danger onClick={() => void disableTotp()} loading={totpBusy}>
                {t('web.profile.twoFactorDisable')}
              </Button>
              <Button onClick={() => void regenerateRecovery()} loading={totpBusy}>
                {t('web.profile.twoFactorRegenerate')}
              </Button>
            </Space>
            {recoveryCodes !== null ? (
              <div>
                <Typography.Text strong>{t('web.profile.recoveryCodesTitle')}</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
                  {t('web.profile.recoveryCodesHint')}
                </Typography.Paragraph>
                <pre className="carocrm-kpi-context" style={{ whiteSpace: 'pre-wrap' }}>{recoveryCodes.join('\n')}</pre>
              </div>
            ) : null}
          </Space>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {totpSetup === null ? (
              <Button type="primary" onClick={() => void beginTotpSetup()} loading={totpBusy}>
                {t('web.profile.twoFactorBegin')}
              </Button>
            ) : (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('web.profile.twoFactorSecretLabel')}: <code>{totpSetup.secret}</code>
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {totpSetup.otpauthUri}
                </Typography.Text>
                <Input
                  placeholder={t('web.profile.twoFactorCodePlaceholder')}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  autoComplete="one-time-code"
                />
                <Button type="primary" onClick={() => void enableTotp()} loading={totpBusy}>
                  {t('web.profile.twoFactorEnable')}
                </Button>
              </>
            )}
            {recoveryCodes !== null ? (
              <div>
                <Typography.Text strong>{t('web.profile.recoveryCodesTitle')}</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
                  {t('web.profile.recoveryCodesHint')}
                </Typography.Paragraph>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{recoveryCodes.join('\n')}</pre>
              </div>
            ) : null}
          </Space>
        )}
      </Card>
    </Space>
  );
}
