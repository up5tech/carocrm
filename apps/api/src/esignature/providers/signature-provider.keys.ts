/**
 * Phase 19-ES.1 / multi-provider follow-on — the provider keys this module knows.
 *
 * The key is the only identity a stored connection, request, event or webhook row carries. It is a
 * lowercase, stable string, never a vendor's display name, so a provider can be renamed in the UI
 * without touching a row. The table itself lives in `signature-provider.catalog.ts`; this file holds
 * only the names, so the domain vocabulary and the catalog can refer to each other without a cycle.
 *
 * **Adding a provider** means a descriptor in the catalog, an adapter (and its auth strategy) in
 * `providers/<key>/`, and — when the provider is meant to store rows — a migration widening the
 * `provider_key` CHECK constraints. Nothing above the adapter boundary changes.
 */

/** DocuSign eSignature — the first adapter and the reference implementation of the contract. */
export const PROVIDER_KEY_DOCUSIGN = 'docusign';

/**
 * Dropbox Sign (formerly HelloSign) — cataloged as a direction, not integrated in this build.
 *
 * The key exists so the catalog, the admin picker and the domain vocabulary are genuinely
 * provider-neutral, and so the row it will eventually own needs no rename. A connection cannot be
 * created for it until `providers/dropbox-sign/` ships an adapter and its auth strategy.
 */
export const PROVIDER_KEY_DROPBOX_SIGN = 'dropbox_sign';

/** Every provider key the module recognizes, in catalog order. */
export const SIGNATURE_PROVIDER_KEYS = [PROVIDER_KEY_DOCUSIGN, PROVIDER_KEY_DROPBOX_SIGN] as const;

export type SignatureProviderKey = (typeof SIGNATURE_PROVIDER_KEYS)[number];

/** Whether a stored value is a provider key this build knows. */
export function isSignatureProviderKey(value: string): value is SignatureProviderKey {
  return (SIGNATURE_PROVIDER_KEYS as readonly string[]).includes(value);
}
