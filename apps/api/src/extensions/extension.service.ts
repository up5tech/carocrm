import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { log } from '@carocrm/core/logger/index.js';
import type { ExtensionManifest } from '@carocrm/extension-sdk';
import { ExtensionError, PLATFORM_VERSION, platformProblem, readMetadataSource, readMigrations, scanExtensionPackages, toResolvable } from '@carocrm/extension-sdk';
import type { ExtensionPackage } from '@carocrm/extension-sdk/loader/index.js';
import { Inject, Injectable } from '@nestjs/common';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { DatabaseService } from '../database/database.service.js';
import type { ExtensionHost } from './extension-host.js';
import { EXTENSION_HOST } from './extension-host.js';
import { applyExtensionMigrations } from './extension-store.js';

/**
 * Extension administration (PLAN §38.3, §19.1).
 *
 * Installing an extension is an explicit, audited administrative action: it records the package,
 * runs its pending SQL migrations and — because providers, controllers and metadata precedence are
 * decided when the process starts — asks for a restart. The API never loads or evicts code at
 * runtime; that is what keeps an untrusted admin from injecting a provider into a live process.
 *
 * The extension packages themselves come from `EXTENSIONS_DIR`: uploading a package is a
 * deployment step (copy the directory), so there is no upload endpoint and therefore no path an
 * attacker can choose at runtime (PLAN §38.4).
 */

export interface ExtensionContributes {
  readonly entities: string[];
  readonly controllers: number;
  readonly hooks: string[];
  readonly jobs: string[];
  readonly migrations: string[];
  readonly navItems: number;
}

export interface ExtensionView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly order: number;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** True when this process actually loaded the package. */
  readonly running: boolean;
  readonly path: string | null;
  readonly dependencies: readonly { readonly id: string; readonly version?: string | undefined }[];
  readonly permissions: readonly string[];
  readonly contributes: ExtensionContributes;
  readonly problem: string | null;
  readonly installedAt: string | null;
}

export interface InstallResult {
  readonly id: string;
  readonly version: string;
  readonly installed: true;
  readonly migrations: { readonly applied: readonly string[]; readonly skipped: readonly string[] };
  /** Providers/controllers/metadata only take effect on the next start of the API and the worker. */
  readonly restartRequired: true;
}

interface InstalledRow {
  id: string;
  name: string;
  version: string;
  order: number;
  enabled: boolean;
  installed_at: Date;
}

