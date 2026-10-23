import { ValidationError } from '@carocrm/core/errors/index.js';
import { deepMerge, isObject } from '@carocrm/core/utils/object.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { type AppConfig, CONFIG_TOKEN } from '../config.js';
import { CRM_CHAT_MENU_INVALIDATOR, type MenuInvalidator } from '../crm-chat/index.js';
import { DatabaseService } from '../database/database.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import {
  DOCUSIGN_INTEGRATION_KEY_ENV_VARS,
  ESIGNATURE_FEATURES,
  ESIGNATURE_SETTINGS_KEY,
  ESIGNATURE_SETTINGS_VERSION,
  PENDING_FEATURES,
} from './esignature-module.js';

/**
 * Phase 19-ES.1 — the module's settings and security policy
 * (`PLAN_Phase_19_ESignature.md` §4.1, §11.1, §12, §18 `19-ES.1`).
 *
 * The platform already owns instance settings (`app_settings`), so this module keeps **one**
 * validated, versioned row named `ESignature` there — the same shape as
 * `VoiceCommunicationsSettingsService` and `AdvancedIntegrationsSettingsService`.
 *
 * Rule followed here: **only settings that have an actual consumer, or whose consumer is the phase
 * the plan sequences next** (each pending flag is named in `PENDING_FEATURES` and reported as
 * pending, never as working). And one rule the plan is emphatic about:
 *
 * **No secret is ever a field of this document.** Client secrets, refresh tokens and the Connect
 * HMAC secret live only in the encrypted credential vault (`integration_credential_secrets` keyed
 * by `ENCRYPTION_KEY`, audit §1). What may be stored here is a *public* OAuth integration key — a
 * client id, which is not a secret — because it must be visible to an administrator and stable
 * across the OAuth redirect. `ENCRYPTION_KEY` is named, never valued (plan §21).
 *
 * Everything with an external side effect defaults **off**: a fresh installation has no connection,
 * so nothing can be sent, and the module says so instead of pretending the flag would work.
 */

/** A conservative default document allowlist; an extension is not a MIME type check (plan §4.5, §12.9). */
export const DEFAULT_ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx'] as const;

const ExtensionSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]{1,10}$/i, 'An extension is alphanumeric, without the leading dot.')
  .transform((value) => value.toLowerCase());

const EntityNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Za-z0-9]*$/, 'A source entity is named by its metadata entity id, e.g. "Quote".');

/** A metadata field name an approval rule may read. Validated against the registry on save. */
const ApprovalFieldSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'A field is a metadata field name.');

export const APPROVAL_RULE_OPERATORS = ['equals', 'not_equals', 'gte', 'lte', 'contains'] as const;
export type ApprovalRuleOperator = (typeof APPROVAL_RULE_OPERATORS)[number];

/**
 * One value/risk rule of the approval policy (ES.17).
 *
 * A rule is deliberately *data*, never an expression: it names a metadata source entity, one field,
 * a closed operator set and a literal. The policy engine evaluates it in TypeScript; nothing is
 * interpolated into SQL or evaluated as code (AGENTS.md §5.2). `gte`/`lte` cover monetary thresholds,
 * `equals`/`not_equals` cover contract types and risk levels, and `contains` covers categories.
 */
