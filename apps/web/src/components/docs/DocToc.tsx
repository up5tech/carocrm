import { useEffect, useState } from 'react';

import type { DocTocEntry } from '../../api/types.js';

/**
 * The sticky "On this page" rail.
 *
 * The active entry follows the reader through an `IntersectionObserver` rather than a scroll listener: a
 * scroll handler runs on every frame and still guesses, while the observer reports the heading that is
 * actually in view. `aria-current` is what a screen reader announces as "you are here" (§5.9).
 */
export function DocToc({
  entries,
  onSelect,
  label,
}: {
  readonly entries: readonly DocTocEntry[];
  readonly onSelect: (id: string) => void;
  readonly label: string;
}) {
  const [active, setActive] = useState<string | undefined>(entries[0]?.id);

  useEffect(() => {
    if (entries.length === 0) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) visible.set(record.target.id, record.intersectionRatio);
          else visible.delete(record.target.id);
        }
        // The topmost heading in view wins, so a reader jumping between sections sees one entry marked.
        const next = entries.find((entry) => visible.has(entry.id));
        if (next !== undefined) setActive(next.id);
      },
      { rootMargin: '-8% 0px -70% 0px', threshold: [0, 1] },
    );

    for (const entry of entries) {
      const node = document.getElementById(entry.id);
      if (node !== null) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <nav className="carocrm-doc-toc" aria-label={label}>
      <span className="carocrm-doc-toc-title">{label}</span>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? 'carocrm-doc-toc-item--sub' : undefined}>
            <a
              href={`#${entry.id}`}
              aria-current={active === entry.id ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onSelect(entry.id);
              }}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
