import { randomUUID } from 'node:crypto';

import { DuplicateRecordError, NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Updateable } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AIAgentsTable, AIAgentToolGrantsTable, AIAgentVersionsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import {
  type AgentConfig,
  agentConfigChecksum,
  type AgentConfigIssue,
  parseAgentConfig,
  publicationConfigIssues,
} from './ai-agent-config.js';
import type { AIToolDefinition } from './ai-agent-tools.js';
import { AIToolRegistry } from './ai-agent-tools.js';
import { AGENT_STATUSES, type AgentStatus } from './ai-agents-module.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';

/**
 * Phase 19-AI.5 — agent definitions and immutable versions
 * (PLAN_Phase_19_AI_Agents.md §5.1–§5.3, §20 `19-AI.5`).
 *
 * Two rules shape every method here:
 *
 *  1. **A published version is a snapshot.** Publication copies the validated draft into
 *     `ai_agent_versions` with a checksum; later edits touch `ai_agents.draft_config` only, so a run
 *     that resolved version 3 keeps reading version 3.
 *  2. **Visibility is enforced on the server.** A caller who is not the owner, not in the owning
 *     team and not an administrator does not learn that a private/team agent exists: the read
 *     answers 404, exactly like a missing record (AGENTS.md §5.3).
 *
 * Draft saving validates the strict configuration shape and its bounds. Publication additionally
 * validates everything a run depends on — provider, model, data class, tool grants, limits, output
 * schema — and returns a report distinguishing blocking findings from warnings.
 */

export interface AgentListQuery {
  readonly offset?: number | undefined;
  readonly maxSize?: number | undefined;
  readonly status?: AgentStatus | undefined;
  readonly q?: string | undefined;
  readonly scope?: 'mine' | 'all' | undefined;
}

export interface AgentToolView {
  readonly key: string;
  readonly label: string;
  readonly effectClass: string;
  readonly requiresApproval: boolean;
  readonly enabled: boolean;
}

export interface AgentVersionView {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly providerKey: string | null;
  readonly model: string | null;
  readonly publishedById: string | null;
  readonly publishedAt: string;
  readonly note: string | null;
  readonly tools: readonly AgentToolView[];
}

export interface AgentVersionDetail extends AgentVersionView {
  readonly config: AgentConfig;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly approvalPolicy: Readonly<Record<string, unknown>>;
  readonly memoryPolicy: Readonly<Record<string, unknown>>;
  readonly triggerPolicy: Readonly<Record<string, unknown>>;
  readonly outputSchema: unknown;
}

export interface AgentCapabilitiesView {
  readonly editDraft: boolean;
  readonly publish: boolean;
  readonly lifecycle: boolean;
  readonly run: boolean;
}

export interface AgentView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly purpose: string | null;
  readonly category: string | null;
  readonly icon: string | null;
  readonly visibility: string;
  readonly teamId: string | null;
  readonly ownerUserId: string | null;
  readonly status: AgentStatus;
  readonly dataSensitivity: string;
  readonly currentVersion: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly draftConfig: AgentConfig;
  readonly configIssues: readonly AgentConfigIssue[];
  readonly inputHint: string | null;
  readonly tools: readonly AgentToolView[];
  readonly capabilities: AgentCapabilitiesView;
  readonly latestVersion: AgentVersionView | null;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface AgentValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly blocking: boolean;
}

export interface AgentValidationCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface AgentValidationReport {
  readonly ok: boolean;
  readonly issues: readonly AgentValidationIssue[];
  readonly checks: readonly AgentValidationCheck[];
}

export interface CreateAgentInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly purpose?: string | undefined;
  readonly category?: string | undefined;
  readonly icon?: string | undefined;
  readonly visibility?: 'private' | 'team' | 'organization' | undefined;
  readonly teamId?: string | null | undefined;
  readonly config: unknown;
}

export interface UpdateAgentInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly purpose?: string | null | undefined;
  readonly category?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly visibility?: 'private' | 'team' | 'organization' | undefined;
  readonly teamId?: string | null | undefined;
  readonly config?: unknown;
}

interface ResolvedGrant {
  readonly key: string;
  readonly tool: AIToolDefinition;
  readonly requiresApproval: boolean;
  readonly constraints: Record<string, unknown>;
}

