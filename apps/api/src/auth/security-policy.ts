import { ValidationError } from '@carocrm/core/errors/index.js';

import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings,SecuritySettingsSchema } from '../admin-panel/settings-shapes.js';
import type { Db } from '../database/database.service.js';

/**
 * Phase 23.2 (PLAN §8): the `security` settings document was stored and displayed by Phase 20 but
 * never enforced. Authentication reads it here, at the point of use. The row is the same envelope
 * the settings registry writes (`{value, version, …}`); a missing or invalid row falls back to the
 * registered defaults, exactly as the settings reader does.
 */
export async function readSecurityPolicy(db: Db): Promise<SecuritySettings> {
  const row = await db.selectFrom('app_settings').select('data').where('name', '=', 'security').executeTakeFirst();
  let stored: unknown = row?.data;
  if (typeof stored === 'string') {
    try {
      stored = JSON.parse(stored);
    } catch {
      stored = undefined;
    }
  }
  const envelope = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const parsed = SecuritySettingsSchema.safeParse(envelope['value'] ?? {});
  return parsed.success ? parsed.data : DEFAULT_SECURITY_SETTINGS;
}

/** The instance password policy, applied wherever a password is set (PLAN §17.1, §4.8). */
export function assertPasswordPolicy(policy: SecuritySettings, password: string): void {
  const rules = policy.password;
  if (password.length < rules.minLength) {
    throw new ValidationError(`Password must be at least ${String(rules.minLength)} characters.`);
  }
  if (rules.requireUppercase && !/[A-Z]/.test(password)) {
    throw new ValidationError('Password must contain an uppercase letter.');
  }
  if (rules.requireNumber && !/\d/.test(password)) {
    throw new ValidationError('Password must contain a number.');
  }
  if (rules.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    throw new ValidationError('Password must contain a symbol.');
  }
}

/** Phase 23.2 (PLAN §8 task 3): whether the instance MFA policy covers this account. */
export function mfaRequiredFor(policy: SecuritySettings, user: { type: string; is_admin: boolean }): boolean {
  const isAdmin = user.type === 'admin' || user.is_admin;
  if (policy.mfa.required === 'all') return true;
  if (policy.mfa.required === 'admins') return isAdmin;
  return false;
}