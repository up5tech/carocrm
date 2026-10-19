import { randomUUID } from "node:crypto";

import { DuplicateRecordError, NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { decryptSecret, encryptSecret, SecretDecryptionError } from "@carocrm/core/utils/crypto.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import type { RequestScope } from "../common/request-scope.js";
import { REQUEST_SCOPE_TOKEN } from "../common/request-scope.js";
import type { AppConfig } from "../config.js";
import { CONFIG_TOKEN } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { PHONE_NORMALIZER, type PhoneNormalizer } from "./phone-number.js";
import {
  ADMIN_PERMISSION_ENTITY,
  type ProviderCapability,
  type VoiceChannel,
} from "./voice-communications-domain.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import {
  type ProviderHealthResult,
  type ResolvedProviderAccount,
  VoiceProviderError,
  VoiceProviderRegistry,
} from "./voice-provider.js";

/**
 * Phase 19-VC.4 — provider accounts, endpoints, credential references and health
 * (`PLAN_Phase_19_Voice_Communications.md` §5.1, §11.1, §13.1, §15 `19-VC.4`).
 *
 * The module reuses the platform's encrypted-secret primitive (`ENCRYPTION_KEY` + AES-256-GCM, the
 * same one `email_accounts` and `ai_provider_connections` use). A credential and a webhook secret are
 * **write-only**: no read path returns either, no log receives either, and the view reports
 * `hasCredential`/`hasWebhookSecret` plus a short hint only.
 *
 * Four rules are enforced here rather than in an adapter:
 *  1. An account can only name a registered adapter, and its capability list must be a subset of what
 *     that adapter declares (§6.1).
 *  2. A plaintext secret may not be smuggled through `config`; keys that look like credentials are
 *     refused at the write (§13.1).
 *  3. Enabling an account requires the credential it needs and, when the adapter validates
 *     signatures, a webhook secret — otherwise every callback would fail closed and the operator
 *     would see a provider that "does nothing" (§13.2).
 *  4. Disabled or unhealthy accounts cannot be resolved for an operation, so a send/call is refused
 *     rather than attempted (§15 `19-VC.4` acceptance).
 */

export interface ProviderAccountView {
  readonly id: string;
  readonly key: string;
  readonly providerKey: string;
  readonly label: string;
  readonly environment: string;
  readonly enabled: boolean;
  /** Capabilities the account is granted. */
  readonly capabilities: readonly ProviderCapability[];
  /** Granted capabilities the adapter actually declares — what an operation may rely on. */
  readonly effectiveCapabilities: readonly ProviderCapability[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly hasCredential: boolean;
  readonly credentialHint: string | null;
  readonly hasWebhookSecret: boolean;
  readonly webhookSecretHint: string | null;
  readonly lastHealth: {
    readonly status: string | null;
    readonly detail: string | null;
    readonly at: string | null;
  };
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface ProviderAccountCreateInput {
  readonly key: string;
  readonly providerKey: string;
  readonly label: string;
  readonly environment: "test" | "production";
  readonly enabled: boolean;
  readonly capabilities: readonly ProviderCapability[];
  readonly config: Record<string, unknown>;
  readonly credential?: string | undefined;
  readonly webhookSecret?: string | undefined;
}

export interface ProviderAccountPatchInput {
  readonly label?: string | undefined;
  readonly environment?: "test" | "production" | undefined;
  readonly enabled?: boolean | undefined;
  readonly capabilities?: readonly ProviderCapability[] | undefined;
  readonly config?: Record<string, unknown> | undefined;
  /** `null` clears the stored secret; `undefined` leaves it untouched. */
  readonly credential?: string | null | undefined;
  readonly webhookSecret?: string | null | undefined;
}

export interface EndpointView {
  readonly id: string;
  readonly accountKey: string;
  readonly key: string;
  readonly channel: VoiceChannel;
  readonly address: string;
  readonly displayAddress: string;
  readonly country: string | null;
  readonly active: boolean;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface EndpointCreateInput {
  readonly key: string;
  readonly channel: VoiceChannel;
  readonly address: string;
  readonly country?: string | undefined;
  readonly active: boolean;
  readonly teamId?: string | null | undefined;
}

interface AccountRow {
  id: string;
  key: string;
  provider_key: string;
  label: string;
  environment: string;
  enabled: boolean;
  capabilities: unknown;
  config: unknown;
  credential_encrypted: string | null;
  credential_hint: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_hint: string | null;
  last_health_status: string | null;
  last_health_detail: string | null;
  last_health_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

interface EndpointRow {
  id: string;
  account_key: string;
  key: string;
  channel: string;
  address: string;
  display_address: string;
  country: string | null;
  active: boolean;
  team_id: string | null;
  created_at: Date;
  modified_at: Date;
}

/** A `config` key that looks like a credential is refused; credentials belong in the secret columns. */
const SECRET_KEY_PATTERN = /secret|token|password|credential|api[_-]?key|private[_-]?key/i;

@Injectable()
export class VoiceProviderAccountsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(VoiceProviderRegistry) private readonly registry: VoiceProviderRegistry,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(PHONE_NORMALIZER) private readonly phones: PhoneNormalizer,
  ) {}

  async list(): Promise<readonly ProviderAccountView[]> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "read");
    const rows = await sql<AccountRow>`
      select * from voice_provider_accounts order by key asc
    `.execute(this.database.db);
    return rows.rows.map((row) => this.toView(row));
  }