@Injectable()
export class ExtensionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(EXTENSION_HOST) private readonly host: ExtensionHost,
  ) {}

  async list(): Promise<{ list: ExtensionView[]; total: number }> {
    const packages = this.packages();
    const installed = await this.installedRows();
    // Running packages first, in load order (PLAN §39), so the admin list reads as the effective
    // metadata precedence; anything else follows in id order.
    const loadOrder = new Map(this.host.ids().map((id, index) => [id, index]));
    const views = packages
      .map((pkg) => this.toView(pkg, installed.get(pkg.id)))
      .sort((left, right) => (loadOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (loadOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
    return { list: views, total: views.length };
  }

  async get(id: string): Promise<ExtensionView> {
    const extensionId = requireId(id);
    const pkg = this.packages().find((candidate) => candidate.id === extensionId);
    if (pkg === undefined) throw new NotFoundError(`Extension "${extensionId}" is not present in ${this.config.extensionsDir}.`);
    const row = (await this.installedRows()).get(extensionId);
    if (row === undefined && this.host.get(extensionId) === undefined) {
      throw new NotFoundError(`Extension "${extensionId}" is not installed.`);
    }
    return this.toView(pkg, row);
  }

  /**
   * Installs a package: dependency and platform checks first, then its SQL migrations, then the
   * activation row. Every step is idempotent, so a retry after a failed migration is safe.
   */
  async install(id: string): Promise<InstallResult> {
    const extensionId = requireId(id);
    const pkg = this.packages().find((candidate) => candidate.id === extensionId);
    if (pkg === undefined) throw new NotFoundError(`Extension "${extensionId}" is not present in ${this.config.extensionsDir}.`);
    if ((await this.installedRows()).has(extensionId)) {
      throw new ValidationError(`Extension "${extensionId}" is already installed.`, { id: extensionId });
    }

    const problem = platformProblem(toResolvable(pkg.manifest), PLATFORM_VERSION);
    if (problem !== undefined) {
      throw new ValidationError(`Extension "${extensionId}" ${problem}.`, { id: extensionId, problem });
    }
    await this.assertDependencies(pkg, new Set((await this.installedRows()).keys()), this.packages(), new Set());

    const migrations = await this.runMigrations(pkg);
    await this.database.db
      .insertInto('installed_extensions')
      .values({
        id: pkg.id,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        order_num: pkg.manifest.order,
        enabled: true,
        manifest: JSON.stringify(pkg.manifest),
        installed_at: new Date(),
        modified_at: new Date(),
      })
      .execute();

    await this.audit('create', pkg, { migrations: migrations.applied });
    log.info({ id: pkg.id, version: pkg.manifest.version, migrations: migrations.applied }, 'extension installed');
    return { id: pkg.id, version: pkg.manifest.version, installed: true, migrations, restartRequired: true };
  }

  /** Removes the activation row. SQL already applied is intentionally left in place (AGENTS.md §3.5). */
  async uninstall(id: string): Promise<{ id: string; uninstalled: true; restartRequired: true }> {
    const extensionId = requireId(id);
    const installed = await this.installedRows();
    if (!installed.has(extensionId)) throw new NotFoundError(`Extension "${extensionId}" is not installed.`);

    const dependents = this.packages()
      .filter((pkg) => installed.has(pkg.id) && pkg.manifest.dependencies.some((dependency) => dependency.id === extensionId))
      .map((pkg) => pkg.id);
    if (dependents.length > 0) {
      throw new ValidationError(`Extension "${extensionId}" is required by ${dependents.join(', ')}. Remove those first.`, {
        id: extensionId,
        dependents,
      });
    }

    await this.database.db.deleteFrom('installed_extensions').where('id', '=', extensionId).execute();
    await this.audit('delete', { id: extensionId } as ExtensionPackage, {});
    log.info({ id: extensionId }, 'extension uninstalled');
    return { id: extensionId, uninstalled: true, restartRequired: true };
  }

  async setEnabled(id: string, enabled: boolean): Promise<ExtensionView> {
    const extensionId = requireId(id);
    const installed = await this.installedRows();
    if (!installed.has(extensionId)) throw new NotFoundError(`Extension "${extensionId}" is not installed.`);
    await this.database.db
      .updateTable('installed_extensions')
      .set({ enabled, modified_at: new Date() })
      .where('id', '=', extensionId)
      .execute();
    await this.audit('update', { id: extensionId } as ExtensionPackage, { enabled });
    return this.get(extensionId);
  }

  /** Runs the package's pending SQL migrations, reporting a failure as a client error. */
  private async runMigrations(pkg: ExtensionPackage): Promise<{ applied: string[]; skipped: string[] }> {
    try {
      return await applyExtensionMigrations(this.config.databaseUrl, pkg);
    } catch (error: unknown) {
      if (error instanceof ExtensionError) {
        throw new ValidationError(error.message, error.details);
      }
      throw error;
    }
  }

  private packages(): ExtensionPackage[] {
    return [...scanExtensionPackages(this.config.extensionsDir).packages];
  }

  private async installedRows(): Promise<Map<string, InstalledRow>> {
    const rows = await this.database.db.selectFrom('installed_extensions').selectAll().execute();
    return new Map(rows.map((row) => [row.id, { ...row, order: row.order_num }]));
  }

  private async assertDependencies(pkg: ExtensionPackage, installed: Set<string>, packages: ExtensionPackage[], seen: Set<string>): Promise<void> {
    if (seen.has(pkg.id)) return;
    seen.add(pkg.id);
    for (const dependency of pkg.manifest.dependencies) {
      const target = packages.find((candidate) => candidate.id === dependency.id);
      if (target === undefined || !installed.has(dependency.id)) {
        throw new ValidationError(`Extension "${pkg.id}" depends on "${dependency.id}", which is not installed.`, {
          id: pkg.id,
          dependency: dependency.id,
        });
      }
      await this.assertDependencies(target, installed, packages, seen);
    }
  }

  private toView(pkg: ExtensionPackage, row: InstalledRow | undefined): ExtensionView {
    const running = this.host.get(pkg.id);
    const manifest: ExtensionManifest = pkg.manifest;
    const migrations = readMigrations(pkg).map((file) => file.name);
    // A package that is installed but not yet loaded still has contributions to report — that is
    // exactly the state an operator needs to see before restarting.
    const backend = running?.package.backend;
    const entities = Object.keys(running?.package.metadata.entities ?? readMetadataSource(pkg).entities ?? {});
    return {
      id: pkg.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description ?? null,
      order: pkg.manifest.order,
      installed: row !== undefined,
      enabled: row?.enabled ?? false,
      running: running !== undefined,
      path: pkg.dir,
      dependencies: manifest.dependencies,
      permissions: manifest.permissions,
      contributes: {
        entities: entities.sort(),
        controllers: (backend?.controllers ?? []).length,
        hooks: (backend?.hooks ?? []).map((hook) => hook.name),
        jobs: (backend?.jobs ?? []).map((job) => job.name),
        migrations,
        navItems: manifest.frontend?.nav.length ?? 0,
      },
      problem: platformProblem(toResolvable(pkg.manifest), PLATFORM_VERSION) ?? null,
      installedAt: row?.installed_at.toISOString() ?? null,
    };
  }

  /** Extension lifecycle is a security-relevant change, so it lands in the admin audit log. */
  private async audit(action: 'create' | 'update' | 'delete', pkg: ExtensionPackage, data: Record<string, unknown>): Promise<void> {
    await this.database.db
      .insertInto('audit_log')
      .values({
        id: randomUUID(),
        entity_type: 'Extension',
        record_id: pkg.id,
        username: this.scope.principal?.userName ?? null,
        user_id: this.scope.userId ?? null,
        action,
        order: 0,
        data: JSON.stringify({ id: pkg.id, ...data }),
        archived: false,
        created_at: new Date(),
      })
      .execute();
  }

  }

function requireId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new ValidationError('An extension id is lowercase kebab-case, 2-64 characters.', { id: value });
  return id;
}