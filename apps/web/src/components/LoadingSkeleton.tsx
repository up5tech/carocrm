import { Card, Skeleton } from 'antd';

/**
 * A reusable loading skeleton (PLAN_Phase_20_Settings_UX.md §20.11).
 *
 * Usage: replace ad-hoc `<Card loading>` or raw `<Skeleton>` calls with this so the height and
 * paragraph count are consistent across list, detail and settings pages. The `rows` prop lets a page
 * hint at how much content is expected without hard-coding it in every call site.
 */
export function LoadingSkeleton({ rows = 6 }: { rows?: number | undefined }) {
  return (
    <Card className="carocrm-card">
      <Skeleton active title={{ width: '40%' }} paragraph={{ rows }} />
    </Card>
  );
}
