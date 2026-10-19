import { InfoCircleOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';

import { t } from '../state/i18n.js';

/**
 * A reusable help-tip (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: place next to a label or form field where the reader might need context that would clutter the
 * main text. The icon is always the same so users learn its meaning once and recognise it everywhere.
 */
export function HelpTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip title={children}>
      <InfoCircleOutlined style={{ color: '#8c96a5', marginLeft: 4, cursor: 'help' }} aria-label={t('core.common.help')} />
    </Tooltip>
  );
}