export const ApprovalRuleSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    sourceEntityType: EntityNameSchema,
    field: ApprovalFieldSchema,
    operator: z.enum(APPROVAL_RULE_OPERATORS),
    value: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((rule, context) => {
    if ((rule.operator === 'gte' || rule.operator === 'lte') && !Number.isFinite(Number(rule.value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${rule.operator}" operator needs a numeric value.`,
      });
    }
  });
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const ESignatureSettingsSchema = z
  .object({
    /**
     * The module switch. `false` is the clean "unconfigured" answer: the page leaves the sidebar and
     * every provider operation is refused, while stored requests, events and audit rows stay readable
     * to an authorized user (plan §18 acceptance "disabled cleanly when unconfigured").
     */
    enabled: z.boolean().default(false),
    features: z
      .object({
        /** The request workspace itself (ES.6). Off until the tables and CRUD exist. */
        requests: z.boolean().default(false),
        /** The provider connection control plane (ES.4). */
        connections: z.boolean().default(false),
        /** Attaching CRM attachments as signature documents (ES.5). */
        documents: z.boolean().default(false),
        /** Provider templates and role mappings (ES.7). */
        templates: z.boolean().default(false),
        /** The deliberate external act of sending (ES.10). */
        send: z.boolean().default(false),
        /** DocuSign Connect intake (ES.11). */
        webhooks: z.boolean().default(false),
        /** Embedded signing (ES.14). Plan §4.6: off until an administrator configures it. */
        embeddedSigning: z.boolean().default(false),
        /** Completed documents and completion evidence (ES.15). */
        artifacts: z.boolean().default(false),
        /** Approval required before send (ES.17). */
        approvals: z.boolean().default(false),
      })
      .strict()
      .default({}),
    provider: z
      .object({
        /**
         * The DocuSign integration key (OAuth **client** id) for the demo/developer environment.
         * Public by nature, and never the client secret. Read from
         * `DOCUSIGN_DEMO_INTEGRATION_KEY` when that variable is set (ES.0 audit §8, decided here).
         */
        demoIntegrationKey: z.string().trim().max(128).default(''),
        /** The same for the production environment; a distinct client id, never switched silently. */
        productionIntegrationKey: z.string().trim().max(128).default(''),
      })
      .strict()
      .default({}),
    documents: z
      .object({
        /** Ceiling for one document's raw bytes, enforced against the attachment row before upload. */
        maxDocumentBytes: z.number().int().min(1_024).max(104_857_600).default(26_214_400),
        maxDocumentsPerRequest: z.number().int().min(1).max(25).default(5),
        allowedExtensions: z.array(ExtensionSchema).min(1).max(20).default([...DEFAULT_ALLOWED_EXTENSIONS]),
      })
      .strict()
      .default({}),
    signing: z
      .object({
        /** Days until an envelope expires when the sender names no date (plan §13.3 options step). */
        defaultExpiryDays: z.number().int().min(1).max(120).default(30),
        /** Whether the reminder action is offered at all (ES.16 policy). */
        remindersEnabled: z.boolean().default(false),
        /**
         * How long after a reminder the same request must wait before another (ES.16 rate policy).
         * `0` disables the cooldown; the default is a deliberate friction against reminder spam.
         */
        resendCooldownMinutes: z.number().int().min(0).max(1_440).default(5),
        /**
         * Hosts an embedded-signing `returnUrl`/`cancelUrl` may point at (plan §4.6, §12.7).
         * Empty means embedded signing cannot produce a view even when the flag is on — a return URL
         * outside an allowlist is an open redirect with a live signing session attached.
         */
        embeddedReturnHosts: z.array(z.string().trim().toLowerCase().max(253)).max(20).default([]),
      })
      .strict()
      .default({}),
    webhooks: z
      .object({
        /** The HTTPS endpoint an administrator registers in DocuSign Connect for this installation. */
        endpointUrl: z.string().trim().url().max(500).or(z.literal('')).default(''),
        /**
         * Whether a Connect delivery must carry the account's HMAC signature to be accepted.
         * Left `true`, because an unsigned event is a request to change a contract's state. Turning it
         * off is only ever a debugging choice on a non-production connection, and the health report
         * warns while it is off.
         */
        requireHmac: z.boolean().default(true),
        /** Durable inbox body limit; a Connect payload is small and a bigger one is refused. */
        maxPayloadBytes: z.number().int().min(1_024).max(2_097_152).default(262_144),
      })
      .strict()
      .default({}),
    retention: z
      .object({
        /** Days the minimized raw webhook payload is kept; `0` keeps none beyond the dedup key. */
        webhookPayloadDays: z.number().int().min(0).max(3_650).default(90),
        /**
         * Days the signed documents and completion evidence are kept. `0` means "no automatic
         * deletion" — plan §12.1 forbids dropping the evidence artifact on a default.
         */
        completedArtifactDays: z.number().int().min(0).max(3_650).default(0),
      })
      .strict()
      .default({}),
    approval: z
      .object({
        /**
         * Source entity types whose requests require an approval before they may be sent (plan §11.1).
         * The policy is read by ES.17; an empty list means no source type requires approval.
         */
        requiredForSourceEntities: z.array(EntityNameSchema).max(30).default([]),
        /** Value/risk rules evaluated against the linked source record (plan §11.1). */
        rules: z.array(ApprovalRuleSchema).max(30).default([]),
        /**
         * Separation of duties (ES.17): the person who created or prepared a request may not decide
         * its approval. On by default; a small installation can deliberately turn it off, and the
         * setting is audited with the decision.
         */
        preventSelfApproval: z.boolean().default(true),
      })
      .strict()
      .default({}),
    /**
     * Instance-specific environment guidance, reported by the health endpoint. It is a note, not a
     * switch: `sysAdmin` only may change it, and it never unlocks a capability.
     */
    environmentLabel: z.string().trim().max(60).default(''),
  })
  .strict();

