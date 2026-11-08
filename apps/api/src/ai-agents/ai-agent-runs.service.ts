import { Inject, Injectable } from '@nestjs/common';

import { AuthService } from '../auth/auth.service.js';
import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import type { EntityCrudService } from '../entity/entity.service.js';
import { EntityCrudService as EntityService } from '../entity/entity.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import type { MetadataStoreService } from '../metadata/metadata-store.service.js';
import { METADATA_STORE } from '../metadata/metadata-store.service.js';
import { AIAgentDefinitionService } from './ai-agent-definitions.service.js';
import { AIAgentActorDirectoryService } from './ai-agent-directory.service.js';
import { AIAgentMemoryService } from './ai-agent-memory.service.js';
import { AIAgentQuotaService } from './ai-agent-quota.service.js';
import { AIToolRegistry } from './ai-agent-tools.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsPolicyService } from './ai-agents-policy.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderGateway } from './ai-provider-gateway.service.js';
import { AIAgentRunTriggers } from './runs/triggers.js';

export type {
  AIAgentRunEventView,
  AIAgentRunView,
  RunCreateInput,
  RunExecutionResult,
  RunListQuery,
  RunRecordRef,
} from './runs/shared.js';
export { hashArguments } from './runs/shared.js';

/**
 * Phase 19-AI.7–19-AI.10 — the durable run engine
 * (plans/PLAN_Phase_19_AI_Agents.md §7.3, §7.5, §8, §9, §20 `19-AI.7`–`19-AI.10`).
 *
 * A run is a row, not a process. The state that matters — counters, the resolved version, the tool
 * ledger, the pending approval — lives in Postgres, so a worker restart resumes from the same place.
 * Execution is claimed with a time-boxed lease: two workers cannot drive one step, and an expired
 * lease lets the retry take over.
 *
 * The loop is deliberately small and bounded:
 *
 *   model call → validate tool calls → policy → (execute | pause for approval) → repeat → final answer
 *
 * Every step re-checks the kill switch, the elapsed budget, the token budget, the step/model/tool
 * ceilings and the cancellation flag. A read tool's failure is reported back to the model; a write
 * tool's failure whose effect is unknown stops the run as `outcome_unknown` and is never retried
 * automatically (§7.5).
 *
 * Tool results are returned to the model as a delimited **user data message** rather than a native
 * assistant tool-call message. That keeps the provider contract vendor-neutral (no adapter has to
 * reconstruct a vendor's tool transcript) and makes the untrusted-data boundary explicit.
 *
 * 19-AI.25 — the implementation is split across `runs/` (base reads/helpers, executor step loop,
 * lifecycle transitions, trigger doors); this class is the single injectable façade providers use.
 */

@Injectable()
export class AIAgentRunService extends AIAgentRunTriggers {
  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) scope: RequestScope,
    @Inject(AuthService) auth: AuthService,
    @Inject(AIAgentsPermissionService) permissions: AIAgentsPermissionService,
    @Inject(AIAgentsPolicyService) policy: AIAgentsPolicyService,
    @Inject(AIAgentsSettingsService) settings: AIAgentsSettingsService,
    @Inject(AIAgentDefinitionService) definitions: AIAgentDefinitionService,
    @Inject(AIToolRegistry) tools: AIToolRegistry,
    @Inject(AIProviderGateway) gateway: AIProviderGateway,
    @Inject(EntityService) entities: EntityCrudService,
    @Inject(METADATA_STORE) metadata: MetadataStoreService,
    @Inject(JobsService) jobs: JobsService,
    @Inject(AIAgentMemoryService) memory: AIAgentMemoryService,
    @Inject(AIAgentQuotaService) quotas: AIAgentQuotaService,
    @Inject(AIAgentActorDirectoryService) actors: AIAgentActorDirectoryService,
  ) {
    super(
      database,
      scope,
      auth,
      permissions,
      policy,
      settings,
      definitions,
      tools,
      gateway,
      entities,
      metadata,
      jobs,
      memory,
      quotas,
      actors,
    );
  }
}
