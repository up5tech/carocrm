import type { Provider, Type } from '@nestjs/common';

import { PortalAdminController } from './portal-admin.controller.js';
import { PortalAdminService } from './portal-admin.service.js';
import { PortalController } from './portal.controller.js';
import { PortalFrontService } from './portal-front.service.js';
import { PortalPolicyService } from './portal-policy.service.js';
import { PortalRoleController } from './portal-role.controller.js';

export { PortalAdminService } from './portal-admin.service.js';
export { PortalFrontService } from './portal-front.service.js';
export { PortalPolicyService } from './portal-policy.service.js';

/**
 * Phase 18 portal providers (PLAN §37). `PortalPolicyService` is the portal ACL policy
 * provider `AclApiService` delegates to for portal principals; the rest are the admin and
 * portal-user-facing services behind the controllers.
 */
export const PORTAL_PROVIDERS: Provider[] = [PortalPolicyService, PortalAdminService, PortalFrontService];

/**
 * Phase 18 controllers. The user-facing `PortalController` (me/nav/dashboard) and the admin
 * controllers share the `api/v1/Portal` prefix: Fastify matches static segments ("me", "nav",
 * "dashboard") before parametric ones (":id"), so the routes cannot shadow each other.
 */
export const PORTAL_CONTROLLERS: Type<unknown>[] = [PortalController, PortalAdminController, PortalRoleController];
