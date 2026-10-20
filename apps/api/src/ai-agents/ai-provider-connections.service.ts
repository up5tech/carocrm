import { randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { decryptSecret, encryptSecret, SecretDecryptionError } from '@carocrm/core/utils/crypto.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import type { AIProviderConnectionsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DataClass } from './ai-agents-module.js';
import { type AIProviderAdapter, type AIProviderAuthHeader, AIProviderError, AIProviderRegistry } from './ai-provider.js';
import { assertSafeProviderBaseUrl } from './ai-provider-url.js';
import {
  ProviderConnectionConfigSchema,
  type ProviderConnectionCreateInput,
  type ProviderConnectionPatchInput,
} from './dto/ai-agents-shapes.js';

/**
 * Phase 19-AI.4 — provider connections and credential storage
 * (PLAN_Phase_19_AI_Agents.md §6.2, §6.3, §14.4, §20 `19-AI.4`).
 *
 * The module reuses the platform's encrypted-secret primitive (`ENCRYPTION_KEY` + AES-256-GCM, the
 * same one `email_accounts` uses). A provider key is **write-only**: no read path returns it, no log
 * receives it and the diagnostics report `hasApiKey` only.
 *
 * Three rules are enforced here rather than in the adapter:
 *
 *  1. A connection can only name a registered, non-production adapter.
 *  2. Its `baseUrl` passes the SSRF check on every save and again inside the gateway.
 *  3. The model list is a real allowlist — an agent cannot ask a connection for an unlisted model.
 *
 * No API key is ever stored in an agent definition, run, event or tool argument.
 */

export interface ProviderConnectionView {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly dataClasses: readonly DataClass[];
  readonly hasApiKey: boolean;
  readonly config: {
    readonly allowLoopback: boolean;
    readonly organization?: string | undefined;
    readonly authHeader: AIProviderAuthHeader;
  };
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface ResolvedProviderConnection {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly dataClasses: readonly DataClass[];
  readonly apiKey: string | null;
  readonly config: {
    readonly allowLoopback: boolean;
    readonly organization?: string | undefined;
    readonly authHeader: AIProviderAuthHeader;
  };
}

@Injectable()
export class AIProviderConnectionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(AIProviderRegistry) private readonly registry: AIProviderRegistry,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async list(): Promise<readonly ProviderConnectionView[]> {
    // Listing provider configuration is itself an administrative capability; the controller checks
    // it, and this service re-checks so a future internal caller cannot bypass the gate.
    await this.acl.assertAccess('AIAgentProvider', 'edit');
    const rows = await this.database.db
      .selectFrom('ai_provider_connections')
      .selectAll()
      .orderBy('key', 'asc')
      .execute();
    return rows.map(toView);
  }

  async get(key: string): Promise<ProviderConnectionView> {
    await this.acl.assertAccess('AIAgentProvider', 'edit');
    const row = await this.requireRow(key);
    return toView(row);
  }

  async create(input: ProviderConnectionCreateInput): Promise<ProviderConnectionView> {
    await this.acl.assertAccess('AIAgentProvider', 'edit');
    this.assertAdapterAvailable(input.kind);
    this.assertModels(input.models);
    const safe = await assertSafeProviderBaseUrl(input.baseUrl, { allowLoopback: input.config.allowLoopback });
    const apiKey = input.apiKey === undefined ? null : this.encrypt(input.apiKey);
    const now = new Date();
    const id = randomUUID();
    try {
      await this.database.db
        .insertInto('ai_provider_connections')
        .values({
          id,
          key: input.key,
          kind: input.kind,
          label: input.label,
          base_url: safe.url.toString(),
          models: JSON.stringify(unique(input.models)),
          data_classes: JSON.stringify(unique(input.dataClasses)),
          api_key_encrypted: apiKey,
          config: JSON.stringify(input.config),
          enabled: input.enabled,
          created_at: now,
          modified_at: now,
          created_by_id: this.scope.userId ?? null,
          modified_by_id: this.scope.userId ?? null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateRecordError(`Provider connection "${input.key}" already exists.`);
      }
      throw error;
    }
    return toView(await this.requireRow(input.key));
  }

  async update(key: string, patch: ProviderConnectionPatchInput): Promise<ProviderConnectionView> {
    await this.acl.assertAccess('AIAgentProvider', 'edit');
    const current = await this.requireRow(key);
    const currentConfig = configOf(current);
    const nextConfig = patch.config ?? currentConfig;
    const nextBaseUrl = patch.baseUrl ?? current.base_url;
    const safe = await assertSafeProviderBaseUrl(nextBaseUrl, { allowLoopback: nextConfig.allowLoopback });
    if (patch.models !== undefined) this.assertModels(patch.models);

    const now = new Date();
    const set: Partial<AIProviderConnectionsTable> = {
      base_url: safe.url.toString(),
      config: JSON.stringify(nextConfig),
      modified_at: now,
      modified_by_id: this.scope.userId ?? null,
    };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.models !== undefined) set.models = JSON.stringify(unique(patch.models));
    if (patch.dataClasses !== undefined) set.data_classes = JSON.stringify(unique(patch.dataClasses));
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.apiKey === null) set.api_key_encrypted = null;
    else if (patch.apiKey !== undefined) set.api_key_encrypted = this.encrypt(patch.apiKey);

    await this.database.db.updateTable('ai_provider_connections').set(set).where('key', '=', key).execute();
    return toView(await this.requireRow(key));
  }

  async remove(key: string): Promise<{ readonly success: boolean }> {
    await this.acl.assertAccess('AIAgentProvider', 'edit');
    try {
      const result = await this.database.db
        .deleteFrom('ai_provider_connections')
        .where('key', '=', key)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw new NotFoundError(`Provider connection "${key}" does not exist.`);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ValidationError(
          `Provider connection "${key}" is referenced by a published agent version and cannot be removed. Disable it instead.`,
        );
      }
      throw error;
    }
    return { success: true };
  }

  /**
   * Internal resolution for the gateway. The secret is decrypted here, kept in memory for the call
   * and never included in a returned view or an error.
   */
  async resolve(key: string): Promise<ResolvedProviderConnection> {
    const row = await this.requireRow(key);
    if (!row.enabled) {
      throw new ValidationError(`Provider connection "${key}" is disabled.`);
    }
    const apiKey = row.api_key_encrypted === null ? null : this.decrypt(row.api_key_encrypted);
    return {
      key: row.key,
      kind: row.kind,
      label: row.label,
      baseUrl: row.base_url,
      models: parseStringArray(row.models),
      dataClasses: parseDataClasses(row.data_classes),
      apiKey,
      config: configOf(row),
    };
  }

  adapterFor(kind: string): AIProviderAdapter {
    this.assertAdapterAvailable(kind);
    return this.registry.get(kind);
  }

  private assertAdapterAvailable(kind: string): void {
    if (kind === 'fake' && process.env.NODE_ENV === 'production') {
      throw new ValidationError('The fake provider is only available outside production.');
    }
    if (!this.registry.has(kind)) {
      throw new ValidationError(`Unknown provider adapter "${kind}".`, { known: this.registry.keys() });
    }
  }

  private assertModels(models: readonly string[]): void {
    if (models.length === 0) throw new ValidationError('A provider connection must allow at least one model.');
    if (unique(models).length === 0) throw new ValidationError('A provider connection must allow at least one model.');
  }

  private encrypt(plaintext: string): string {
    if (this.config.encryptionKey.trim() === '') {
      throw new ValidationError(
        'ENCRYPTION_KEY is not configured, so a provider credential cannot be stored. Configure the platform encryption key and retry.',
      );
    }
    return encryptSecret(plaintext, this.config.encryptionKey);
  }

  private decrypt(payload: string): string {
    if (this.config.encryptionKey.trim() === '') {
      throw new AIProviderError(
        'auth',
        'The provider credential is encrypted but ENCRYPTION_KEY is not configured; the connection cannot be used.',
      );
    }
    try {
      return decryptSecret(payload, this.config.encryptionKey);
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        throw new AIProviderError(
          'auth',
          'The stored provider credential could not be decrypted. Check ENCRYPTION_KEY or re-enter the credential.',
        );
      }
      throw new AIProviderError('auth', 'The stored provider credential could not be read.');
    }
  }

  private async requireRow(key: string): Promise<AIProviderConnectionsTable> {
    const row = await this.database.db
      .selectFrom('ai_provider_connections')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Provider connection "${key}" does not exist.`);
    return row;
  }
}

function toView(row: AIProviderConnectionsTable): ProviderConnectionView {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    label: row.label,
    baseUrl: row.base_url,
    models: parseStringArray(row.models),
    dataClasses: parseDataClasses(row.data_classes),
    hasApiKey: row.api_key_encrypted !== null && row.api_key_encrypted !== '',
    config: configOf(row),
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    modifiedAt: new Date(row.modified_at).toISOString(),
  };
}

function configOf(row: AIProviderConnectionsTable): {
  allowLoopback: boolean;
  organization?: string | undefined;
  authHeader: AIProviderAuthHeader;
} {
  const parsed = ProviderConnectionConfigSchema.safeParse(row.config);
  if (!parsed.success) return { allowLoopback: false, authHeader: 'bearer' };
  return {
    allowLoopback: parsed.data.allowLoopback,
    ...(parsed.data.organization === undefined ? {} : { organization: parsed.data.organization }),
    authHeader: parsed.data.authHeader,
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseDataClasses(value: unknown): DataClass[] {
  const allowed = new Set<DataClass>(['public', 'internal', 'confidential', 'restricted']);
  return parseStringArray(value).filter((entry): entry is DataClass => allowed.has(entry as DataClass));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}