@Injectable()
export class AIAgentDefinitionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIAgentsPolicyService) private readonly policy: AIAgentsPolicyService,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(AIProviderConnectionService) private readonly connections: AIProviderConnectionService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async list(query: AgentListQuery = {}): Promise<{
    list: AgentView[];
    total: number;
    offset: number;
    count: number;
  }> {
    await this.permissions.assert('use');
    await this.policy.assertDefinitionsEnabled();
    const offset = Math.max(0, query.offset ?? 0);
    const maxSize = Math.min(50, Math.max(1, query.maxSize ?? 20));
    const viewer = await this.viewer();

    let builder = this.database.db.selectFrom('ai_agents').where('is_deleted', '=', false);
    if (query.status !== undefined) builder = builder.where('status', '=', query.status);
    if (query.q !== undefined && query.q.trim() !== '') {
      const term = `%${query.q.trim().replace(/[%_]/g, '')}%`;
      builder = builder.where((eb) => eb.or([eb('name', 'ilike', term), eb('agent_key', 'ilike', term)]));
    }
    if (query.scope === 'mine') {
      builder = builder.where('owner_user_id', '=', viewer.userId);
    } else if (!viewer.seesEverything) {
      builder = builder.where((eb) => {
        const clauses = [eb('visibility', '=', 'organization'), eb('owner_user_id', '=', viewer.userId)];
        if (viewer.teamIds.length > 0) clauses.push(eb('team_id', 'in', viewer.teamIds));
        return eb.or(clauses);
      });
    }

    const totalRow = await builder.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
    const rows = await builder
      .selectAll()
      .orderBy('modified_at', 'desc')
      .offset(offset)
      .limit(maxSize)
      .execute();
    const list = await Promise.all(rows.map((row) => this.toView(row, viewer)));
    return {
      list,
      total: Number(totalRow?.count ?? 0),
      offset,
      count: list.length,
    };
  }

  async get(id: string): Promise<AgentView> {
    await this.permissions.assert('use');
    await this.policy.assertDefinitionsEnabled();
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    return this.toView(row, viewer);
  }

  async versions(id: string): Promise<{ list: AgentVersionView[] }> {
    const row = await this.visibleRow(id, await this.viewer());
    const versions = await this.database.db
      .selectFrom('ai_agent_versions')
      .selectAll()
      .where('agent_id', '=', row.id)
      .orderBy('version', 'desc')
      .execute();
    const list = await Promise.all(versions.map((version) => this.versionView(version)));
    return { list };
  }

  async version(id: string, version: number): Promise<AgentVersionDetail> {
    const row = await this.visibleRow(id, await this.viewer());
    const stored = await this.database.db
      .selectFrom('ai_agent_versions')
      .selectAll()
      .where('agent_id', '=', row.id)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!stored) throw new NotFoundError(`Agent version "${String(version)}" does not exist.`);
    const view = await this.versionView(stored);
    return {
      ...view,
      config: parsedConfig(stored.config),
      limits: asRecord(stored.limits),
      approvalPolicy: asRecord(stored.approval_policy),
      memoryPolicy: asRecord(stored.memory_policy),
      triggerPolicy: asRecord(stored.trigger_policy),
      outputSchema: stored.output_schema,
    };
  }

  // -------------------------------------------------------------------------
  // draft writes
  // -------------------------------------------------------------------------

  async create(input: CreateAgentInput): Promise<AgentView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('manageDraft');
    const config = this.parseDraft(input.config);
    const clash = await this.database.db
      .selectFrom('ai_agents')
      .select('id')
      .where('agent_key', '=', input.key)
      .executeTakeFirst();
    if (clash) throw new DuplicateRecordError(`An agent with key "${input.key}" already exists.`);

    const now = new Date();
    const id = randomUUID();
    const ownerId = this.scope.userId;
    await this.database.db
      .insertInto('ai_agents')
      .values({
        id,
        agent_key: input.key,
        name: input.name,
        description: input.description ?? null,
        purpose: input.purpose ?? null,
        category: input.category ?? null,
        icon: input.icon ?? null,
        owner_user_id: ownerId ?? null,
        team_id: input.teamId ?? (this.scope.teamIds()[0] ?? null),
        visibility: input.visibility ?? 'team',
        status: 'draft',
        draft_config: JSON.stringify(config),
        current_version: null,
        data_sensitivity: config.dataClass,
        is_deleted: false,
        created_at: now,
        modified_at: now,
        created_by_id: ownerId ?? null,
        modified_by_id: ownerId ?? null,
      })
      .execute();
    return this.get(id);
  }

  async update(id: string, input: UpdateAgentInput): Promise<AgentView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('manageDraft');
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    if (!(await this.canEdit(row, viewer))) {
      throw new ValidationError('Only the owner, the owning team or an administrator may edit this agent.');
    }
    if (row.status === 'archived') {
      throw new ValidationError('An archived agent must be restored to draft before it can be edited.');
    }
    const config = input.config === undefined ? undefined : this.parseDraft(input.config);
    const patch: Updateable<AIAgentsTable> = { modified_at: new Date(), modified_by_id: this.scope.userId ?? null };
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.description !== undefined) patch['description'] = input.description;
    if (input.purpose !== undefined) patch['purpose'] = input.purpose;
    if (input.category !== undefined) patch['category'] = input.category;
    if (input.icon !== undefined) patch['icon'] = input.icon;
    if (input.visibility !== undefined) patch['visibility'] = input.visibility;
    if (input.teamId !== undefined) patch['team_id'] = input.teamId;
    if (config !== undefined) {
      patch['draft_config'] = JSON.stringify(config);
      patch['data_sensitivity'] = config.dataClass;
    }
    await this.database.db.updateTable('ai_agents').set(patch).where('id', '=', id).execute();
    return this.get(id);
  }

  async remove(id: string): Promise<{ success: true }> {
    await this.permissions.assert('manageDraft');
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    if (!(await this.canEdit(row, viewer))) throw new NotFoundError(`Agent "${id}" does not exist.`);
    if (row.status !== 'draft' || row.current_version !== null) {
      throw new ValidationError('Only an agent that was never published can be deleted. Archive it instead.');
    }
    await this.database.db
      .updateTable('ai_agents')
      .set({ is_deleted: true, modified_at: new Date(), modified_by_id: this.scope.userId ?? null })
      .where('id', '=', id)
      .execute();
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // validation
  // -------------------------------------------------------------------------

  async validate(id: string): Promise<AgentValidationReport> {
    await this.permissions.assert('use');
    const row = await this.visibleRow(id, await this.viewer());
    return this.validateRow(row);
  }

  private async validateRow(row: AIAgentsTable): Promise<AgentValidationReport> {
    const checks: AgentValidationCheck[] = [];
    const issues: AgentValidationIssue[] = [];
    const block = (code: string, path: string, message: string): void => {
      issues.push({ code, path, message, blocking: true });
    };
    const warn = (code: string, path: string, message: string): void => {
      issues.push({ code, path, message, blocking: false });
    };

    const parsed = parseAgentConfig(row.draft_config);
    if (!parsed.ok) {
      for (const issue of parsed.issues) block('invalid-config', issue.path, issue.message);
      checks.push({ id: 'configuration', ok: false, detail: 'The draft configuration is not valid.' });
      return { ok: false, issues, checks };
    }
    const config = parsed.config;
    checks.push({ id: 'configuration', ok: true, detail: 'The draft configuration is valid and bounded.' });

    for (const issue of publicationConfigIssues(config)) block('incomplete-config', issue.path, issue.message);

    const settings = await this.settings.settings();
    const limits = config.limits;
    const ceiling = settings.limits;
    const limitChecks: [string, keyof typeof limits, number][] = [
      ['maxSteps', 'maxSteps', ceiling.maxSteps],
      ['maxModelCalls', 'maxModelCalls', ceiling.maxModelCalls],
      ['maxToolCalls', 'maxToolCalls', ceiling.maxToolCalls],
      ['maxTokens', 'maxTokens', ceiling.maxTokens],
      ['maxCostUsd', 'maxCostUsd', ceiling.maxCostUsd],
      ['maxElapsedSeconds', 'maxElapsedSeconds', ceiling.maxElapsedSeconds],
      ['maxRetries', 'maxRetries', ceiling.maxRetries],
    ];
    let limitsOk = true;
    for (const [label, key, max] of limitChecks) {
      const value = limits[key];
      if (typeof value === 'number' && value > max) {
        limitsOk = false;
        block('limit-exceeds-policy', `limits.${label}`, `${label} (${String(value)}) exceeds the instance ceiling (${String(max)}).`);
      }
    }
    checks.push({
      id: 'limits',
      ok: limitsOk,
      detail: limitsOk ? 'Run limits are finite and within the instance ceilings.' : 'Run limits exceed an instance ceiling.',
    });

    if (config.input.mode === 'record') {
      const entity = config.input.entity ?? '';
      const ok = entity !== '' && this.metadata.registry.hasEntity(entity);
      checks.push({
        id: 'input-entity',
        ok,
        detail: ok ? `Record context comes from "${entity}".` : `Entity "${entity}" is not registered.`,
      });
      if (!ok) block('unknown-entity', 'input.entity', `Entity "${entity}" is not registered.`);
    }

    let providerOk = false;
    if (config.provider !== undefined) {
      try {
        const connection = await this.connections.resolve(config.provider.key);
        const adapter = this.connections.adapterFor(connection.kind);
        providerOk = true;
        if (!connection.models.includes(config.provider.model)) {
          providerOk = false;
          block('model-not-allowed', 'provider.model', `Model "${config.provider.model}" is not on the connection's allowlist.`);
        }
        for (const fallback of config.provider.fallbackModels) {
          if (!connection.models.includes(fallback)) {
            providerOk = false;
            block('model-not-allowed', 'provider.fallbackModels', `Fallback model "${fallback}" is not on the connection's allowlist.`);
          }
        }
        if (!connection.dataClasses.includes(config.dataClass)) {
          providerOk = false;
          block('data-class-not-allowed', 'dataClass', `The connection is not approved for the "${config.dataClass}" data class.`);
        }
        if (!settings.dataPolicy.allowedExternalDataClasses.includes(config.dataClass)) {
          providerOk = false;
          block('data-class-not-allowed', 'dataClass', `The instance policy does not allow "${config.dataClass}" data to leave the deployment.`);
        }
        if (config.tools.length > 0 && !adapter.capabilities.toolCalling) {
          providerOk = false;
          block('provider-capability', 'tools', `Adapter "${adapter.key}" does not support tool calling.`);
        }
        if (config.output.mode === 'json' && !adapter.capabilities.structuredOutput) {
          providerOk = false;
          block('provider-capability', 'output.mode', `Adapter "${adapter.key}" does not support structured output.`);
        }
        checks.push({
          id: 'provider',
          ok: providerOk,
          detail: providerOk
            ? `Provider "${connection.key}" serves "${config.provider.model}" for the "${config.dataClass}" data class.`
            : 'The provider configuration cannot serve this agent as configured.',
        });
      } catch (error) {
        providerOk = false;
        block('provider-unavailable', 'provider', error instanceof Error ? error.message : 'The provider is unavailable.');
        checks.push({ id: 'provider', ok: false, detail: 'The provider connection is missing or disabled.' });
      }
    } else {
      checks.push({ id: 'provider', ok: false, detail: 'No provider connection is selected.' });
    }

    let toolsOk = true;
    const grantedKeys = new Set<string>();
    for (const grant of config.tools) {
      if (grantedKeys.has(grant.key)) {
        toolsOk = false;
        block('duplicate-tool', 'tools', `Tool "${grant.key}" is granted twice.`);
        continue;
      }
      grantedKeys.add(grant.key);
      const requiresApproval = await this.requiresApproval(grant.key, config, settings.approval.requireFor);
      const found = await this.tools.validateGrant(grant.key, requiresApproval);
      for (const issue of found) {
        toolsOk = false;
        block('invalid-tool', 'tools', issue.message);
      }
    }
    checks.push({
      id: 'tools',
      ok: toolsOk,
      detail: toolsOk
        ? config.tools.length === 0
          ? 'This agent uses no tools.'
          : `All ${String(config.tools.length)} tool grant(s) are registered, enabled and approval-safe.`
        : 'At least one tool grant cannot be published.',
    });

    if (config.triggers.event && !settings.features.eventTriggers) {
      warn('trigger-disabled', 'triggers.event', 'Event triggers are enabled on the agent but the instance feature is off; those runs are refused.');
    }
    if (config.triggers.schedule && !settings.features.scheduledTriggers) {
      warn('trigger-disabled', 'triggers.schedule', 'Scheduled triggers are enabled on the agent but the instance feature is off; those runs are refused.');
    }
    if (config.triggers.integration) {
      warn('trigger-not-implemented', 'triggers.integration', 'Integration triggers are declared but not implemented in this release.');
    }
    const memoryEnabled = config.memory.mode !== 'none';
    if (memoryEnabled && !settings.features.memory) {
      block(
        'memory-disabled',
        'memory.mode',
        'This agent declares memory but the instance feature `features.memory` is off; enable it or set memory.mode to "none".',
      );
    } else if (memoryEnabled && config.memory.retentionDays > settings.retention.conversationsDays) {
      block(
        'memory-retention',
        'memory.retentionDays',
        `The agent retention (${String(config.memory.retentionDays)} days) exceeds the instance ceiling (${String(settings.retention.conversationsDays)} days).`,
      );
    }
    checks.push({
      id: 'memory',
      ok: !memoryEnabled || settings.features.memory,
      detail: !memoryEnabled
        ? 'Memory mode is "none": every run is isolated.'
        : settings.features.memory
          ? `Memory mode is "${config.memory.mode}" with ${String(config.memory.maxMessages)} recent messages and ${String(config.memory.retentionDays)}-day retention.`
          : 'The agent declares memory but the instance memory feature is off.',
    });
    if (settings.features.evaluations) {
      warn(
        'evaluations-unavailable',
        'evaluations',
        'Evaluation gates are enabled in settings but no evaluation suite exists; publication records this warning instead of passing a suite.',
      );
    }

    return { ok: issues.every((issue) => !issue.blocking), issues, checks };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async publish(id: string, note?: string): Promise<{ agent: AgentView; version: AgentVersionView; report: AgentValidationReport }> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('publish');
    const viewer = await this.viewer();
    const existing = await this.visibleRow(id, viewer);
    if (!(await this.canPublish(existing, viewer))) {
      throw new ValidationError('Only the owner, the owning team or an administrator may publish this agent.');
    }
    if (existing.status === 'archived') {
      throw new ValidationError('An archived agent cannot be published; restore it to draft first.');
    }
    const report = await this.validateRow(existing);
    if (!report.ok) {
      throw new ValidationError('The agent cannot be published while its validation report has blocking findings.', {
        issues: report.issues.filter((issue) => issue.blocking),
      });
    }
    const parsed = parseAgentConfig(existing.draft_config);
    if (!parsed.ok) {
      throw new ValidationError('The draft configuration is not valid.', { issues: parsed.issues });
    }
    const config = parsed.config;
    if (config.provider === undefined) {
      throw new ValidationError('An agent cannot be published without a provider connection.');
    }
    const checksum = agentConfigChecksum(config);
    const grants = await this.resolveGrants(config);

    const versionId = await this.database.db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('ai_agents')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new NotFoundError(`Agent "${id}" does not exist.`);
      if (locked.status === 'archived') throw new ValidationError('An archived agent cannot be published.');

      const current = locked.current_version === null
        ? undefined
        : await trx
            .selectFrom('ai_agent_versions')
            .select(['version', 'checksum'])
            .where('agent_id', '=', id)
            .where('version', '=', locked.current_version)
            .executeTakeFirst();
      if (current !== undefined && current.checksum === checksum && locked.status === 'published') {
        throw new ValidationError('The draft is identical to the currently published version; there is nothing to publish.');
      }

      const latest = await trx
        .selectFrom('ai_agent_versions')
        .select((eb) => eb.fn.max('version').as('version'))
        .where('agent_id', '=', id)
        .executeTakeFirst();
      const nextVersion = Number(latest?.version ?? 0) + 1;
      const newId = randomUUID();
      const now = new Date();
      const provider = config.provider;
      await trx
        .insertInto('ai_agent_versions')
        .values({
          id: newId,
          agent_id: id,
          version: nextVersion,
          config: JSON.stringify(config),
          checksum,
          provider_key: provider === undefined ? null : provider.key,
          model: provider === undefined ? null : provider.model,
          fallback_models: JSON.stringify(provider?.fallbackModels ?? []),
          input_schema: null,
          output_schema: config.output.schema === undefined ? null : JSON.stringify(config.output.schema),
          limits: JSON.stringify(config.limits),
          memory_policy: JSON.stringify(config.memory),
          trigger_policy: JSON.stringify(config.triggers),
          approval_policy: JSON.stringify(config.approval),
          published_by_id: this.scope.userId ?? null,
          published_at: now,
          publication_note: note ?? null,
          created_at: now,
        })
        .execute();

      for (const grant of grants) {
        await trx
          .insertInto('ai_agent_tool_grants')
          .values({
            id: randomUUID(),
            agent_version_id: newId,
            tool_key: grant.key,
            tool_version: grant.tool.version,
            effect_class: grant.tool.effectClass,
            constraints: JSON.stringify(grant.constraints),
            requires_approval: grant.requiresApproval,
            enabled: true,
            created_at: now,
          })
          .execute();
      }

      await trx
        .updateTable('ai_agents')
        .set({
          status: 'published',
          current_version: nextVersion,
          data_sensitivity: config.dataClass,
          modified_at: now,
          modified_by_id: this.scope.userId ?? null,
        })
        .where('id', '=', id)
        .execute();
      return newId;
    });

    const versionRow = await this.database.db
      .selectFrom('ai_agent_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow();
    return {
      agent: await this.get(id),
      version: await this.versionView(versionRow),
      report,
    };
  }

  async pause(id: string): Promise<AgentView> {
    return this.transition(id, 'published', 'paused', 'pause');
  }

  async resume(id: string): Promise<AgentView> {
    await this.permissions.assert('lifecycle');
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    if (!(await this.canPublish(row, viewer))) throw new ValidationError('You may not resume this agent.');
    if (row.status !== 'paused') {
      throw new ValidationError(`Only a paused agent can be resumed; this one is "${row.status}".`);
    }
    const report = await this.validateRow(row);
    if (!report.ok) {
      throw new ValidationError('The agent cannot be resumed while its configuration has blocking findings.', {
        issues: report.issues.filter((issue) => issue.blocking),
      });
    }
    await this.database.db
      .updateTable('ai_agents')
      .set({ status: 'published', modified_at: new Date(), modified_by_id: this.scope.userId ?? null })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  async archive(id: string): Promise<AgentView> {
    return this.transition(id, null, 'archived', 'archive');
  }

  async restore(id: string): Promise<AgentView> {
    await this.policy.assertDefinitionsEnabled();
    await this.permissions.assert('lifecycle');
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    if (!(await this.canPublish(row, viewer))) throw new ValidationError('You may not restore this agent.');
    if (row.status !== 'archived') throw new ValidationError('Only an archived agent can be restored to draft.');
    const source = row.current_version === null
      ? row.draft_config
      : (await this.database.db
          .selectFrom('ai_agent_versions')
          .select('config')
          .where('agent_id', '=', id)
          .where('version', '=', row.current_version)
          .executeTakeFirst())?.config ?? row.draft_config;
    // Restoring never mutates a published snapshot: the current published config becomes the new
    // draft, and the immutable version rows stay exactly as they were.
    await this.database.db
      .updateTable('ai_agents')
      .set({
        status: 'draft',
        draft_config: JSON.stringify(source),
        modified_at: new Date(),
        modified_by_id: this.scope.userId ?? null,
      })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  private async transition(
    id: string,
    from: AgentStatus | null,
    to: AgentStatus,
    command: 'pause' | 'archive',
  ): Promise<AgentView> {
    await this.permissions.assert('lifecycle');
    const viewer = await this.viewer();
    const row = await this.visibleRow(id, viewer);
    if (!(await this.canPublish(row, viewer))) {
      throw new ValidationError(`You may not ${command} this agent.`);
    }
    if (from !== null && row.status !== from) {
      throw new ValidationError(`Only a "${from}" agent can be ${command}d; this one is "${row.status}".`);
    }
    if (from === null && row.status === 'archived') {
      throw new ValidationError('This agent is already archived.');
    }
    await this.database.db
      .updateTable('ai_agents')
      .set({ status: to, modified_at: new Date(), modified_by_id: this.scope.userId ?? null })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private parseDraft(raw: unknown): AgentConfig {
    const parsed = parseAgentConfig(raw);
    if (!parsed.ok) {
      throw new ValidationError('The agent configuration is not valid.', { issues: parsed.issues });
    }
    return parsed.config;
  }

  private async resolveGrants(config: AgentConfig): Promise<ResolvedGrant[]> {
    const settings = await this.settings.settings();
    const out: ResolvedGrant[] = [];
    for (const grant of config.tools) {
      const tool = this.tools.get(grant.key);
      out.push({
        key: grant.key,
        tool,
        requiresApproval: await this.requiresApproval(grant.key, config, settings.approval.requireFor),
        constraints: grant.constraints ?? {},
      });
    }
    return out;
  }

  private async requiresApproval(
    key: string,
    config: AgentConfig,
    instanceRequireFor: readonly string[],
  ): Promise<boolean> {
    const tool = this.tools.get(key);
    return (
      tool.requiresApproval ||
      config.approval.requireFor.includes(tool.effectClass) ||
      instanceRequireFor.includes(tool.effectClass)
    );
  }

  private async viewer(): Promise<Viewer> {
    const [publish, manageDraft, lifecycle] = await Promise.all([
      this.permissions.can('publish'),
      this.permissions.can('manageDraft'),
      this.permissions.can('lifecycle'),
    ]);
    return {
      userId: this.scope.userId ?? '',
      teamIds: this.scope.teamIds(),
      isAdmin: this.scope.isAdmin,
      publish,
      manageDraft,
      lifecycle,
      seesEverything: this.scope.isAdmin || publish,
    };
  }

  private async canEdit(row: AIAgentsTable, viewer: Viewer): Promise<boolean> {
    if (!viewer.manageDraft) return false;
    if (viewer.isAdmin) return true;
    if (row.owner_user_id !== null && row.owner_user_id === viewer.userId) return true;
    return row.team_id !== null && viewer.teamIds.includes(row.team_id);
  }

  private async canPublish(row: AIAgentsTable, viewer: Viewer): Promise<boolean> {
    if (!viewer.publish) return false;
    if (viewer.isAdmin) return true;
    if (row.owner_user_id !== null && row.owner_user_id === viewer.userId) return true;
    return row.team_id !== null && viewer.teamIds.includes(row.team_id);
  }

  private async visibleRow(id: string, viewer: Viewer): Promise<AIAgentsTable> {
    const row = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', id)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (!row) throw new NotFoundError(`Agent "${id}" does not exist.`);
    const visible =
      viewer.seesEverything ||
      row.visibility === 'organization' ||
      (row.owner_user_id !== null && row.owner_user_id === viewer.userId) ||
      (row.team_id !== null && viewer.teamIds.includes(row.team_id));
    // A hidden agent answers exactly like a missing record: the caller learns nothing about it.
    if (!visible) throw new NotFoundError(`Agent "${id}" does not exist.`);
    return row;
  }

  private async toView(row: AIAgentsTable, viewer: Viewer): Promise<AgentView> {
    const parsed = parseAgentConfig(row.draft_config);
    const config = parsed.ok ? parsed.config : parsedFallbackConfig();
    const latest = row.current_version === null
      ? undefined
      : await this.database.db
          .selectFrom('ai_agent_versions')
          .selectAll()
          .where('agent_id', '=', row.id)
          .where('version', '=', row.current_version)
          .executeTakeFirst();
    const hasUnpublishedChanges =
      latest === undefined || latest.checksum !== agentConfigChecksum(row.draft_config);
    const tools = config.tools.map((grant) => {
      const definition = this.tools.has(grant.key) ? this.tools.get(grant.key) : undefined;
      return {
        key: grant.key,
        label: definition?.label ?? grant.key,
        effectClass: definition?.effectClass ?? 'unknown',
        requiresApproval:
          definition === undefined
            ? true
            : definition.requiresApproval || config.approval.requireFor.includes(definition.effectClass),
        enabled: definition !== undefined,
      };
    });
    return {
      id: row.id,
      key: row.agent_key,
      name: row.name,
      description: row.description,
      purpose: row.purpose,
      category: row.category,
      icon: row.icon,
      visibility: row.visibility,
      teamId: row.team_id,
      ownerUserId: row.owner_user_id,
      status: asStatus(row.status),
      dataSensitivity: row.data_sensitivity,
      currentVersion: row.current_version,
      hasUnpublishedChanges,
      draftConfig: config,
      configIssues: parsed.ok ? [] : parsed.issues,
      inputHint: config.prompt.inputHint ?? null,
      tools,
      capabilities: {
        editDraft: await this.canEdit(row, viewer),
        publish: await this.canPublish(row, viewer),
        lifecycle: viewer.lifecycle && (await this.canPublish(row, viewer)),
        run: row.status === 'published',
      },
      latestVersion: latest === undefined ? null : await this.versionView(latest),
      createdAt: row.created_at.toISOString(),
      modifiedAt: row.modified_at.toISOString(),
    };
  }

  private async versionView(row: AIAgentVersionsTable): Promise<AgentVersionView> {
    const grants = await this.database.db
      .selectFrom('ai_agent_tool_grants')
      .selectAll()
      .where('agent_version_id', '=', row.id)
      .orderBy('tool_key', 'asc')
      .execute();
    return {
      id: row.id,
      version: row.version,
      checksum: row.checksum,
      providerKey: row.provider_key,
      model: row.model,
      publishedById: row.published_by_id,
      publishedAt: row.published_at.toISOString(),
      note: row.publication_note,
      tools: grants.map((grant: AIAgentToolGrantsTable) => ({
        key: grant.tool_key,
        label: this.tools.has(grant.tool_key) ? this.tools.get(grant.tool_key).label : grant.tool_key,
        effectClass: grant.effect_class,
        requiresApproval: grant.requires_approval,
        enabled: grant.enabled,
      })),
    };
  }

  /** Exposed for the run engine: the exact grant rows a published version captured. */
  async versionGrants(versionId: string): Promise<AIAgentToolGrantsTable[]> {
    return this.database.db
      .selectFrom('ai_agent_tool_grants')
      .selectAll()
      .where('agent_version_id', '=', versionId)
      .orderBy('tool_key', 'asc')
      .execute();
  }

  /**
   * Phase 19-AI.8 — a reviewed, read-only starter for the first end-to-end agent. It has no provider:
   * the administrator picks one when creating the draft, so the template can never silently route
   * CRM data to whichever connection happens to exist.
   */
  async templates(): Promise<{
    list: { key: string; name: string; description: string; icon: string; config: AgentConfig }[];
  }> {
    await this.permissions.assert('use');
    return {
      list: [
        {
          key: 'account-briefing',
          name: 'Account briefing',
          description:
            'Read-only: finds an account and summarizes it, its related contacts and open opportunities for a sales user.',
          icon: 'robot',
          config: {
            dataClass: 'internal',
            prompt: {
              system:
                'You brief a sales user on one CRM account.\n' +
                '1. Find the account with crm_search_records (entity Account).\n' +
                '2. Read it with crm_read_record and list its related contacts and opportunities.\n' +
                '3. Give a short briefing: who the account is, the key people, open deals and the recommended next step.\n' +
                'Cite the record ids you actually read. If you cannot find or read a record, say so. Do not invent facts.',
              inputHint: 'Which account should I brief you on?',
            },
            input: { mode: 'text' },
            tools: [
              { key: 'crm_search_records' },
              { key: 'crm_read_record' },
              { key: 'crm_list_related' },
              { key: 'crm_record_summary' },
            ],
            limits: {
              maxSteps: 6,
              maxModelCalls: 6,
              maxToolCalls: 6,
              maxTokens: 12_000,
              maxCostUsd: 0.5,
              maxElapsedSeconds: 60,
              maxRetries: 1,
              maxOutputTokens: 1_024,
              temperature: 0.2,
            },
            output: { mode: 'text' },
            memory: { mode: 'none', maxMessages: 12, retentionDays: 30 },
            triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
            approval: { requireFor: ['material_write', 'high_impact'] },
          },
        },
      ],
    };
  }

  async permissionSummary(): Promise<{ tools: { key: string; label: string; effectClass: string; enabled: boolean }[] }> {
    await this.permissions.assert('use');
    const settings = await this.settings.settings();
    return {
      tools: this.tools.list().map((tool) => ({
        key: tool.key,
        label: tool.label,
        effectClass: tool.effectClass,
        enabled: !settings.tools.disabled.includes(tool.key),
      })),
    };
  }
}

interface Viewer {
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly isAdmin: boolean;
  readonly publish: boolean;
  readonly manageDraft: boolean;
  readonly lifecycle: boolean;
  readonly seesEverything: boolean;
}

function parsedConfig(value: unknown): AgentConfig {
  const parsed = parseAgentConfig(value);
  if (!parsed.ok) throw new ValidationError('The stored version configuration is not valid.', { issues: parsed.issues });
  return parsed.config;
}

function parsedFallbackConfig(): AgentConfig {
  return {
    dataClass: 'internal',
    prompt: { system: '' },
    input: { mode: 'text' },
    tools: [],
    limits: {
      maxSteps: 6,
      maxModelCalls: 6,
      maxToolCalls: 4,
      maxTokens: 12_000,
      maxCostUsd: 0.5,
      maxElapsedSeconds: 60,
      maxRetries: 1,
      maxOutputTokens: 1_024,
      temperature: 0.2,
    },
    output: { mode: 'text' },
    memory: { mode: 'none', maxMessages: 12, retentionDays: 30 },
    triggers: { manual: true, record: false, event: false, schedule: false, integration: false },
    approval: { requireFor: ['material_write', 'high_impact'] },
  };
}

function asStatus(value: string): AgentStatus {
  return AGENT_STATUSES.includes(value as AgentStatus) ? (value as AgentStatus) : 'draft';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
