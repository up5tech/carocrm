/**
 * The browser-tab title store (Phase 20.24, F6 from `docs/ux/ui-review.md`).
 *
 * Two writers contribute to one value: the instance brand (`GET /Settings`, the shell) and the
 * screen being read (`PageHeader`/`usePageTitle`). The tab reads `"<page> · <brand>"` so five open
 * records are five distinguishable tabs and a bookmark carries its page, not just the product.
 *
 * `document.title` is written only here, in repaint(), and only in a browser — effects do not run
 * under `react-dom/server`, so this module is SSR/test safe.
 */
import type i18n from 'i18next';

export const DEFAULT_BRAND = 'CaroCRM';

const SEP = ' · ';

type Translate = typeof i18n.t;

let brand = DEFAULT_BRAND;
let page: string | undefined;
/** Set once i18n exists; the separator itself is not translated, but the announcement string is. */
let t: Translate | undefined = undefined;

function repaint(): void {
  if (typeof document === 'undefined') return;
  document.title = page === undefined || page === '' ? brand : `${page}${SEP}${brand}`;
}

/** The instance brand changed (brand settings document saved, or the query resolved). */
export function setBrandTitle(nextBrand: string): void {
  brand = nextBrand === '' ? DEFAULT_BRAND : nextBrand;
  repaint();
}

/** The screen changed. `undefined` (a workspace without a `PageHeader`) falls back to the brand. */
export function setPageTitle(nextPage: string | undefined): void {
  page = nextPage === '' ? undefined : nextPage;
  repaint();
}

export function currentBrandTitle(): string {
  return brand;
}

export function currentDocumentTitle(): string {
  return document.title;
}

/** The shell wires its `t` once on mount so `announcePage()` can localise. */
export function setLiveRegionTranslator(translate: Translate): void {
  t = translate;
}

/** F7: announces the page the reader just landed on. Safe when no live region exists. */
export function announcePage(): void {
  if (typeof document === 'undefined') return;
  const live = document.getElementById('carocrm-live-region');
  if (live === null) return;
  live.textContent = t !== undefined ? `${t('core.app.arrivedAt')} ${document.title}` : document.title;
}
