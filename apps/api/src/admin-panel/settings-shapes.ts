import { z } from 'zod';

/**
 * Settings document schemas for Phase 20 (PLAN_Phase_20_Settings_UX.md §4.2, §6.2).
 *
 * Every document is one row of the existing `app_settings` table; the registry in
 * `settings-registry.service.ts` pairs these schemas with a read/write level. Validation happens
 * before the row is touched, so a rejected write leaves the stored document unchanged.
 */

/**
 * Menu accents the SPA can paint. The list is fixed on purpose: an accent is a token, not a color,
 * so an administrator can never make the shell render an arbitrary style. Mirrors the
 * `NAV_ACCENTS` map in `apps/web/src/theme.ts`.
 */
export const NAVIGATION_ACCENTS = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'magenta', 'gold'] as const;

/**
 * Icon names a menu entry may use, resolved by the SPA from its fixed `@ant-design/icons` set.
 * Kept as a literal list rather than an import because the backend must reject an unknown name
 * before it reaches the browser (PLAN §10.1). It is the union of `ENTITY_ICONS` (record entities)
 * and the marks the shell uses for its fixed pages, groups and administration entries; keep in sync
 * with `NAV_ICONS` in `apps/web/src/components/entityIcons.tsx`.
 */
export const NAVIGATION_ICONS = [
  'ApiOutlined',
  'ApartmentOutlined',
  'AppstoreOutlined',
  'BankOutlined',
  'BarChartOutlined',
  'BookOutlined',
  'CalendarOutlined',
  'CarryOutOutlined',
  'CloudOutlined',
  'CustomerServiceOutlined',
  'DashboardOutlined',
  'DatabaseOutlined',
  'DollarOutlined',
  'EnvironmentOutlined',
  'ExperimentOutlined',
  'FileSearchOutlined',
  'FileTextOutlined',
  'FundOutlined',
  'GlobalOutlined',
  'HddOutlined',
  'HomeOutlined',
  'InboxOutlined',
  'KeyOutlined',
  'MailOutlined',
  'MobileOutlined',
  'NotificationOutlined',
  'PhoneOutlined',
  'ProfileOutlined',
  'ProjectOutlined',
  'ScheduleOutlined',
  'SearchOutlined',
  'SettingOutlined',
  'ShareAltOutlined',
  'ShopOutlined',
  'ShoppingCartOutlined',
  'SolutionOutlined',
  'StarOutlined',
  'TagOutlined',
  'TeamOutlined',
  'ThunderboltOutlined',
  'ToolOutlined',
  'TrophyOutlined',
  'UserAddOutlined',
  'UserOutlined',
  'VideoCameraOutlined',
  'WalletOutlined',
] as const;

/**
 * One menu override. Unknown keys are kept (`.catchall`) instead of stripped, so the resolver can
 * report them as tab warnings while still ignoring their meaning — the forward-compatibility rule
 * in PLAN §6.2.
 */
