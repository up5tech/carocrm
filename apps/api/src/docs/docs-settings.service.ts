import { Inject, Injectable } from '@nestjs/common';

import { SettingsDocumentService } from '../admin-panel/settings-document.service.js';
import type { DocsSettings } from '../admin-panel/settings-shapes.js';
import { DEFAULT_DOCS_SETTINGS } from '../admin-panel/settings-shapes.js';

/**
 * The `docs` settings document (§6.1).
 *
 * The document is owned by the settings registry like every other platform document — this service only
 * adds the read path the docs surface needs: a 30-second in-process cache, because the navigation feature
 * gate asks "is the sidebar entry on?" while it resolves a menu for every user, and a page render asks the
 * same question again.
 *
 * It never writes the row itself. `save()` goes through `SettingsDocumentService`, so validation, the
 * envelope, optimistic concurrency, the audit row and the change listeners (which drop the navigation
 * cache) all behave exactly as they do for `navigation` and `security`.
 */
const CACHE_MS = 30_000;

@Injectable()
export class DocsSettingsService {
  private cache: { value: DocsSettings; loadedAt: number } | undefined;

  constructor(@Inject(SettingsDocumentService) private readonly documents: SettingsDocumentService) {
    // A write reaches this row through the generic `/Settings/documents/docs` route, not only through
    // `save()`, so the cache is dropped by the document's own change event. Otherwise an administrator
    // who hid the handbook would wait for the TTL to see the sidebar follow.
    this.documents.onChanged((name) => {
      if (name === 'docs') this.invalidate();
    });
  }

  /** Defaults answer when no row exists yet, so an installation that never touched the tab still works. */
  async settings(): Promise<DocsSettings> {
    if (this.cache !== undefined && Date.now() - this.cache.loadedAt < CACHE_MS) return this.cache.value;
    const stored = await this.documents.readInternal('docs');
    const value = (stored.value ?? DEFAULT_DOCS_SETTINGS) as DocsSettings;
    this.cache = { value, loadedAt: Date.now() };
    return value;
  }

  async save(patch: Record<string, unknown>, expectedVersion?: number): Promise<unknown> {
    return this.documents.write('docs', patch, expectedVersion);
  }

  /** Drop the cached switches; the next read sees the stored row again. */
  invalidate(): void {
    this.cache = undefined;
  }
}