export type ESignatureSettings = z.infer<typeof ESignatureSettingsSchema>;

export const DEFAULT_ESIGNATURE_SETTINGS: ESignatureSettings = ESignatureSettingsSchema.parse({});

export interface SettingsWarning {
  readonly code: string;
  readonly message: string;
}

/** Advisory findings about the settings as they stand; they refuse nothing but say what is missing. */
export function settingsWarnings(settings: ESignatureSettings): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  if (!settings.enabled && Object.values(settings.features).some((enabled) => enabled === true)) {
    warnings.push({
      code: 'disabledWithFeatures',
      message: 'Individual features are switched on while the module itself is off, so nothing runs. Turn the module switch on, or clear the features.',
    });
  }
  for (const feature of ESIGNATURE_FEATURES) {
    const enabled = (settings.features as unknown as Record<string, boolean>)[feature.key] === true;
    if (!enabled) continue;
    const pending = PENDING_FEATURES.find((entry) => entry.key === feature.key);
    if (pending !== undefined) {
      warnings.push({
        code: `pending:${feature.key}`,
        message: `The "${feature.key}" feature is enabled but its infrastructure is delivered in phase ${pending.phase}; nothing will run yet.`,
      });
    }
    for (const requirement of feature.requires) {
      if ((settings.features as unknown as Record<string, boolean>)[requirement] !== true) {
        warnings.push({
          code: `requires:${feature.key}`,
          message: `"${feature.key}" is enabled but the feature it depends on, "${requirement}", is not; it will do nothing on its own.`,
        });
      }
    }
  }
  if (settings.features.embeddedSigning && settings.signing.embeddedReturnHosts.length === 0) {
    warnings.push({
      code: 'embeddedNoReturnHosts',
      message:
        'Embedded signing is enabled but no return-host allowlist is configured, so no recipient view can be generated. Add the CRM host before enabling the flow.',
    });
  }
  if (!settings.webhooks.requireHmac) {
    warnings.push({
      code: 'webhookHmacNotRequired',
      message:
        'DocuSign Connect deliveries are accepted without verifying the account HMAC signature. Any caller could move a contract state; turn this back on outside a deliberate debugging session.',
    });
  }
  if (settings.features.connections && settings.provider.demoIntegrationKey.trim() === '' && settings.provider.productionIntegrationKey.trim() === '') {
    warnings.push({
      code: 'noIntegrationKey',
      message:
        'Connections are enabled but neither a demo nor a production DocuSign integration key is configured, so no connection can be authorized.',
    });
  }
  if (
    settings.features.approvals &&
    settings.approval.requiredForSourceEntities.length === 0 &&
    settings.approval.rules.length === 0
  ) {
    warnings.push({
      code: 'approvalsNoPolicy',
      message:
        'Approvals are enabled but no source type or value rule requires one. Only an explicit "request approval" action will use the workflow.',
    });
  }
  return warnings;
}

export interface ESignatureSettingsView {
  readonly settings: ESignatureSettings;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly defaults: ESignatureSettings;
  readonly warnings: readonly SettingsWarning[];
  /** Feature keys whose implementation lands in a later sub-phase, with that phase. */
  readonly pendingFeatures: readonly { readonly key: string; readonly phase: string }[];
  /** Whether a feature is both enabled and implemented — what the UI and the gates read. */
  readonly effective: Record<string, boolean>;
  /** Environment variable names an operator may use instead of typing an integration key here. */
  readonly integrationKeyEnvVars: readonly string[];
}

