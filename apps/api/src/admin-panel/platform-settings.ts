import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { EXTENSION_HOST, type ExtensionHost } from '../extensions/extension-host.js';
import { I18nService, type I18nSettings } from '../i18n/i18n.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { BrandSettings } from '../settings/brand.service.js';
import { BrandService } from '../settings/brand.service.js';
import { knownEntryKeys, navigationWarnings } from './navigation-warnings.js';
import type { SettingsDocumentDefinition, SettingsWarning } from './settings-registry.service.js';
import { SettingsRegistryService } from './settings-registry.service.js';
import {
  BRAND_DOCUMENT_SCHEMA,
  type BrandDocument,
  DEFAULT_DOCS_SETTINGS,
  DEFAULT_FILE_STORAGE_SETTINGS,
  DEFAULT_NAVIGATION_SETTINGS,
  DEFAULT_NOTIFICATIONS_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  DocsSettingsSchema,
  FileStorageSettingsSchema,
  I18N_DOCUMENT_SCHEMA,
  type I18nDocument,
  type NavigationSettings,
  NavigationSettingsSchema,
  NotificationsSettingsSchema,
  SecuritySettingsSchema,
} from './settings-shapes.js';

/**
 * The documents Phase 20 registers with the registry (§4.2, §7.1).
 *
 * `brand` and `i18n` keep the services that own their rules — the logo has to be an image, a locale
 * has to exist as a catalog, a timezone has to resolve — so they register a delegate and their row
 * shape is untouched. The four new documents are stored as `{version, value, …}` envelopes and are
 * validated here, by their own schema.
 */
const DEFAULT_LOCALE = 'en';

@Injectable()
export class PlatformSettingsRegistrar implements OnModuleInit {
  constructor(
    @Inject(SettingsRegistryService) private readonly registry: SettingsRegistryService,
    @Inject(BrandService) private readonly brand: BrandService,
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(METADATA_STORE) private readonly store: MetadataStoreService,
    @Inject(EXTENSION_HOST) private readonly host: ExtensionHost,
  ) {}

  onModuleInit(): void {
    const brandDocument: SettingsDocumentDefinition = {
      name: 'brand',
      group: 'general',
      labelKey: 'web.adminPanel.tabs.general',
      descriptionKey: 'web.adminPanel.descriptions.general',
      readLevel: 'public',
      writeLevel: 'admin',
      schema: BRAND_DOCUMENT_SCHEMA,
      defaults: { pageTitle: null, footerText: null, logoAttachmentId: null } satisfies BrandDocument,
      storage: 'flat',
      write: (patch) => this.brand.save(BRAND_DOCUMENT_SCHEMA.parse(patch) as Partial<BrandSettings>),
    };

    const i18nDocument: SettingsDocumentDefinition = {
      name: 'i18n',
      group: 'localization',
      labelKey: 'web.adminPanel.tabs.localization',
      descriptionKey: 'web.adminPanel.descriptions.localization',
      readLevel: 'public',
      writeLevel: 'admin',
      schema: I18N_DOCUMENT_SCHEMA,
      defaults: { defaultLocale: 'en', enabledLocales: ['en', 'vi'], defaultTimezone: 'UTC' } satisfies I18nDocument,
      storage: 'flat',
      write: (patch) => this.i18n.saveSettings(I18N_DOCUMENT_SCHEMA.parse(patch) as Partial<I18nSettings>),
    };

    const navigationDocument: SettingsDocumentDefinition = {
      name: 'navigation',
      group: 'menu',
      labelKey: 'web.adminPanel.tabs.menu',
      descriptionKey: 'web.adminPanel.descriptions.menu',
      readLevel: 'admin',
      writeLevel: 'admin',
      schema: NavigationSettingsSchema,
      defaults: DEFAULT_NAVIGATION_SETTINGS,
      storage: 'envelope',
      warnings: (value) => this.navigationWarningsFor(value as NavigationSettings),
    };

    const securityDocument: SettingsDocumentDefinition = {
      name: 'security',
      group: 'authentication',
      labelKey: 'web.adminPanel.tabs.authentication',
      readLevel: 'admin',
      writeLevel: 'sysAdmin',
      schema: SecuritySettingsSchema,
      defaults: DEFAULT_SECURITY_SETTINGS,
      storage: 'envelope',
    };

    const fileStorageDocument: SettingsDocumentDefinition = {
      name: 'fileStorage',
      group: 'attachments',
      labelKey: 'web.adminPanel.tabs.attachments',
      readLevel: 'admin',
      writeLevel: 'admin',
      schema: FileStorageSettingsSchema,
      defaults: DEFAULT_FILE_STORAGE_SETTINGS,
      storage: 'envelope',
    };

    const notificationsDocument: SettingsDocumentDefinition = {
      name: 'notifications',
      group: 'notifications',
      labelKey: 'web.adminPanel.tabs.notifications',
      readLevel: 'admin',
      writeLevel: 'admin',
      schema: NotificationsSettingsSchema,
      defaults: DEFAULT_NOTIFICATIONS_SETTINGS,
      storage: 'envelope',
    };

    const docsDocument: SettingsDocumentDefinition = {
      name: 'docs',
      group: 'documentation',
      labelKey: 'web.adminPanel.tabs.docs',
      descriptionKey: 'web.adminPanel.descriptions.docs',
      // Every signed-in reader may see the handbook's own switches; only an administrator changes them.
      readLevel: 'user',
      writeLevel: 'admin',
      schema: DocsSettingsSchema,
      defaults: DEFAULT_DOCS_SETTINGS,
      storage: 'envelope',
    };

    for (const document of [
      brandDocument,
      i18nDocument,
      navigationDocument,
      securityDocument,
      fileStorageDocument,
      notificationsDocument,
      docsDocument,
    ]) {
      if (!this.registry.has(document.name)) this.registry.register(document);
    }
  }

  private navigationWarningsFor(value: NavigationSettings): readonly SettingsWarning[] {
    this.store.ensureLoaded();
    const entityNames = this.store.registry.getEntities();
    const extensionKeys = this.host.frontendNav().map((item) => `extension:${item.extension}:${item.route}`);
    return navigationWarnings(value, {
      knownKeys: knownEntryKeys(entityNames, extensionKeys),
      entityExists: (name) => this.store.registry.hasEntity(name),
      labelKeyResolves: (key) => this.i18n.translate(DEFAULT_LOCALE, key) !== undefined,
    });
  }
}
