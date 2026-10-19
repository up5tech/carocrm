import { LockOutlined } from '@ant-design/icons';
import { Card, Typography } from 'antd';

import { t } from '../state/i18n.js';

/**
 * A reusable permission-denied card (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: replace the ad-hoc `<Alert type="error">` or blank pages that currently appear when a user
 * reaches a URL they are not authorised to see. The message is intentionally generic — it never leaks
 * whether the resource exists.
 */
export function PermissionDenied({ hint }: { hint?: string | undefined }) {
  return (
    <Card className="carocrm-card">
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <LockOutlined style={{ fontSize: 48, color: '#bfc6d3', marginBottom: 16 }} />
        <Typography.Title level={4}>{t('core.common.accessDenied')}</Typography.Title>
        <Typography.Text type="secondary">{hint ?? t('core.common.accessDeniedHint')}</Typography.Text>
      </div>
    </Card>
  );
}