interface StoredSettings {
  version?: unknown;
  settings?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

@Injectable()
export class ESignatureSettingsService {
  private cache: ESignatureSettingsView | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    // The platform's menu-cache invalidator, the same seam `CRMChatSettingsService` uses. Reused
    // rather than duplicated: one token, one navigation cache, and a module switch that leaves the
    // sidebar on the next render instead of after the TTL.
    @Inject(CRM_CHAT_MENU_INVALIDATOR) private readonly invalidateMenu: MenuInvalidator,
    // Approval rules name metadata entities and fields; validating them against the live registry
    // stops a typo from silently creating a policy that never matches (ES.17).
    @Optional() @Inject(METADATA_STORE) private readonly metadata?: MetadataStoreService,
  ) {}

  /**
   * Whether the platform key that protects every provider credential is configured.
   *
   * The only `ENCRYPTION_KEY` fact this module reports: its presence. Its value is never read,
   * logged or returned anywhere (plan §21).
   */
  encryptionConfigured(): boolean {
    return this.config.encryptionKey.trim() !== '';
  }

  /** Validated settings for behaviour paths; defaults when the row is absent. */
  async settings(): Promise<ESignatureSettings> {
    return (await this.read()).settings;
  }

  async read(): Promise<ESignatureSettingsView> {
    if (this.cache !== undefined) return this.cache;
    const row = await this.database.db
      .selectFrom('app_settings')
      .select('data')
      .where('name', '=', ESIGNATURE_SETTINGS_KEY)
      .executeTakeFirst();
    this.cache = toView(row?.data);
    return this.cache;
  }

  /**
   * The effective DocuSign integration key (OAuth **client** id) for one environment — ES.4's single
   * read path.
   *
   * The stored document is the only source. An operator may keep it in the deployment environment
   * instead (see `DOCUSIGN_INTEGRATION_KEY_ENV_VARS`), which ES.4 reads while creating a connection;
   * nothing here can read a process environment it was not given, and the result is a **public
   * client id** — the matching secret is only ever in the vault.
   */
  integrationKey(settings: ESignatureSettings, environment: 'demo' | 'production'): string {
    return environment === 'demo'
      ? settings.provider.demoIntegrationKey.trim()
      : settings.provider.productionIntegrationKey.trim();
  }

  /** Whether a feature gate is on *and* implemented; a pending flag is never an effective one. */
  async featureEnabled(key: string): Promise<boolean> {
    const view = await this.read();
    return view.effective[key] === true;
  }

