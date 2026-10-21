import { Alert } from 'antd';

import type { DocBlock } from '../../api/types.js';

/**
 * A handbook callout, styled with the design system's semantics rather than a palette of its own (§9.3):
 * `note`/`tip`/`warning`/`danger` map onto antd's info/success/warning/error, which already carry the
 * right colours, icon and contrast for the theme.
 */
const VARIANTS = {
  note: 'info',
  tip: 'success',
  warning: 'warning',
  danger: 'error',
} as const;

export function DocCallout({ variant, children }: { readonly variant: keyof typeof VARIANTS; readonly children: React.ReactNode }) {
  return (
    <Alert className="carocrm-doc-callout" type={VARIANTS[variant]} showIcon message={children} />
  );
}

/** The variant narrowing the block model guarantees; kept here so a new callout type fails the build. */
export type DocCalloutBlock = Extract<DocBlock, { type: 'callout' }>;
