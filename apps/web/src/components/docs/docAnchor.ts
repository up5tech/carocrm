/**
 * Anchor navigation for the handbook reader.
 *
 * A `#heading` link has to do three things the browser only does two of on its own: scroll the prose
 * column (not the window), move **focus** to the heading so a keyboard or screen-reader user lands where
 * the link promised, and keep the address shareable without spamming the history (§9.2 rule 3).
 */

const HEADING_SELECTOR = 'h2[id], h3[id], h4[id]';

export function goToHeading(id: string): boolean {
  const target = document.getElementById(id);
  if (target === null || !target.matches(HEADING_SELECTOR)) return false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  // Headings are not focusable by default; `-1` makes them focusable programmatically without adding
  // them to the tab order.
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  window.history.replaceState(null, '', `#${id}`);
  return true;
}

/**
 * After a page arrives — a fresh load, a deep link, or a page whose own hash is still in the address bar —
 * jump to the heading the reader asked for. Called once the blocks are in the DOM.
 */
export function followHashOnLoad(): void {
  const id = window.location.hash.replace('#', '');
  if (id !== '') goToHeading(id);
}
