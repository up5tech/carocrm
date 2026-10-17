import { z } from "zod";

/**
 * Phase 19-SD — request shapes for the Service Desk domain commands
 * (`/api/v1/ServiceDesk`, PLAN_Phase_19_ServiceDesk.md §8.2).
 *
 * Entity CRUD stays on the generic `/api/v1/Case` API, so these shapes cover only the module-level
 * commands: settings and the numbering preview. The settings document is validated again inside
 * `ServiceDeskSettingsService` against the typed schema, which is the authority.
 */

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export type SettingsPatchInput = z.infer<typeof SettingsPatchSchema>;
