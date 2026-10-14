import type { Readable } from 'node:stream';

import { RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { FileStorage } from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';

import { FILE_STORAGE_TOKEN } from '../attachment/index.js';
import { DatabaseService } from '../database/database.service.js';

/** One `app_settings` row per feature (PLAN §12.2 convention); this one owns the look of the SPA. */
const BRAND_ROW = 'brand';
const CACHE_MS = 30_000;

export interface BrandSettings {
  pageTitle: string | null;
  footerText: string | null;
  logoAttachmentId: string | null;
}

export interface BrandLogo {
  stream: Readable;
  mimeType: string;
  name: string;
}

/**
 * Instance appearance: the browser/page title, the header brand mark and the footer line.
 * Reads are cached for the same short window as the i18n settings, because every page shell asks
 * for them before it paints — including the sign-in page, which has no principal yet.
 */
@Injectable()
export class BrandService {
  private cache: { value: BrandSettings; loadedAt: number } | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
  ) {}

  async get(): Promise<BrandSettings> {
    const now = Date.now();
    if (this.cache && now - this.cache.loadedAt < CACHE_MS) return this.cache.value;
    const row = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', BRAND_ROW).executeTakeFirst();
    const value = normalizeBrand(row?.data);
    this.cache = { value, loadedAt: now };
    return value;
  }

  async save(patch: Partial<BrandSettings>): Promise<BrandSettings> {
    const db = this.database.db;
    if (patch.logoAttachmentId) {
      const stored = await db
        .selectFrom('attachments')
        .select(['mime_type'])
        .where('id', '=', patch.logoAttachmentId)
        .executeTakeFirst();
      if (!stored) throw new RecordNotFoundError('Attachment', patch.logoAttachmentId);
      if (!stored.mime_type.startsWith('image/')) {
        throw new ValidationError('The logo must be an image.');
      }
    }
    // A key the caller omitted keeps its stored value; an explicit `null` clears it.
    const current = await this.get();
    const next: BrandSettings = {
      pageTitle: patch.pageTitle !== undefined ? patch.pageTitle : current.pageTitle,
      footerText: patch.footerText !== undefined ? patch.footerText : current.footerText,
      logoAttachmentId: patch.logoAttachmentId !== undefined ? patch.logoAttachmentId : current.logoAttachmentId,
    };
    await db
      .insertInto('app_settings')
      .values({ name: BRAND_ROW, data: JSON.stringify(next), modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: JSON.stringify(next), modified_at: new Date() }))
      .execute();
    this.cache = undefined;
    return next;
  }

  /**
   * The configured logo bytes, or null. Served by a public route instead of `/Attachment/:id/file`,
   * which is authenticated and ACL-scoped to its uploader — a login page has neither.
   */
  async logo(): Promise<BrandLogo | null> {
    const { logoAttachmentId } = await this.get();
    if (!logoAttachmentId) return null;
    const row = await this.database.db
      .selectFrom('attachments')
      .select(['name', 'mime_type', 'storage_key'])
      .where('id', '=', logoAttachmentId)
      .executeTakeFirst();
    if (!row || !row.mime_type.startsWith('image/')) return null;
    return { stream: await this.storage.openRead(row.storage_key), mimeType: row.mime_type, name: row.name };
  }
}

function normalizeBrand(data: unknown): BrandSettings {
  const source = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const text = (key: keyof BrandSettings): string | null => {
    const value = source[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  return { pageTitle: text('pageTitle'), footerText: text('footerText'), logoAttachmentId: text('logoAttachmentId') };
}
