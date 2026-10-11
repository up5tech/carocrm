import type { ExtensionApi, ExtensionBackend } from '@carocrm/extension-sdk';

import { ProjectSummaryController } from './project.controller.js';

/**
 * `project-domain` — a **custom CRM domain module** (Phase 14 acceptance).
 *
 * The Project entity, its fields, relations, layouts and ACL defaults live in
 * `metadata/entities.json`; the generic entity API, the Entity Manager and the SPA then serve the
 * entity with no dedicated code. The package adds exactly one thing metadata cannot express: a
 * derived read-only summary endpoint that goes through the host's ACL evaluator.
 *
 * It declares a dependency on `webhook-integration` (PLAN §39): its records raise the same entity
 * domain events every other entity does, and this installation publishes those through the webhook
 * package. The dependency is what makes the resolver refuse to uninstall the webhook package while
 * this one is installed, and what makes it load first.
 */
export default {
  controllers: [ProjectSummaryController],

  setup(api: ExtensionApi): void {
    api.log.info(
      {
        id: api.id,
        version: api.version,
        // Demonstrates a host-provided configuration value; nothing here is hard-coded per install.
        summaryFields: api.getConfig<string[]>('summaryFields', ['status', 'dueDate', 'progress']),
      },
      'project domain ready',
    );
  },
} satisfies ExtensionBackend;