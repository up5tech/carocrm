import { z } from 'zod';

import { ExtensionError } from '../errors/index.js';
import { isVersion } from '../semver/index.js';

/**
 * Extension manifest (PLAN §38.2).
 *
 * The manifest is the whole contract between a package and the platform: identity, version
 * compatibility, dependencies, priority and pointers to the optional directories. It is validated
 * with a **strict** object on purpose — a typo like `dependancies` must fail the install with an
 * actionable message instead of silently disabling the dependency (PLAN §12.4).
 *
 * The shape extends `MetadataManifestSchema` from `@carocrm/metadata` (id / name / version /
 * minPlatformVersion / dependencies / permissions / metadata.order), so a manifest stays readable
 * by anything that already understands kernel metadata.
 */

/** Platform version extensions are checked against (`minPlatformVersion`). */
export const PLATFORM_VERSION = '1.0.0';

const VersionSchema = z.string().refine(isVersion, { message: 'expected MAJOR.MINOR[.PATCH][-prerelease]' });

export const ExtensionDependencySchema = z
  .union([z.string().min(1), z.object({ id: z.string().min(1), version: VersionSchema.optional() })])
  .transform((value) => (typeof value === 'string' ? { id: value } : value));

export const ExtensionBackendSchema = z.union([
  /** Shorthand: the backend module path, loaded by both processes. */
  z.string().min(1),
  z.object({
    /** Path to the backend module, relative to the package root. */
    entry: z.string().min(1),
    /** Set to false when the module is API-only and the worker must not import it. */
    worker: z.boolean().default(true),
  }),
]);

export const ExtensionNavItemSchema = z.object({
  /** SPA route this entry links to, e.g. `/Project` or `/dashboards`. */
  route: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  /** Ant Design icon name; resolved by the SPA from its own icon set, never fetched. */
  icon: z.string().max(60).optional(),
  /** Restrict the entry to administrators. */
  adminOnly: z.boolean().default(false),
  /** Permission (role action name) a user must hold for the entry to be shown. */
  permission: z.string().max(120).optional(),
  /** Lower sorts first inside the extension group. */
  order: z.number().int().min(0).max(9999).default(100),
});

export const ExtensionFrontendSchema = z.object({
  nav: z.array(ExtensionNavItemSchema).default([]),
});

export const ExtensionManifestSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,63}$/, 'must be lowercase kebab-case, 2-64 characters'),
    name: z.string().min(1).max(120),
    version: VersionSchema,
    description: z.string().max(500).optional(),
    /** Refuse to install unless the platform is at least this version (PLAN §38.3). */
    minPlatformVersion: VersionSchema.optional(),
    /** Refuse to install when the platform is newer than this. */
    maxPlatformVersion: VersionSchema.optional(),
    dependencies: z.array(ExtensionDependencySchema).default([]),
    /** Capability names the package asks for; shown to the admin before installing. */
    permissions: z.array(z.string().min(1).max(60)).default([]),
    /** Metadata merge priority (PLAN §39): lower loads first, higher overrides. */
    order: z.number().int().min(0).max(9999).default(100),
    /** Backend module path, or `{ entry, worker }`. */
    backend: ExtensionBackendSchema.optional(),
    /** Directory holding metadata documents, relative to the package root. Default `metadata`. */
    metadata: z.string().min(1).max(200).optional(),
    /** Directory holding ordered `*.sql` migrations. Default `migrations`. */
    migrations: z.string().min(1).max(200).optional(),
    /** Frontend contributions rendered by the SPA. */
    frontend: ExtensionFrontendSchema.optional(),
    /** Free-form package metadata (homepage, vendor, …); never interpreted by the platform. */
    package: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ExtensionDependency = { id: string; version?: string | undefined };
export type ExtensionNavItem = z.infer<typeof ExtensionNavItemSchema>;
export type ExtensionFrontend = z.infer<typeof ExtensionFrontendSchema>;
export type ExtensionBackendPointer = { entry: string; worker: boolean };
export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  description?: string | undefined;
  minPlatformVersion?: string | undefined;
  maxPlatformVersion?: string | undefined;
  dependencies: ExtensionDependency[];
  permissions: string[];
  order: number;
  backend?: string | ExtensionBackendPointer | undefined;
  metadata?: string | undefined;
  migrations?: string | undefined;
  frontend?: ExtensionFrontend | undefined;
  package?: Record<string, unknown> | undefined;
};

/** Parses a manifest document, raising an actionable `EXTENSION_MANIFEST_INVALID` error. */
export function parseManifest(value: unknown, context: Record<string, unknown> = {}): ExtensionManifest {
  const parsed = ExtensionManifestSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
    throw new ExtensionError('EXTENSION_MANIFEST_INVALID', `Invalid extension manifest${describe(context)}: ${issues.join('; ')}`, {
      ...context,
      issues,
    });
  }
  return normalizeManifest(parsed.data);
}

/** JSON text form of {@link parseManifest}. */
export function parseManifestJson(text: string, context: Record<string, unknown> = {}): ExtensionManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new ExtensionError('EXTENSION_MANIFEST_INVALID', `Extension manifest${describe(context)} is not valid JSON: ${messageOf(error)}`, context);
  }
  return parseManifest(value, context);
}

function normalizeManifest(manifest: z.infer<typeof ExtensionManifestSchema>): ExtensionManifest {
  const backend =
    typeof manifest.backend === 'string' ? manifest.backend : manifest.backend === undefined ? undefined : { ...manifest.backend };
  const result: ExtensionManifest = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies.map((dependency) =>
      dependency.version === undefined ? { id: dependency.id } : { id: dependency.id, version: dependency.version },
    ),
    permissions: [...manifest.permissions],
    order: manifest.order,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.minPlatformVersion === undefined ? {} : { minPlatformVersion: manifest.minPlatformVersion }),
    ...(manifest.maxPlatformVersion === undefined ? {} : { maxPlatformVersion: manifest.maxPlatformVersion }),
    ...(backend === undefined ? {} : { backend }),
    ...(manifest.metadata === undefined ? {} : { metadata: manifest.metadata }),
    ...(manifest.migrations === undefined ? {} : { migrations: manifest.migrations }),
    ...(manifest.frontend === undefined
      ? {}
      : {
          frontend: {
            nav: manifest.frontend.nav.map((item) => ({
              route: item.route,
              label: item.label,
              order: item.order,
              adminOnly: item.adminOnly,
              ...(item.icon === undefined ? {} : { icon: item.icon }),
              ...(item.permission === undefined ? {} : { permission: item.permission }),
            })),
          },
        }),
    ...(manifest.package === undefined ? {} : { package: manifest.package }),
  };
  return result;
}

function describe(context: Record<string, unknown>): string {
  const id = typeof context['id'] === 'string' ? context['id'] : undefined;
  return id === undefined ? '' : ` for "${id}"`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}