export const NavigationItemSchema = z
  .object({
    key: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    order: z.number().int().min(-100000).max(100000).default(1000),
    labelKey: z.string().min(1).max(120).optional(),
    icon: z.enum(NAVIGATION_ICONS).optional(),
    accent: z.enum(NAVIGATION_ACCENTS).optional(),
    inQuickSearch: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const NavigationGroupSchema = z
  .object({
    key: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    order: z.number().int().min(-100000).max(100000).default(1000),
    labelKey: z.string().min(1).max(120).optional(),
    icon: z.enum(NAVIGATION_ICONS).optional(),
    accent: z.enum(NAVIGATION_ACCENTS).optional(),
  })
  .catchall(z.unknown());

export const NavigationSettingsSchema = z
  .object({
    items: z.array(NavigationItemSchema).max(500).default([]),
    groups: z.array(NavigationGroupSchema).max(100).default([]),
    accentPalette: z.array(z.enum(NAVIGATION_ACCENTS)).max(20).default([...NAVIGATION_ACCENTS]),
  })
  .strict();

export type NavigationItem = z.infer<typeof NavigationItemSchema>;
export type NavigationGroup = z.infer<typeof NavigationGroupSchema>;
export type NavigationSettings = z.infer<typeof NavigationSettingsSchema>;

export const BRAND_DOCUMENT_SCHEMA = z.object({
  pageTitle: z.string().trim().min(1).max(80).nullable().optional(),
  footerText: z.string().trim().max(200).nullable().optional(),
  logoAttachmentId: z.string().max(36).nullable().optional(),
  // A brand colour is an accent *name* from NAVIGATION_ACCENTS — never a free hex — so it always maps
  // to a token the design system owns (PLAN §20.20). An unknown name is refused with 422.
  primaryColor: z.enum(NAVIGATION_ACCENTS).nullable().optional(),
});

export type BrandDocument = z.infer<typeof BRAND_DOCUMENT_SCHEMA>;

export const I18N_DOCUMENT_SCHEMA = z.object({
  defaultLocale: z.string().min(2).max(20).optional(),
  enabledLocales: z.array(z.string().min(2).max(20)).min(1).max(20).optional(),
  defaultTimezone: z.string().min(1).max(64).optional(),
});

export type I18nDocument = z.infer<typeof I18N_DOCUMENT_SCHEMA>;

/**
 * Authentication policy (PLAN §4.8). Stored and displayed by the registry; the enforcement points in
 * `auth.service.ts` are Phase 20.9 work, so nothing here changes login behavior yet.
 */
export const SecuritySettingsSchema = z
  .object({
    password: z
      .object({
        minLength: z.number().int().min(6).max(128).default(8),
        requireUppercase: z.boolean().default(false),
        requireNumber: z.boolean().default(false),
        requireSymbol: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    session: z
      .object({
        idleLogoutMinutes: z.number().int().min(0).max(10080).default(0),
        singleSession: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    loginNotice: z.string().max(500).nullable().default(null),
  })
  .strict();

export type SecuritySettings = z.infer<typeof SecuritySettingsSchema>;

/** Upload limits the attachments tab will edit (PLAN §4.3 row 5). Enforcement is Phase 20.9. */
export const FileStorageSettingsSchema = z
  .object({
    maxUploadSizeMb: z.number().int().min(1).max(2048).default(25),
    allowedExtensions: z.array(z.string().min(1).max(16).regex(/^[a-z0-9]+$/)).max(200).default(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'csv', 'xlsx', 'docx']),
  })
  .strict();

export type FileStorageSettings = z.infer<typeof FileStorageSettingsSchema>;

/** Instance notification defaults (PLAN §4.8). Read by the notifications tab in Phase 20.9. */
export const NotificationsSettingsSchema = z
  .object({
    digest: z.enum(['off', 'daily', 'weekly']).default('daily'),
    emailOnAssignment: z.boolean().default(true),
    emailOnStreamUpdate: z.boolean().default(false),
  })
  .strict();

export type NotificationsSettings = z.infer<typeof NotificationsSettingsSchema>;

/**
 * The in-app documentation surface (PLAN_Phase_21_Documentation.md §6.1).
 *
 * It only decides **whether and where** the handbook is reachable. The content itself is files in
 * `content/docs/`, not rows, so there is nothing here to author — which is the point: an instance can
 * turn the surface off, point it at its own wiki, or hide the sidebar entry without touching a corpus.
 */
export const DocsSettingsSchema = z
  .object({
    /** When false the docs endpoints answer 404 and the SPA renders the disabled state. */
    enabled: z.boolean().default(true),
    /** Drives the navigation feature gate; a flag can only remove an entry, never reveal one. */
    showInSidebar: z.boolean().default(true),
    /** The avatar-menu "Help & documentation" item. */
    showHelpMenu: z.boolean().default(true),
    /** An organisation that hosts its own handbook: `/docs` answers 301 to this instead. */
    externalUrl: z.string().url().nullable().default(null),
    /** Overrides the landing's first card with a `section/slug` page key. */
    landingPage: z
      .string()
      .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, 'landingPage must be a section/slug page key')
      .nullable()
      .default(null),
    /** The "Ask your administrator" address shown in empty states. */
    supportEmail: z.string().email().nullable().default(null),
  })
  .strict();

export type DocsSettings = z.infer<typeof DocsSettingsSchema>;

export const DEFAULT_DOCS_SETTINGS: DocsSettings = DocsSettingsSchema.parse({});

export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettings = NavigationSettingsSchema.parse({});
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = SecuritySettingsSchema.parse({});
export const DEFAULT_FILE_STORAGE_SETTINGS: FileStorageSettings = FileStorageSettingsSchema.parse({});
export const DEFAULT_NOTIFICATIONS_SETTINGS: NotificationsSettings = NotificationsSettingsSchema.parse({});
