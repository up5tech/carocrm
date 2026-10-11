import type { Provider } from '@nestjs/common';

import { AclApiService } from './acl-api.service.js';

/**
 * ACL barrel.
 *
 * The integrator adds `ACL_PROVIDERS` to `AppModule.providers`
 * (apps/api/src/app.module.ts is intentionally untouched here). Every provider is
 * registered with an explicit token and uses `@Inject(...)` because the API runs
 * under tsx/esbuild without `emitDecoratorMetadata`.
 */
export const ACL_PROVIDERS: Provider[] = [AclApiService];

/** The ACL layer exposes no HTTP routes of its own. */
export const ACL_CONTROLLERS: unknown[] = [];
