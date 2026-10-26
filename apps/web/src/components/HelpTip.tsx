import { InfoCircleOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';

import { t } from '../state/i18n.js';
import { DocsLink } from './docs/DocsLink.js';

/**
 * A reusable help-tip (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: place next to a label or form field where the reader might need context that would clutter the
 * main text. The icon is always the same so users learn its meaning once and recognise it everywhere.
 *
 * `docKey` turns the tip into a door: the tooltip keeps its one-line explanation and adds "Learn more",
 * which is what Phase 21 §5.6 asked for and what finally makes this component land on a real screen.
 */
export function HelpTip({ children, docKey }: { children: React.ReactNode; docKey?: string }) {
  return (
    <Tooltip
      title={
        <>
          {children}
          {docKey === undefined ? null : <div className="carocrm-helptip-more"><DocsLink docKey={docKey} label={t('web.docs.learnMore')} /></div>}
        </>
      }
    >
      <InfoCircleOutlined style={{ color: '#8c96a5', marginLeft: 4, cursor: 'help' }} aria-label={t('core.help')} />
    </Tooltip>
  );
}
