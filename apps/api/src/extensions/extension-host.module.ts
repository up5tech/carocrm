import { log } from '@carocrm/core/logger/index.js';
import type { ExtensionApi } from '@carocrm/extension-sdk';
import { Inject, Module, type Provider, type Type } from '@nestjs/common';

import { AppModule } from '../app.module.js';
import { DatabaseService } from '../database/database.service.js';
import { HookRegistry } from '../hooks/hook.registry.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import type { ExtensionHost } from './extension-host.js';

/**
 * Dynamic Nest module that installs the running extensions (PLAN §38.1, §38.3).
 *
 * Nest builds its provider/controller graph once, at creation time, so extensions cannot be added
 * or removed while the process is running — they come from `EXTENSIONS_DIR` and are activated by
 * `installed_extensions` on the next start. This module is the seam that turns that set into Nest
 * objects: it registers each package's providers and controllers, hands them their entity-manager
 * hooks, and runs their `setup()` once the container is ready.
 *
 * It imports {@link AppModule}, so an extension may inject the documented kernel exports
 * (`DatabaseService`, `AuthService`, `IdentityService`, `RequestScope`, `METADATA_STORE`,
 * `AclApiService`, `HookRegistry`, `JobsService`, `OutboxService`, …) — and nothing else. Anything
 * an extension cannot reach through those tokens is deliberately out of the contract.
 */
export function createExtensionHostModule(host: ExtensionHost): Type<unknown> {
  @Module({
    imports: [AppModule],
    controllers: host.controllers() as Type<unknown>[],
    providers: host.providers() as Provider[],
  })
  class ExtensionHostModule {
    constructor(
      @Inject(HookRegistry) private readonly hooks: HookRegistry,
      @Inject(DatabaseService) private readonly database: DatabaseService,
      @Inject(JobsService) private readonly jobs: JobsService,
      @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      registerExtensionHooks(this.hooks, host);
      await this.runSetups();
      log.info(
        {
          extensions: host.extensions.map((extension) => `${extension.id}@${extension.version}`),
          providers: host.providers().length,
          controllers: host.controllers().length,
          hooks: host.hooks().length,
          jobs: host.jobs().map((entry) => entry.job.name),
          skipped: host.skipped.map((skip) => `${skip.id}: ${skip.reason}`),
          failed: host.errors.map((error) => `${error.dir}: ${error.message}`),
        },
        'extensions loaded',
      );
    }

    /**
     * Hands each package its {@link ExtensionApi} facade, in load order. A failing `setup()` aborts
     * the boot: a package that cannot initialise must not look installed.
     */
    private async runSetups(): Promise<void> {
      for (const { id, setup } of host.setups()) {
        const extension = host.get(id);
        if (extension === undefined) continue;
        const config = await this.readConfig(id);
        await setup(this.facade(extension.id, extension.name, extension.version, extension.dir, config));
      }
    }

    private facade(
      id: string,
      name: string,
      version: string,
      dir: string,
      config: Record<string, unknown>,
    ): ExtensionApi {
      return {
        id,
        name,
        version,
        dir,
        log,
        // Extension packages are trusted code on a self-hosted install (PLAN §38.4), but this raw
        // handle is still documented as extension-owned tables only: CRM data must go through the
        // entity API so ACL, validation, audit and hooks stay in force.
        db: {
          query: async <Row>(sql: string, params?: readonly unknown[]) =>
            (await this.database.pool.query(sql, params as unknown[])).rows as Row[],
        },
        enqueue: async (job, data) => {
          const view = await this.jobs.enqueue({ job, data: data ?? {} });
          return view.id;
        },
        getConfig: <T>(key: string, fallback: T) => (config[key] === undefined ? fallback : (config[key] as T)),
        setConfig: async (key, value) => {
          config[key] = value;
          await this.database.db
            .insertInto('app_settings')
            .values({ name: `extension:${id}`, data: JSON.stringify(config), modified_at: new Date() })
            .onConflict((oc) =>
              oc.column('name').doUpdateSet({ data: JSON.stringify(config), modified_at: new Date() }),
            )
            .execute();
        },
        metadata: () => this.metadata.getMetadata(),
      };
    }

    /** An extension's own configuration blob (`app_settings` row `extension:<id>`). */
    private async readConfig(id: string): Promise<Record<string, unknown>> {
      const row = await this.database.db.selectFrom('app_settings').select('data').where('name', '=', `extension:${id}`).executeTakeFirst();
      const data = row?.data;
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
      if (typeof data === 'string') {
        try {
          const parsed: unknown = JSON.parse(data);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      return {};
    }
  }
  return ExtensionHostModule;
}

/** Registers every extension's entity-manager hooks on the shared registry, namespaced by package. */
export function registerExtensionHooks(registry: HookRegistry, host: ExtensionHost): void {
  for (const { extension, hook } of host.hooks()) {
    const name = `${extension}:${hook.name}`;
    try {
      registry.register({ name, phase: hook.phase, entity: hook.entity, handler: hook.handler });
    } catch (error: unknown) {
      log.error({ extension, hook: hook.name, error: error instanceof Error ? error.message : String(error) }, 'extension hook rejected');
    }
  }
}