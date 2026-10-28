import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { LoadingSkeleton } from './LoadingSkeleton.js';
import { PermissionDenied } from './PermissionDenied.js';

/**
 * §14 task 3: loading, empty, denied and failed must be *distinguishable states*, including to a user
 * who cannot see them. Rendered to static markup, so this runs in the node test project with no DOM —
 * the same pattern `EmptyState.test.tsx` uses.
 *
 * The node project loads no i18n catalog, so `t()` answers with the key. That makes the *wording*
 * untestable here (and the wording belongs to `i18n.test.ts` and the Playwright accessibility spec);
 * what is testable, and what this asserts, is the structure a reader depends on: the role, the live
 * region, and the presence of the action.
 */
describe('the shared page states (§14 task 3)', () => {
  it('announces that content is loading, and that it is still arriving', () => {
    const html = renderToStaticMarkup(<LoadingSkeleton rows={3} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // The label is there for the reader and hidden from the eye; a bare skeleton has no text at all.
    expect(html).toContain('carocrm-visually-hidden');
  });

  it('announces a failure as an alert and offers the retry in the same breath', () => {
    const html = renderToStaticMarkup(<ErrorState message="The list could not be read" onRetry={() => undefined} />);
    // antd's Alert supplies `role="alert"`; the requirement is that the text and the action are in one
    // announced block, so a retry that fails again is heard as a change, not as a silent no-op.
    expect(html).toContain('role="alert"');
    expect(html).toContain('The list could not be read');
    expect(html).toContain('<button');
  });

  it('distinguishes "you may not see this" from "there is nothing here"', () => {
    const denied = renderToStaticMarkup(<PermissionDenied />);
    const empty = renderToStaticMarkup(<EmptyState variant="no-records" />);
    expect(denied).toContain('access');
    expect(empty).not.toContain(denied);
    expect(denied).not.toContain('Retry');
  });

  it('keeps a filtered empty list a different state from an empty one', () => {
    const filtered = renderToStaticMarkup(<EmptyState variant="filtered" />);
    const nothing = renderToStaticMarkup(<EmptyState variant="no-records" />);
    expect(filtered).not.toBe(nothing);
  });
});
