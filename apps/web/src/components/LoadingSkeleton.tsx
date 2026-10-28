import { Card, Skeleton } from 'antd';

import { t } from '../state/i18n.js';

/**
 * A reusable loading skeleton (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: replace ad-hoc `<Card loading>` or raw `<Skeleton>` calls with this so the height and
 * paragraph count are consistent across list, detail and settings pages. The `rows` prop lets a page
 * hint at how much content is expected without hard-coding it in every call site.
 *
 * The wrapper is the accessible half of the component (PLAN_Phase_22 §14 task 3): antd's `Skeleton`
 * paints bars and carries no role and no live region, so a user who cannot see the page has no signal
 * that content is arriving or that it finally failed to arrive. `role="status"` with a polite live
 * region says so once, in the reader's own language, and does not interrupt anything else.
 */
export function LoadingSkeleton({ rows = 6 }: { rows?: number | undefined }) {
  return (
    <Card className="carocrm-card">
      <div role="status" aria-live="polite">
        <span className="carocrm-visually-hidden">{t('core.loading')}</span>
        <Skeleton active title={{ width: '40%' }} paragraph={{ rows }} />
      </div>
    </Card>
  );
}
