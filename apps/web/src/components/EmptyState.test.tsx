import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyState, type EmptyVariant } from './EmptyState.js';

/**
 * §20.22: the four empty situations must read differently, and the title must be the primary line
 * (before the fix it sat in antd `Empty`'s action area, i.e. below the hint). Rendered to static
 * markup so the test needs no DOM.
 */
const VARIANTS: EmptyVariant[] = ['no-records', 'no-results', 'filtered', 'denied'];

describe('EmptyState (§20.22)', () => {
  it('renders the title as the primary line and the description as the hint', () => {
    const html = renderToStaticMarkup(
      <EmptyState variant="filtered" title="No matches" description="Clear the filter" />,
    );
    expect(html).toContain('carocrm-empty-title');
    expect(html).toContain('No matches');
    expect(html).toContain('Clear the filter');
  });

  it('gives the four variants distinct default copy', () => {
    const rendered = VARIANTS.map((variant) => renderToStaticMarkup(<EmptyState variant={variant} />));
    expect(new Set(rendered).size).toBe(VARIANTS.length);
  });

  it('renders the action slot when one is supplied', () => {
    const html = renderToStaticMarkup(
      <EmptyState variant="no-records" action={<button type="button">Create one</button>} />,
    );
    expect(html).toContain('Create one');
  });
});
