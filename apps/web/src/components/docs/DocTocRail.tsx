import { useEffect, useState } from 'react';

import type { DocTocEntry } from '../../api/types.js';
import { DocToc } from './DocToc.js';

/**
 * The right rail's contents block, at the width the reader actually has (§5.10).
 *
 * 1180 px and above: the sticky list beside the prose. 900–1179: gone — the prose is already narrow and a
 * second column of links competes with it for nothing. Below 900: behind a "Contents" disclosure, because
 * the list is still useful when you can see it but is noise when it eats half the screen.
 *
 * `matchMedia` rather than a resize listener, so the breakpoint and the stylesheet cannot disagree: the CSS
 * hides the rail in the middle band as a backstop.
 */
export function DocTocRail({
  entries,
  label,
  disclosureLabel,
  onSelect,
}: {
  readonly entries: readonly DocTocEntry[];
  readonly label: string;
  readonly disclosureLabel: string;
  readonly onSelect: (id: string) => void;
}) {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 899px)').matches);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 899px)');
    const onChange = (event: MediaQueryListEvent): void => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (entries.length === 0) return null;

  if (!narrow) return <DocToc entries={entries} label={label} onSelect={onSelect} />;

  return (
    <details className="carocrm-doc-toc-details">
      <summary>{disclosureLabel}</summary>
      <DocToc entries={entries} label={label} onSelect={onSelect} />
    </details>
  );
}
