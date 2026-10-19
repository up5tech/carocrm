import { Alert, Card, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';

import { t } from '../../state/i18n.js';
import { useDocumentForm } from '../document-form.js';
import { usePublishTabActions } from '../shell.js';

interface SecurityDocument {
  password: { minLength: number; requireUppercase: boolean; requireNumber: boolean; requireSymbol: boolean };
  session: { idleLogoutMinutes: number; singleSession: boolean };
  loginNotice: string | null;
}

/**
 * Authentication tab (PLAN_Phase_20_Settings_UX.md §4.3 row 14): the `security` document — password
 * policy, session policy and the sign-in notice. It edits policy only; it never grants or bypasses
 * access, and the server re-checks the administrator level on every write.
 */
export function AuthenticationTab() {
  const document = useDocumentForm<SecurityDocument>('security');
  const value = document.value;

  usePublishTabActions({
    dirty: document.dirty,
    saving: document.saving,
    canSave: !document.loading,
    modifiedAt: document.modifiedAt,
    modifiedBy: document.modifiedBy,
    onSave: () => void document.save(),
    onDiscard: document.discard,
    onReload: () => void document.reload(),
  });

  const editPassword = (patch: Partial<SecurityDocument['password']>) => {
    if (!value) return;
    document.edit({ password: { ...value.password, ...patch } });
  };
  const editSession = (patch: Partial<SecurityDocument['session']>) => {
    if (!value) return;
    document.edit({ session: { ...value.session, ...patch } });
  };

  return (
    <div className="carocrm-admin-form">
      {document.failed !== null ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={document.failed} description={document.conflict ? t('web.adminShell.conflictHint') : undefined} />
      ) : null}
      <Card className="carocrm-card" title={t('web.adminSecurity.passwordTitle')} extra={t('web.adminSecurity.passwordHint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <div className="carocrm-admin-form--two">
            <Form.Item label={t('web.adminSecurity.minLength')} extra={t('web.adminSecurity.minLengthHint')}>
              <InputNumber
                min={6}
                max={128}
                style={{ width: '100%' }}
                value={value?.password.minLength ?? 8}
                onChange={(next) => editPassword({ minLength: typeof next === 'number' ? next : 8 })}
              />
            </Form.Item>
            <Form.Item label={t('web.adminSecurity.complexity')}>
              <Space>
                <Switch size="small" checked={value?.password.requireUppercase ?? false} aria-label={t('web.adminSecurity.requireUppercase')} onChange={(next) => editPassword({ requireUppercase: next })} />
                <Typography.Text>{t('web.adminSecurity.requireUppercase')}</Typography.Text>
              </Space>
            </Form.Item>
            <Form.Item label=" ">
              <Space>
                <Switch size="small" checked={value?.password.requireNumber ?? false} aria-label={t('web.adminSecurity.requireNumber')} onChange={(next) => editPassword({ requireNumber: next })} />
                <Typography.Text>{t('web.adminSecurity.requireNumber')}</Typography.Text>
              </Space>
            </Form.Item>
            <Form.Item label=" ">
              <Space>
                <Switch size="small" checked={value?.password.requireSymbol ?? false} aria-label={t('web.adminSecurity.requireSymbol')} onChange={(next) => editPassword({ requireSymbol: next })} />
                <Typography.Text>{t('web.adminSecurity.requireSymbol')}</Typography.Text>
              </Space>
            </Form.Item>
          </div>
        </Form>
      </Card>
      <Card className="carocrm-card" title={t('web.adminSecurity.sessionTitle')}>
        <Form layout="vertical" disabled={value === undefined}>
          <div className="carocrm-admin-form--two">
            <Form.Item label={t('web.adminSecurity.idleLogout')} extra={t('web.adminSecurity.idleLogoutHint')}>
              <InputNumber
                min={0}
                max={10080}
                style={{ width: '100%' }}
                value={value?.session.idleLogoutMinutes ?? 0}
                onChange={(next) => editSession({ idleLogoutMinutes: typeof next === 'number' ? next : 0 })}
              />
            </Form.Item>
            <Form.Item label={t('web.adminSecurity.singleSession')} extra={t('web.adminSecurity.singleSessionHint')}>
              <Switch checked={value?.session.singleSession ?? false} onChange={(next) => editSession({ singleSession: next })} />
            </Form.Item>
          </div>
        </Form>
      </Card>
      <Card className="carocrm-card" title={t('web.adminSecurity.noticeTitle')} extra={t('web.adminSecurity.noticeHint')}>
        <Form layout="vertical" disabled={value === undefined}>
          <Form.Item label={t('web.adminSecurity.noticeLabel')}>
            <Input.TextArea
              rows={3}
              maxLength={500}
              value={value?.loginNotice ?? ''}
              placeholder={t('web.adminSecurity.noticePlaceholder')}
              onChange={(event) => document.edit({ loginNotice: event.target.value.trim() === '' ? null : event.target.value })}
            />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('web.adminShell.documentName', { name: 'security' })} · {t('web.adminShell.versionLabel')} {document.version}
          </Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