  /**
   * Apply a validated patch. Unknown keys are refused — a typo in a feature name must not be stored
   * and quietly ignored — and every accepted change bumps the settings version, so a send can be
   * audited against the policy that was in force at the time (plan §6.6, §11.2).
   *
   * A secret-shaped value is refused here as well, so an admin screen cannot accidentally send one
   * into a plain settings row: the vault is the only write path for a credential (plan §4.1).
   */
  async update(patch: unknown): Promise<ESignatureSettingsView> {
    if (!isObject(patch)) {
      throw new ValidationError('ESignature settings must be an object.');
    }
    this.refuseSecretSizedValues(patch);
    const current = await this.read();
    const merged = deepMerge(current.settings as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    const parsed = ESignatureSettingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new ValidationError('Invalid ESignature settings.', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    this.assertApprovalPolicyTargets(parsed.data);
    const stored: StoredSettings = {
      version: current.version + 1,
      settings: parsed.data,
      updatedAt: new Date().toISOString(),
      updatedBy: this.scope.principal?.userName ?? this.scope.userId ?? null,
    };
    await writeRow(this.database, stored);
    this.cache = toView(stored);
    // The menu is cached per user for 30 s; switching the module off must remove its entry now, not
    // after the window (`docs/admin/navigation.md`).
    this.invalidateMenu();
    return this.cache;
  }

  /** Only tests and explicit reloads call this; the row cache is otherwise write-through. */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * A policy that names a nonexistent entity or field is refused, not stored.
   *
   * The alternative — accepting it — would leave an administrator believing a rule protects a
   * category it can never match. The metadata registry is the authority; an optional module must be
   * installed before its fields can be named here (the integration is verified at save time).
   */
  private assertApprovalPolicyTargets(settings: ESignatureSettings): void {
    const registry = this.metadata?.registry;
    if (registry === undefined) return;
    for (const entityType of settings.approval.requiredForSourceEntities) {
      if (!registry.hasEntity(entityType)) {
        throw new ValidationError(`The approval policy names "${entityType}", which is not a metadata entity.`, {
          sourceEntityType: entityType,
        });
      }
    }
    for (const rule of settings.approval.rules) {
      if (!registry.hasEntity(rule.sourceEntityType)) {
        throw new ValidationError(`The approval rule "${rule.label}" names "${rule.sourceEntityType}", which is not a metadata entity.`, {
          rule: rule.label,
          sourceEntityType: rule.sourceEntityType,
        });
      }
      if (registry.getField(rule.sourceEntityType, rule.field) === undefined) {
        throw new ValidationError(`The approval rule "${rule.label}" names a field "${rule.field}" that "${rule.sourceEntityType}" does not have.`, {
          rule: rule.label,
          sourceEntityType: rule.sourceEntityType,
          field: rule.field,
        });
      }
    }
  }

  /**
   * A value too long or too dense to be a client id is treated as a credential attempt and refused.
   * This is a guard against a mistaken admin action, not a parser: the vault remains the only place
   * a secret can go.
   */
  private refuseSecretSizedValues(patch: Record<string, unknown>): void {
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (value.length > 512) {
          throw new ValidationError(`"${path || 'settings'}" is too long to be a configuration value; a secret belongs in the credential vault.`, {
            path,
          });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
        return;
      }
      if (isObject(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          // A whole word-segment, not a substring: `requireHmac` is a policy switch, `hmacSecret` is
          // a credential. Matching the substring would refuse the first and be the only field name
          // the plan tells the administrator to keep on.
          if (key.split(/[_\-.]/).some((segment) => /^(client)?secret|secret$|token|password|privatekey|keymaterial$|hmac$|signature$/.test(segment))) {
            throw new ValidationError(`"${path ? `${path}.` : ''}${key}" is not a settings field: provider secrets live only in the encrypted credential vault.`, {
              path: `${path ? `${path}.` : ''}${key}`,
            });
          }
          walk(child, path ? `${path}.${key}` : key);
        }
      }
    };
    walk(patch, '');
  }
}

async function writeRow(database: DatabaseService, stored: StoredSettings): Promise<void> {
  const data = JSON.stringify(stored);
  const now = new Date();
  await database.db
    .insertInto('app_settings')
    .values({ name: ESIGNATURE_SETTINGS_KEY, data, modified_at: now })
    .onConflict((oc) => oc.column('name').doUpdateSet({ data, modified_at: now }))
    .execute();
}

function toView(data: unknown): ESignatureSettingsView {
  const stored = isObject(data) ? (data as StoredSettings) : {};
  const parsed = ESignatureSettingsSchema.safeParse(stored.settings ?? {});
  // A stored row that no longer satisfies the schema (an upgrade changed a default) falls back to
  // defaults for the invalid parts instead of refusing to boot — the health endpoint reports what it found.
  const settings = parsed.success ? parsed.data : DEFAULT_ESIGNATURE_SETTINGS;
  const storedVersion = typeof stored.version === 'number' && Number.isInteger(stored.version) ? stored.version : 0;
  const effective: Record<string, boolean> = {};
  for (const feature of ESIGNATURE_FEATURES) {
    const enabled = settings.enabled === true && (settings.features as unknown as Record<string, boolean>)[feature.key] === true;
    const implemented = PENDING_FEATURES.every((pending) => pending.key !== feature.key);
    const requirementsMet = feature.requires.every((requirement) => {
      const dependencyImplemented = PENDING_FEATURES.every((pending) => pending.key !== requirement);
      return (settings.features as unknown as Record<string, boolean>)[requirement] === true && dependencyImplemented;
    });
    effective[feature.key] = enabled && implemented && requirementsMet;
  }
  return {
    settings,
    version: storedVersion,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    defaults: DEFAULT_ESIGNATURE_SETTINGS,
    warnings: [
      ...settingsWarnings(settings),
      ...(storedVersion !== 0 && storedVersion < ESIGNATURE_SETTINGS_VERSION
        ? [{ code: 'shapeVersion', message: `The stored settings are shape ${String(storedVersion)}; this build writes shape ${String(ESIGNATURE_SETTINGS_VERSION)}.` }]
        : []),
    ],
    pendingFeatures: PENDING_FEATURES,
    effective,
    integrationKeyEnvVars: [...DOCUSIGN_INTEGRATION_KEY_ENV_VARS],
  };
}
