/**
 * Card-shaped loading placeholders (PLAN_Phase_20_Settings_UX.md §5.7, §20.19).
 *
 * The home cards load independently, so a skeleton is never a full-page spinner: each card draws the
 * rows it is about to fill, which keeps the layout from jumping when the data arrives. The shimmer is
 * disabled under `prefers-reduced-motion` in `carocrm.css`.
 */
export function HomeSkeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="carocrm-home-skeleton carocrm-home-skeleton--row" aria-hidden="true" />
      ))}
    </>
  );
}
