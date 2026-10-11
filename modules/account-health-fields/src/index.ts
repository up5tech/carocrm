import type { ExtensionApi, ExtensionBackend } from '@carocrm/extension-sdk';

/**
 * `account-health-fields` — a **metadata-only** extension (PLAN §38.1, Phase 14 acceptance).
 *
 * Everything it does is in `metadata/entities.json`: it adds fields, a layout and an index
 * declaration to the core `Account` entity. The generic entity API, ACL, validation, audit, the
 * Entity Manager UI and the formula engine then treat those fields exactly like built-in ones — no
 * controller, no service, no migration.
 *
 * The manifest marks this backend `worker: false`, so the worker never imports this file at all.
 * The `setup()` below exists to show the lifecycle hook: it runs once per process start, after
 * metadata has been loaded, and the value it reads is the platform's own configuration store — not a
 * hard-coded switch.
 */
export default {
  setup(api: ExtensionApi): void {
    api.log.info(
      {
        id: api.id,
        version: api.version,
        // An administrator can turn the package off without uninstalling it.
        enabled: api.getConfig('enabled', true),
      },
      'account health fields ready',
    );
  },
} satisfies ExtensionBackend;