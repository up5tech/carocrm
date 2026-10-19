import { InboxOutlined } from '@ant-design/icons';
import { Empty, Typography } from 'antd';

import { t } from '../state/i18n.js';

/**
 * A reusable empty-state card (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: wrap any page's "nothing here yet" message so the tone and spacing are consistent. The icon
 * is optional; when omitted the generic inbox mark keeps the visual weight of a real illustration
 * without pulling in an image asset.
 */
export function EmptyState({ title, description, icon }: { title?: string | undefined; description?: string | undefined; icon?: React.ReactNode }) {
  return (
    <Empty
      image={icon ?? <InboxOutlined style={{ fontSize: 48, color: '#bfc6d3' }} />}
      description={
        description !== undefined ? (
          <Typography.Text type="secondary">{description}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{t('core.common.empty')}</Typography.Text>
        )
      }
    >
      {title !== undefined ? <Typography.Text strong>{title}</Typography.Text> : null}
    </Empty>
  );
}
