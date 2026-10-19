import { Alert, Button, Typography } from 'antd';

import { t } from '../state/i18n.js';

/**
 * A reusable error-state card (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: wrap any page's fetch failure so the retry action is always present and labelled the same way.
 * The `onRetry` callback is optional — when omitted the card shows the message without a button, which
 * is correct for errors that cannot be retried (e.g. permission denied).
 */
export function ErrorState({ message, onRetry }: { message?: string | undefined; onRetry?: (() => void) | undefined }) {
  return (
    <Alert
      type="error"
      showIcon
      message={message ?? t('core.common.error')}
      description={
        onRetry !== undefined ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text>{t('core.common.retryHint')}</Typography.Text>
            <Button size="small" onClick={onRetry}>
              {t('core.common.retry')}
            </Button>
          </div>
        ) : undefined
      }
      className="carocrm-error-state"
    />
  );
}
