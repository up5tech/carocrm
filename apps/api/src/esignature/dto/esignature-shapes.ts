import { z } from 'zod';

/**
 * Phase 19-ES.1 — request shapes (`PLAN_Phase_19_ESignature.md` §8; AGENTS.md §5.4).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored, so a typo in a
 * feature name cannot be stored and quietly do nothing. The controller parses shape only; policy
 * lives in the settings service and the connection gate.
 *
 * No shape here can carry a credential. A provider secret has no settings field and no route in
 * this module — it reaches the encrypted vault through ES.4's connection commands only (plan §4.1).
 */

/**
 * The settings patch: an object of any shape, whose *fields* are enforced by
 * `ESignatureSettingsSchema` in the settings service — that service, not this file, is where an
 * unknown key is refused and a secret-shaped value is rejected.
 */
export const SettingsPatchSchema = z.record(z.string(), z.unknown());

/** The operation the caller asks the gate to admit, as a probe of the security contract. */
export const OperationProbeSchema = z
  .object({
    operation: z.enum([
      'testConnection',
      'listTemplates',
      'templateDetails',
      'prepareEnvelope',
      'sendEnvelope',
      'envelopeStatus',
      'listRecipients',
      'recipientView',
      'resendNotifications',
      'voidEnvelope',
      'correctEnvelope',
      'downloadCompletedDocuments',
      'downloadCompletionEvidence',
      'reconcile',
    ]),
  })
  .strict();
