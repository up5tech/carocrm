import { FilterOutlined, InboxOutlined, LockOutlined, SearchOutlined } from '@ant-design/icons';
import { Empty, Typography } from 'antd';
import type { ReactNode } from 'react';

import { t } from '../state/i18n.js';

/**
 * The four situations that used to share one sentence (PLAN_Phase_20_Settings_UX.md §20.22).
 *
 * - `no-records` — the list is genuinely empty; the fix is to create something.
 * - `no-results` — a search found nothing; the fix is a different query.
 * - `filtered`   — records exist but the active filters hide them; the fix is to clear them.
 * - `denied`     — the caller may not read this; there is no fix, only an explanation.
 */
export type EmptyVariant = 'no-records' | 'no-results' | 'filtered' | 'denied';

interface VariantCopy {
  readonly title: string;
  readonly hint: string | undefined;
  readonly icon: ReactNode;
}

function variantCopy(variant: EmptyVariant): VariantCopy {
  switch (variant) {
    case 'no-results':
      return {
        title: t('core.emptyNoResults'),
        hint: t('core.emptyNoResultsHint'),
        icon: <SearchOutlined style={{ fontSize: 48, color: 'var(--carocrm-c-bfc6d3)' }} />,
      };
    case 'filtered':
      return {
        title: t('core.emptyFiltered'),
        hint: t('core.emptyFilteredHint'),
        icon: <FilterOutlined style={{ fontSize: 48, color: 'var(--carocrm-c-bfc6d3)' }} />,
      };
    case 'denied':
      return {
        title: t('core.accessDenied'),
        hint: t('core.accessDeniedHint'),
        icon: <LockOutlined style={{ fontSize: 48, color: 'var(--carocrm-c-bfc6d3)' }} />,
      };
    case 'no-records':
    default:
      return {
        title: t('core.empty'),
        hint: undefined,
        icon: <InboxOutlined style={{ fontSize: 48, color: 'var(--carocrm-c-bfc6d3)' }} />,
      };
  }
}

/**
 * A reusable empty state (PLAN_Phase_20_Settings_UX.md §20.11, revised in §20.22).
 *
 * The primary line is the **title**, the secondary line is the **hint**, and `action` is the one
 * thing that fixes the situation. Before §20.22 the title was passed as antd `Empty`'s child — the
 * action area — so the component that existed to standardise empty screens rendered its headline
 * underneath its own footnote.
 *
 * `variant` supplies the default copy and icon; any explicit prop wins, so an existing call site
 * keeps working unchanged.
 */
export function EmptyState({
  title,
  description,
  icon,
  variant,
  action,
  children,
  size = 'default',
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: EmptyVariant | undefined;
  /** The one control that fixes the situation. `children` is the same slot, for JSX call sites. */
  action?: ReactNode;
  children?: ReactNode;
  /**
   * `compact` keeps antd's small illustration, which is what a panel inside a record page used
   * before this component existed. `default` draws the 48px token icon.
   */
  size?: 'default' | 'compact' | undefined;
  className?: string | undefined;
}) {
  const copy = variantCopy(variant ?? 'no-records');
  const titleText = title ?? copy.title;
  const hintText = description ?? copy.hint;
  const image = icon ?? (size === 'compact' ? Empty.PRESENTED_IMAGE_SIMPLE : copy.icon);

  return (
    <Empty
      className={className === undefined ? 'carocrm-empty' : `carocrm-empty ${className}`}
      image={image}
      description={
        <div className="carocrm-empty-text">
          <p className="carocrm-empty-title">{titleText}</p>
          {hintText === undefined || hintText === '' ? null : (
            <Typography.Text type="secondary" className="carocrm-empty-hint">
              {hintText}
            </Typography.Text>
          )}
        </div>
      }
    >
      {action ?? children ?? null}
    </Empty>
  );
}