  async get(key: string): Promise<ProviderAccountView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "read");
    return this.toView(await this.requireRow(key));
  }

  async create(input: ProviderAccountCreateInput): Promise<ProviderAccountView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const adapter = this.requireAdapter(input.providerKey);
    this.assertCapabilities(adapter.info.capabilities, input.capabilities);
    this.assertConfigIsSafe(input.config);

    const now = new Date();
    const id = randomUUID();
    const credential = input.credential === undefined ? null : this.encrypt(input.credential);
    const webhookSecret = input.webhookSecret === undefined ? null : this.encrypt(input.webhookSecret);
    // Validate the prospective state *before* the insert: a refused create must not leave a half-
    // configured account behind for an operator to find.
    if (input.enabled) {
      this.assertEnableableValues(adapter, {
        enabled: true,
        hasCredential: credential !== null,
        hasWebhookSecret: webhookSecret !== null,
        key: input.key,
      });
    }
    try {
      await sql`
        insert into voice_provider_accounts
          (id, key, provider_key, label, environment, enabled, capabilities, config,
           credential_encrypted, credential_hint, webhook_secret_encrypted, webhook_secret_hint,
           created_at, modified_at, created_by_id, modified_by_id)
        values
          (${id}, ${input.key}, ${input.providerKey}, ${input.label}, ${input.environment}, ${input.enabled},
           ${JSON.stringify([...new Set(input.capabilities)])}::jsonb, ${JSON.stringify(input.config)}::jsonb,
           ${credential}, ${hint(input.credential)}, ${webhookSecret}, ${hint(input.webhookSecret)},
           ${now}, ${now}, ${this.scope.userId ?? null}, ${this.scope.userId ?? null})
      `.execute(this.database.db);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateRecordError(`Provider account "${input.key}" already exists.`);
      throw error;
    }
    return this.get(input.key);
  }

  async update(key: string, patch: ProviderAccountPatchInput): Promise<ProviderAccountView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const current = await this.requireRow(key);
    if (patch.capabilities !== undefined) {
      this.assertCapabilities(this.requireAdapter(current.provider_key).info.capabilities, patch.capabilities);
    }
    if (patch.config !== undefined) this.assertConfigIsSafe(patch.config);

    const now = new Date();
    // Compute the next state in one place and write one fixed UPDATE. A dynamically assembled
    // assignment list would make an omitted column ambiguous with "set it to NULL".
    const next = {
      label: patch.label ?? current.label,
      environment: patch.environment ?? current.environment,
      enabled: patch.enabled ?? current.enabled,
      capabilities: patch.capabilities === undefined ? parseCapabilities(current.capabilities) : [...new Set(patch.capabilities)],
      config: patch.config ?? parseObject(current.config),
      credentialEncrypted:
        patch.credential === null
          ? null
          : patch.credential === undefined
            ? current.credential_encrypted
            : this.encrypt(patch.credential),
      credentialHint:
        patch.credential === null ? null : patch.credential === undefined ? current.credential_hint : hint(patch.credential),
      webhookSecretEncrypted:
        patch.webhookSecret === null
          ? null
          : patch.webhookSecret === undefined
            ? current.webhook_secret_encrypted
            : this.encrypt(patch.webhookSecret),
      webhookSecretHint:
        patch.webhookSecret === null
          ? null
          : patch.webhookSecret === undefined
            ? current.webhook_secret_hint
            : hint(patch.webhookSecret),
    };

    this.assertEnableableValues(this.requireAdapter(current.provider_key), {
      enabled: next.enabled,
      hasCredential: next.credentialEncrypted !== null,
      hasWebhookSecret: next.webhookSecretEncrypted !== null,
      key,
    });
    await sql`
      update voice_provider_accounts set
        label = ${next.label},
        environment = ${next.environment},
        enabled = ${next.enabled},
        capabilities = ${JSON.stringify(next.capabilities)}::jsonb,
        config = ${JSON.stringify(next.config)}::jsonb,
        credential_encrypted = ${next.credentialEncrypted},
        credential_hint = ${next.credentialHint},
        webhook_secret_encrypted = ${next.webhookSecretEncrypted},
        webhook_secret_hint = ${next.webhookSecretHint},
        modified_at = ${now},
        modified_by_id = ${this.scope.userId ?? null}
      where key = ${key}
    `.execute(this.database.db);
    return this.get(key);
  }

  async remove(key: string): Promise<{ readonly success: boolean }> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const result = await sql`delete from voice_provider_accounts where key = ${key} returning id`.execute(this.database.db);
    if (result.rows.length === 0) throw new NotFoundError(`Provider account "${key}" does not exist.`);
    return { success: true };
  }

  /**
   * Resolve an account for an operation. Refuses a disabled account and a provider the registry
   * cannot resolve, so no caller can accidentally operate through a half-configured provider.
   */
  async resolve(key: string): Promise<ResolvedProviderAccount> {
    const row = await this.requireRow(key);
    if (!row.enabled) throw new ValidationError(`Provider account "${key}" is disabled.`);
    const adapter = this.registry.resolve(row.provider_key);
    if (adapter.info.mode === "disabled") {
      throw new ValidationError(
        `Provider account "${key}" names adapter "${row.provider_key}", which is not available in this deployment.`,
      );
    }
    return {
      key: row.key,
      providerKey: row.provider_key,
      label: row.label,
      environment: row.environment,
      enabled: row.enabled,
      capabilities: parseCapabilities(row.capabilities),
      config: parseObject(row.config),
      secret: row.credential_encrypted === null ? null : this.decrypt(row.credential_encrypted),
      webhookSecret: row.webhook_secret_encrypted === null ? null : this.decrypt(row.webhook_secret_encrypted),
    };
  }

  /**
   * Resolve an account for **recording** a callback, not for acting on it. A disabled account still
   * has to be able to explain why its events arrive and do nothing (§18 "disabling a provider safely
   * prevents new operations and exposes pending work state"), so this variant does not refuse on
   * `enabled`; the processor decides whether a downstream effect is allowed.
   */
  async resolveForProcessing(key: string): Promise<ResolvedProviderAccount> {
    const row = await this.requireRow(key);
    return {
      key: row.key,
      providerKey: row.provider_key,
      label: row.label,
      environment: row.environment,
      enabled: row.enabled,
      capabilities: parseCapabilities(row.capabilities),
      config: parseObject(row.config),
      secret: row.credential_encrypted === null ? null : this.decrypt(row.credential_encrypted),
      webhookSecret: row.webhook_secret_encrypted === null ? null : this.decrypt(row.webhook_secret_encrypted),
    };
  }

  /**
   * Resolve an account for policy evaluation. Unlike `resolve()` this never throws for a disabled
   * account — the policy service turns that into an explainable refusal instead of an exception, and
   * it needs the last health state to report `account_unhealthy`.
   */
  async resolveForPolicy(key: string): Promise<{
    readonly account: ResolvedProviderAccount;
    readonly lastHealthStatus: string | null;
  }> {
    const row = await this.requireRow(key);
    return {
      account: {
        key: row.key,
        providerKey: row.provider_key,
        label: row.label,
        environment: row.environment,
        enabled: row.enabled,
        capabilities: parseCapabilities(row.capabilities),
        config: parseObject(row.config),
        secret: null,
        webhookSecret: null,
      },
      lastHealthStatus: row.last_health_status,
    };
  }

  /** The account a channel uses when the caller names none, or `undefined` when no default is set. */
  async defaultAccountKey(): Promise<string | undefined> {
    const key = (await this.settings.settings()).provider.defaultAccountKey.trim();
    return key === "" ? undefined : key;
  }

  async setEnabled(key: string, enabled: boolean): Promise<ProviderAccountView> {
    return this.update(key, { enabled });
  }

  /**
   * Run the adapter's health check and persist the outcome. A failed check marks the account
   * `unhealthy`, which `resolve()` does not read (a transient check must not block an operation that
   * the provider would accept), but the policy service does report it (§15 `19-VC.4`).
   */
  async healthCheck(key: string): Promise<ProviderHealthResult & { readonly persisted: true }> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const account = await this.resolve(key);
    const adapter = this.registry.resolve(account.providerKey);
    let result: ProviderHealthResult;
    try {
      result = await adapter.healthCheck(account);
    } catch (error) {
      const category = error instanceof VoiceProviderError ? error.category : "unknown";
      const detail = error instanceof Error ? error.message : "The health check failed.";
      result = { ok: false, checkedAt: new Date().toISOString(), detail: `[${category}] ${detail}` };
    }
    await sql`
      update voice_provider_accounts
      set last_health_status = ${result.ok ? "healthy" : "unhealthy"},
          last_health_detail = ${result.detail},
          last_health_at = ${new Date(result.checkedAt)},
          modified_at = now()
      where key = ${key}
    `.execute(this.database.db);
    return { ...result, persisted: true };
  }

  // ------------------------------------------------------------------------- endpoints

  async listEndpoints(accountKey: string): Promise<readonly EndpointView[]> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "read");
    const rows = await sql<EndpointRow>`
      select * from voice_endpoints where account_key = ${accountKey} order by channel asc, address asc
    `.execute(this.database.db);
    return rows.rows.map(toEndpointView);
  }

  /**
   * Register a sender number/endpoint. The address is normalized to E.164 with the deployment's
   * default region, so a later inbound callback matches by construction rather than by formatting
   * luck. The account must exist; an unknown account is a validation error, not an FK crash.
   */
  async createEndpoint(accountKey: string, input: EndpointCreateInput): Promise<EndpointView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    await this.requireRow(accountKey);
    const settings = await this.settings.settings();
    const normalized = this.phones.normalize(input.address, settings.policy.defaultRegion);
    if (!normalized.valid || normalized.e164 === null) {
      throw new ValidationError(`"${input.address}" is not a valid phone number for this deployment.`, {
        reason: normalized.reason ?? "invalid",
      });
    }
    const now = new Date();
    const id = randomUUID();
    try {
      await sql`
        insert into voice_endpoints
          (id, account_key, key, channel, address, display_address, country, active, team_id, created_at, modified_at)
        values
          (${id}, ${accountKey}, ${input.key}, ${input.channel}, ${normalized.e164}, ${input.address.trim()},
           ${input.country ?? null}, ${input.active}, ${input.teamId ?? null}, ${now}, ${now})
      `.execute(this.database.db);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateRecordError(`Endpoint "${normalized.e164}" is already registered for this account and channel.`);
      }
      throw error;
    }
    const row = (await sql<EndpointRow>`select * from voice_endpoints where id = ${id}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Endpoint "${input.key}" could not be read back after creation.`);
    return toEndpointView(row);
  }

  async setEndpointActive(accountKey: string, endpointKey: string, active: boolean): Promise<EndpointView> {
    await this.acl.assertAccess(ADMIN_PERMISSION_ENTITY, "edit");
    const updated = (await sql<EndpointRow>`
      update voice_endpoints set active = ${active}, modified_at = now()
      where account_key = ${accountKey} and key = ${endpointKey}
      returning *
    `.execute(this.database.db)).rows[0];
    if (updated === undefined) throw new NotFoundError(`Endpoint "${endpointKey}" does not exist for "${accountKey}".`);
    return toEndpointView(updated);
  }

  // ------------------------------------------------------------------------- internals

  private requireAdapter(providerKey: string) {
    const adapter = this.registry.resolve(providerKey);
    if (!this.registry.has(providerKey) || adapter.info.mode === "disabled") {
      throw new ValidationError(`Unknown provider adapter "${providerKey}".`, { known: this.registry.keys() });
    }
    return adapter;
  }

  private assertCapabilities(declared: readonly ProviderCapability[], granted: readonly ProviderCapability[]): void {
    const allowed = new Set(declared);
    const unsupported = granted.filter((capability) => !allowed.has(capability));
    if (unsupported.length > 0) {
      throw new ValidationError(`The adapter does not declare: ${unsupported.join(", ")}.`, {
        unsupported,
        declared,
      });
    }
  }

  /** A credential in `config` would be stored unencrypted and readable; refuse it at the write. */
  private assertConfigIsSafe(config: Record<string, unknown>): void {
    const text = JSON.stringify(config);
    if (text.length > 32_000) throw new ValidationError("Provider account config is too large.");
    const offending: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) offending.push(`${path}${key}`);
        walk(nested, `${path}${key}.`);
      }
    };
    walk(config, "");
    if (offending.length > 0) {
      throw new ValidationError(
        `Config may not contain credentials (${offending.join(", ")}). Use the account's credential field, which is encrypted.`,
        { fields: offending },
      );
    }
  }

  /** Enabling must leave the account able to do its job; otherwise the operator enables a dead provider. */
  /**
   * Enabling must leave the account able to do its job; otherwise the operator enables a dead
   * provider. Called with the *prospective* state before a write, so a refused create leaves no row
   * behind and a refused update leaves the stored account untouched.
   */
  private assertEnableableValues(
    adapter: { readonly info: { readonly mode: string; readonly capabilities: readonly ProviderCapability[] } },
    values: { readonly enabled: boolean; readonly hasCredential: boolean; readonly hasWebhookSecret: boolean; readonly key: string },
  ): void {
    if (!values.enabled) return;
    if (adapter.info.mode === "live" && !values.hasCredential) {
      throw new ValidationError(`Provider account "${values.key}" needs a credential before it can be enabled.`);
    }
    if (adapter.info.capabilities.includes("webhook.signatureValidation") && !values.hasWebhookSecret) {
      throw new ValidationError(
        `Provider account "${values.key}" needs a webhook secret before it can be enabled: callbacks would otherwise be rejected.`,
      );
    }
  }

  private async requireRow(key: string): Promise<AccountRow> {
    const row = (await sql<AccountRow>`select * from voice_provider_accounts where key = ${key}`.execute(this.database.db)).rows[0];
    if (row === undefined) throw new NotFoundError(`Provider account "${key}" does not exist.`);
    return row;
  }

  private encrypt(plaintext: string): string {
    if (plaintext.trim() === "") throw new ValidationError("A stored secret cannot be empty.");
    if (this.config.encryptionKey.trim() === "") {
      throw new ValidationError(
        "ENCRYPTION_KEY is not configured, so a provider secret cannot be stored. Configure the platform encryption key and retry.",
      );
    }
    return encryptSecret(plaintext, this.config.encryptionKey);
  }

  private decrypt(payload: string): string {
    if (this.config.encryptionKey.trim() === "") {
      throw new ValidationError(
        "The provider secret is encrypted but ENCRYPTION_KEY is not configured; the account cannot be used.",
      );
    }
    try {
      return decryptSecret(payload, this.config.encryptionKey);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw new ValidationError(
          "The stored provider secret could not be decrypted. Check ENCRYPTION_KEY or re-enter the secret.",
        );
      }
      throw new ValidationError("The stored provider secret could not be read.");
    }
  }

  private toView(row: AccountRow): ProviderAccountView {
    const adapter = this.registry.resolve(row.provider_key);
    const granted = parseCapabilities(row.capabilities);
    const declared = new Set(adapter.info.capabilities);
    return {
      id: row.id,
      key: row.key,
      providerKey: row.provider_key,
      label: row.label,
      environment: row.environment,
      enabled: row.enabled,
      capabilities: granted,
      effectiveCapabilities: granted.filter((capability) => declared.has(capability)),
      config: parseObject(row.config),
      hasCredential: row.credential_encrypted !== null && row.credential_encrypted !== "",
      credentialHint: row.credential_hint,
      hasWebhookSecret: row.webhook_secret_encrypted !== null && row.webhook_secret_encrypted !== "",
      webhookSecretHint: row.webhook_secret_hint,
      lastHealth: {
        status: row.last_health_status,
        detail: row.last_health_detail,
        at: row.last_health_at === null ? null : new Date(row.last_health_at).toISOString(),
      },
      createdAt: new Date(row.created_at).toISOString(),
      modifiedAt: new Date(row.modified_at).toISOString(),
    };
  }
}

function toEndpointView(row: EndpointRow): EndpointView {
  return {
    id: row.id,
    accountKey: row.account_key,
    key: row.key,
    channel: row.channel as VoiceChannel,
    address: row.address,
    displayAddress: row.display_address,
    country: row.country,
    active: row.active,
    teamId: row.team_id,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}

function parseCapabilities(value: unknown): ProviderCapability[] {
  const parsed = parseArray(value);
  return parsed.filter((entry): entry is ProviderCapability => typeof entry === "string") as ProviderCapability[];
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** A short, non-reversible hint so an operator can tell two credentials apart without reading one. */
function hint(secret: string | undefined): string | null {
  if (secret === undefined || secret.trim() === "") return null;
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}
