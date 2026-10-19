import { randomUUID } from 'node:crypto';

import { NotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { type AgentConfig, agentConfigChecksum, parseAgentConfig } from './ai-agent-config.js';
import { AIToolRegistry } from './ai-agent-tools.js';
import { AIAgentsPermissionService } from './ai-agents-permission.service.js';
import { AIAgentsSettingsService } from './ai-agents-settings.service.js';
import { AIProviderConnectionService } from './ai-provider-connections.service.js';

/**
 * Phase 19-AI.14 — evaluation suites, graders and the publication gate
 * (PLAN_Phase_19_AI_Agents.md §17, §20 `19-AI.14`).
 *
 * §17.1 is the design brief: evaluation is a repeatable engineering process, not a score that
 * proves an agent safe. This service therefore:
 *
 *  - runs **deterministic** graders offline (no model call, no billable API): config schema, tool
 *    permissions, approval policy, budget bounds, provider policy, memory policy, ownership, and
 *    exact invariants an administrator pins on config values;
 *  - records `human_review` cases as pending until a person decides, and labels every decision;
 *  - treats `model_review` as **advisory only**: its outcome is stored with a clear label and can
 *    never turn a failed deterministic case into a pass (§17.4 "model-generated grading cannot
 *    override a failed deterministic safety test");
 *  - gates publication: when the evaluations feature is on and a required suite exists, publishing
 *    demands a **passing** run of the exact draft checksum — a stale pass on an older draft does
 *    not count;
 *  - compares the current draft's latest run with the latest run of the published version, so a
 *    regression is visible before publish (§17.4).
 *
 * Everything is scoped by the `evaluation` capability; run history is readable by anyone who may
 * use the module, decisions and administration require the capability (§17 "auditable and scoped
 * by permission").
 */
export interface EvalCaseResult {
  readonly caseId: string;
  readonly caseKey: string;
  readonly title: string;
  readonly grader: string;
  /** `deterministic` results gate; `review` results are labelled and never override them. */
  readonly kind: 'deterministic' | 'review';
  readonly passed: boolean;
  /** `passed`/`failed` for decided cases, `pending` for an undecided human review. */
  readonly outcome: 'passed' | 'failed' | 'pending';
  readonly detail: string;
}

export interface EvalRunView {
  readonly id: string;
  readonly agentId: string;
  readonly suiteId: string;
  readonly suiteKey: string;
  readonly configChecksum: string;
  readonly agentVersion: number | null;
  readonly status: 'passed' | 'failed' | 'pending_review';
  readonly results: readonly EvalCaseResult[];
  readonly createdAt: string;
}

export interface EvalSuiteView {
  readonly id: string;
  readonly suiteKey: string;
  readonly name: string;
  readonly description: string | null;
  readonly requiredForPublish: boolean;
  readonly enabled: boolean;
  readonly cases: readonly {
    readonly id: string;
    readonly caseKey: string;
    readonly title: string;
    readonly grader: string;
    readonly kind: 'deterministic' | 'review';
  }[];
}

/** The built-in publication-gate suite: security and policy regression cases (§17.2). */
const STANDARD_SUITE: {
  readonly suiteKey: string;
  readonly name: string;
  readonly description: string;
  readonly cases: readonly { caseKey: string; title: string; grader: string; graderConfig: Record<string, unknown> }[];
} = {
  suiteKey: 'publication-gate',
  name: 'Publication gate',
  description:
    'Deterministic security and policy regression cases every publishable agent must pass, plus a human review slot for high-impact changes.',
  cases: [
    {
      caseKey: 'config-schema',
      title: 'The draft configuration parses and every limit is finite',
      grader: 'config_schema',
      graderConfig: {},
    },
    {
      caseKey: 'tool-permissions',
      title: 'Every tool grant is registered, enabled and approval-safe',
      grader: 'tool_permissions',
      graderConfig: {},
    },
    {
      caseKey: 'approval-policy',
      title: 'Material and high-impact effect classes require human approval',
      grader: 'approval_policy',
      graderConfig: {},
    },
    {
      caseKey: 'budget-bounded',
      title: 'The execution budget exists and is bounded',
      grader: 'budget_bounded',
      graderConfig: {},
    },
    {
      caseKey: 'provider-policy',
      title: 'The provider connection exists, is enabled and allows the model',
      grader: 'provider_policy',
      graderConfig: {},
    },
    {
      caseKey: 'memory-policy',
      title: 'Memory is opt-in and its retention fits the instance ceiling',
      grader: 'memory_policy',
      graderConfig: {},
    },
    {
      caseKey: 'ownership',
      title: 'The agent has an owner or a team, and a stated purpose',
      grader: 'ownership',
      graderConfig: {},
    },
    {
      caseKey: 'human-review',
      title: 'A human reviewed this configuration',
      grader: 'human_review',
      graderConfig: {},
    },
  ],
};

const REVIEW_GRADERS: ReadonlySet<string> = new Set(['human_review', 'model_review']);

@Injectable()
export class AIAgentEvaluationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AIAgentsPermissionService) private readonly permissions: AIAgentsPermissionService,
    @Inject(AIAgentsSettingsService) private readonly settings: AIAgentsSettingsService,
    @Inject(AIToolRegistry) private readonly tools: AIToolRegistry,
    @Inject(AIProviderConnectionService) private readonly connections: AIProviderConnectionService,
  ) {}

  // -------------------------------------------------------------------------
  // suites and cases
  // -------------------------------------------------------------------------

  async listSuites(): Promise<{ list: EvalSuiteView[] }> {
    await this.permissions.assert('use');
    const suites = await this.database.db.selectFrom('ai_agent_eval_suites').selectAll().orderBy('suite_key', 'asc').execute();
    const cases = await this.database.db.selectFrom('ai_agent_eval_cases').selectAll().orderBy('case_key', 'asc').execute();
    return {
      list: suites.map((suite) => ({
        id: suite.id,
        suiteKey: suite.suite_key,
        name: suite.name,
        description: suite.description,
        requiredForPublish: suite.required_for_publish,
        enabled: suite.enabled,
        cases: cases
          .filter((row) => row.suite_id === suite.id)
          .map((row) => ({
            id: row.id,
            caseKey: row.case_key,
            title: row.title,
            grader: row.grader,
            kind: REVIEW_GRADERS.has(row.grader) ? ('review' as const) : ('deterministic' as const),
          })),
      })),
    };
  }

  /** Idempotent: creates the built-in publication-gate suite if it does not exist yet. */
  async ensureStandardSuite(): Promise<EvalSuiteView> {
    await this.permissions.assert('evaluation');
    const existing = await this.database.db
      .selectFrom('ai_agent_eval_suites')
      .select(['id'])
      .where('suite_key', '=', STANDARD_SUITE.suiteKey)
      .executeTakeFirst();
    if (existing !== undefined) {
      const found = (await this.listSuites()).list.find((suite) => suite.id === existing.id);
      if (found !== undefined) return found;
    }
    const suiteId = randomUUID();
    await this.database.db
      .insertInto('ai_agent_eval_suites')
      .values({
        id: suiteId,
        suite_key: STANDARD_SUITE.suiteKey,
        name: STANDARD_SUITE.name,
        description: STANDARD_SUITE.description,
        required_for_publish: true,
        enabled: true,
        created_by_user_id: null,
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();
    for (const entry of STANDARD_SUITE.cases) {
      await this.database.db
        .insertInto('ai_agent_eval_cases')
        .values({
          id: randomUUID(),
          suite_id: suiteId,
          case_key: entry.caseKey,
          title: entry.title,
          grader: entry.grader,
          grader_config: JSON.stringify(entry.graderConfig),
          created_at: new Date(),
        })
        .execute();
    }
    const created = (await this.listSuites()).list.find((suite) => suite.id === suiteId);
    if (created === undefined) throw new NotFoundError('The standard suite could not be created.');
    return created;
  }

  async createCase(
    suiteId: string,
    input: { readonly caseKey: string; readonly title: string; readonly grader: string; readonly graderConfig?: Record<string, unknown> },
  ): Promise<EvalSuiteView['cases'][number]> {
    await this.permissions.assert('evaluation');
    const suite = await this.database.db
      .selectFrom('ai_agent_eval_suites')
      .select(['id'])
      .where('id', '=', suiteId)
      .executeTakeFirst();
    if (suite === undefined) throw new NotFoundError(`Evaluation suite "${suiteId}" does not exist.`);
    if (!KNOWN_GRADERS.has(input.grader)) {
      throw new ValidationError(`Unknown grader "${input.grader}".`, { graders: [...KNOWN_GRADERS] });
    }
    const row = {
      id: randomUUID(),
      suite_id: suiteId,
      case_key: input.caseKey,
      title: input.title,
      grader: input.grader,
      grader_config: JSON.stringify(input.graderConfig ?? {}),
      created_at: new Date(),
    };
    try {
      await this.database.db.insertInto('ai_agent_eval_cases').values(row).execute();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ValidationError(`Case key "${input.caseKey}" already exists in this suite.`);
      throw error;
    }
    return {
      id: row.id,
      caseKey: row.case_key,
      title: row.title,
      grader: row.grader,
      kind: REVIEW_GRADERS.has(row.grader) ? 'review' : 'deterministic',
    };
  }

  async deleteSuite(id: string): Promise<void> {
    await this.permissions.assert('evaluation');
    const result = await this.database.db.deleteFrom('ai_agent_eval_suites').where('id', '=', id).executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) === 0) throw new NotFoundError(`Evaluation suite "${id}" does not exist.`);
  }

  // -------------------------------------------------------------------------
  // running evaluations
  // -------------------------------------------------------------------------

  /**
   * Grade an agent's **current draft** against one suite. Deterministic graders run offline;
   * `human_review` stays pending until a decision is recorded; `model_review` is advisory and is
   * reported as not-run in this release (a model-based grader needs an explicitly configured,
   * billable provider — §17.3 keeps those out of ordinary runs).
   */
  async runSuite(agentId: string, suiteId?: string): Promise<EvalRunView> {
    await this.permissions.assert('use');
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (agent === undefined) throw new NotFoundError(`Agent "${agentId}" does not exist.`);
    const suite =
      suiteId === undefined
        ? await this.firstEnabledSuite()
        : await this.database.db
            .selectFrom('ai_agent_eval_suites')
            .selectAll()
            .where('id', '=', suiteId)
            .executeTakeFirst();
    if (suite === undefined) throw new NotFoundError('No enabled evaluation suite exists.');
    const cases = await this.database.db
      .selectFrom('ai_agent_eval_cases')
      .selectAll()
      .where('suite_id', '=', suite.id)
      .orderBy('case_key', 'asc')
      .execute();

    const parsed = parseAgentConfig(agent.draft_config);
    const settings = await this.settings.settings();
    const results: EvalCaseResult[] = [];
    for (const entry of cases) {
      results.push(await this.runCase(entry, agent, parsed.ok ? parsed.config : null, parsed.ok ? [] : parsed.issues, settings));
    }

    // Status is decided by deterministic outcomes alone; review cases only refine it.
    const deterministicFailed = results.some((result) => result.kind === 'deterministic' && !result.passed);
    const reviewPending = results.some((result) => result.outcome === 'pending');
    const status = deterministicFailed ? 'failed' : reviewPending ? 'pending_review' : 'passed';

    const id = randomUUID();
    await this.database.db
      .insertInto('ai_agent_eval_runs')
      .values({
        id,
        agent_id: agentId,
        suite_id: suite.id,
        // The checksum of the config as stored: the gate matches this against the publish draft.
        config_checksum: agentConfigChecksum(agent.draft_config),
        agent_version: agent.current_version,
        status,
        results: JSON.stringify(results),
        created_by_user_id: null,
        created_at: new Date(),
      })
      .execute();
    return {
      id,
      agentId,
      suiteId: suite.id,
      suiteKey: suite.suite_key,
      configChecksum: agentConfigChecksum(agent.draft_config),
      agentVersion: agent.current_version,
      status,
      results,
      createdAt: new Date().toISOString(),
    };
  }

  async listRuns(agentId: string, maxSize = 25): Promise<{ list: EvalRunView[] }> {
    await this.permissions.assert('use');
    const runs = await this.database.db
      .selectFrom('ai_agent_eval_runs')
      .selectAll()
      .where('agent_id', '=', agentId)
      .orderBy('created_at', 'desc')
      .limit(Math.min(100, Math.max(1, maxSize)))
      .execute();
    const suites = await this.database.db.selectFrom('ai_agent_eval_suites').select(['id', 'suite_key']).execute();
    const keys = new Map(suites.map((suite) => [suite.id, suite.suite_key]));
    return { list: runs.map((row) => this.toRunView(row, keys.get(row.suite_id) ?? '')) };
  }

  /** Record a human decision on a pending `human_review` case of one run. */
  async decide(runId: string, caseKey: string, decision: 'approve' | 'reject', note?: string): Promise<EvalRunView> {
    await this.permissions.assert('evaluation');
    const run = await this.database.db
      .selectFrom('ai_agent_eval_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
    if (run === undefined) throw new NotFoundError(`Evaluation run "${runId}" does not exist.`);
    const results = asRecordArray(run.results) as unknown as EvalCaseResult[];
    const target = results.find((result) => result.caseKey === caseKey);
    if (target === undefined) throw new NotFoundError(`Case "${caseKey}" is not part of this evaluation run.`);
    if (target.grader !== 'human_review') {
      throw new ValidationError(`Case "${caseKey}" is not a human review; only a person can decide that case.`);
    }
    const decided: EvalCaseResult = {
      ...target,
      passed: decision === 'approve',
      outcome: decision === 'approve' ? 'passed' : 'failed',
      detail: `Human review: ${decision}${note === undefined || note === '' ? '' : ` — ${note}`}`,
    };
    const updated = results.map((result) => (result.caseKey === caseKey ? decided : result));
    const deterministicFailed = updated.some((result) => result.kind === 'deterministic' && !result.passed);
    const reviewPending = updated.some((result) => result.outcome === 'pending');
    const status = deterministicFailed ? 'failed' : reviewPending ? 'pending_review' : 'passed';
    await this.database.db
      .updateTable('ai_agent_eval_runs')
      .set({ results: JSON.stringify(updated), status })
      .where('id', '=', runId)
      .execute();
    const suite = await this.database.db
      .selectFrom('ai_agent_eval_suites')
      .select(['suite_key'])
      .where('id', '=', run.suite_id)
      .executeTakeFirst();
    return this.toRunView({ ...run, results: JSON.stringify(updated), status }, suite?.suite_key ?? '');
  }

  // -------------------------------------------------------------------------
  // publication gate and comparison (§17.4)
  // -------------------------------------------------------------------------

  /**
   * Called by the definitions service inside `publish()`. When the evaluations feature is off, or
   * no enabled required suite exists, publication proceeds (the validate report already warns).
   * Otherwise the exact draft checksum must have a passing run in every required suite.
   */
  async assertPublicationGate(agentId: string, configChecksum: string): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.evaluations) return;
    const suites = await this.database.db
      .selectFrom('ai_agent_eval_suites')
      .selectAll()
      .where('enabled', '=', true)
      .where('required_for_publish', '=', true)
      .execute();
    if (suites.length === 0) return;
    for (const suite of suites) {
      const passing = await this.database.db
        .selectFrom('ai_agent_eval_runs')
        .select(['id'])
        .where('agent_id', '=', agentId)
        .where('suite_id', '=', suite.id)
        .where('config_checksum', '=', configChecksum)
        .where('status', '=', 'passed')
        .executeTakeFirst();
      if (passing === undefined) {
        throw new ValidationError(
          `The "${suite.name}" evaluation has not passed this exact draft; run it and resolve its findings before publishing.`,
          { suiteKey: suite.suite_key },
        );
      }
    }
  }

  /**
   * Draft-vs-published comparison (§17.4): the latest run of the current draft against the latest
   * run of the published version, per case. A regression is a case that passed for the published
   * version and fails on the draft.
   */
  async compare(agentId: string): Promise<{
    draft: EvalRunView | null;
    published: EvalRunView | null;
    regressions: readonly { caseKey: string; title: string; published: string; draft: string }[];
  }> {
    await this.permissions.assert('use');
    const agent = await this.database.db
      .selectFrom('ai_agents')
      .select(['id', 'current_version'])
      .where('id', '=', agentId)
      .where('is_deleted', '=', false)
      .executeTakeFirst();
    if (agent === undefined) throw new NotFoundError(`Agent "${agentId}" does not exist.`);
    const suites = await this.database.db.selectFrom('ai_agent_eval_suites').select(['id', 'suite_key']).execute();
    const keys = new Map(suites.map((suite) => [suite.id, suite.suite_key]));
    const latest = await this.database.db
      .selectFrom('ai_agent_eval_runs')
      .selectAll()
      .where('agent_id', '=', agentId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const published =
      agent.current_version === null
        ? undefined
        : await this.database.db
            .selectFrom('ai_agent_eval_runs')
            .selectAll()
            .where('agent_id', '=', agentId)
            .where('agent_version', '=', agent.current_version)
            .orderBy('created_at', 'desc')
            .limit(1)
            .executeTakeFirst();
    const draftView = latest === undefined ? null : this.toRunView(latest, keys.get(latest.suite_id) ?? '');
    const publishedView = published === undefined ? null : this.toRunView(published, keys.get(published.suite_id) ?? '');
    const regressions: { caseKey: string; title: string; published: string; draft: string }[] = [];
    if (draftView !== null && publishedView !== null && publishedView.id !== draftView.id) {
      for (const before of publishedView.results) {
        const after = draftView.results.find((result) => result.caseKey === before.caseKey);
        if (after !== undefined && before.outcome === 'passed' && after.outcome !== 'passed') {
          regressions.push({
            caseKey: before.caseKey,
            title: after.title,
            published: 'passed',
            draft: after.outcome,
          });
        }
      }
    }
    return { draft: draftView, published: publishedView, regressions };
  }

  // -------------------------------------------------------------------------
  // graders
  // -------------------------------------------------------------------------

  private async runCase(
    entry: { id: string; case_key: string; title: string; grader: string; grader_config: unknown },
    agent: { purpose: string | null; owner_user_id: string | null; team_id: string | null; visibility: string; draft_config: unknown },
    config: AgentConfig | null,
    configIssues: readonly { path: string; message: string }[],
    settings: Awaited<ReturnType<AIAgentsSettingsService['settings']>>,
  ): Promise<EvalCaseResult> {
    const kind: 'deterministic' | 'review' = REVIEW_GRADERS.has(entry.grader) ? 'review' : 'deterministic';
    const base = { caseId: entry.id, caseKey: entry.case_key, title: entry.title, grader: entry.grader, kind };

    if (entry.grader === 'model_review') {
      // Advisory by design: a model-based grader never gates and, in this release, never runs
      // automatically. Recording it keeps the case visible without a billable call (§17.3).
      return { ...base, passed: true, outcome: 'passed', detail: 'Advisory only: not run automatically; it cannot override a deterministic failure.' };
    }
    if (entry.grader === 'human_review') {
      const alreadyDecided = false; // decided through `decide()` on the stored run
      return {
        ...base,
        passed: alreadyDecided,
        outcome: 'pending',
        detail: 'Awaiting a human decision; publish requires an approval once the deterministic cases pass.',
      };
    }
    if (config === null) {
      return { ...base, passed: false, outcome: 'failed', detail: `The draft configuration does not parse: ${configIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}` };
    }

    switch (entry.grader) {
      case 'config_schema': {
        const finite = [
          config.limits.maxSteps,
          config.limits.maxModelCalls,
          config.limits.maxToolCalls,
          config.limits.maxTokens,
          config.limits.maxCostUsd,
          config.limits.maxElapsedSeconds,
        ].every((value) => Number.isFinite(value) && value > 0);
        return finite
          ? { ...base, passed: true, outcome: 'passed', detail: 'The configuration parses and every limit is a positive finite number.' }
          : { ...base, passed: false, outcome: 'failed', detail: 'At least one limit is zero, negative or not finite.' };
      }
      case 'tool_permissions': {
        const problems: string[] = [];
        for (const grant of config.tools) {
          const tool = this.tools.get(grant.key);
          if (tool === undefined) {
            problems.push(`Tool "${grant.key}" is not registered.`);
            continue;
          }
          const requiresApproval =
            tool.requiresApproval ||
            config.approval.requireFor.includes(tool.effectClass) ||
            settings.approval.requireFor.includes(tool.effectClass);
          for (const issue of await this.tools.validateGrant(grant.key, requiresApproval)) {
            problems.push(issue.message);
          }
        }
        return problems.length === 0
          ? { ...base, passed: true, outcome: 'passed', detail: `All ${String(config.tools.length)} tool grant(s) are registered, enabled and approval-safe.` }
          : { ...base, passed: false, outcome: 'failed', detail: problems.join(' ') };
      }
      case 'approval_policy': {
        const risky = config.tools.filter((grant) => {
          const tool = this.tools.get(grant.key);
          return tool !== undefined && settings.approval.requireFor.includes(tool.effectClass);
        });
        const uncovered = risky.filter((grant) => !config.approval.requireFor.includes(this.tools.get(grant.key)?.effectClass ?? ''));
        return uncovered.length === 0
          ? { ...base, passed: true, outcome: 'passed', detail: `All ${String(risky.length)} material/high-impact tool(s) are approval-gated.` }
          : { ...base, passed: false, outcome: 'failed', detail: `Effect classes requiring approval are missing from approval.requireFor: ${uncovered.map((grant) => grant.key).join(', ')}` };
      }
      case 'budget_bounded': {
        const bounded =
          config.limits.maxSteps <= settings.limits.maxSteps &&
          config.limits.maxModelCalls <= settings.limits.maxModelCalls &&
          config.limits.maxToolCalls <= settings.limits.maxToolCalls &&
          config.limits.maxTokens <= settings.limits.maxTokens &&
          config.limits.maxCostUsd <= settings.limits.maxCostUsd &&
          config.limits.maxCostUsd > 0 &&
          config.limits.maxElapsedSeconds <= settings.limits.maxElapsedSeconds;
        return bounded
          ? { ...base, passed: true, outcome: 'passed', detail: 'The execution budget exists, is positive and stays within the instance ceilings.' }
          : { ...base, passed: false, outcome: 'failed', detail: 'A run limit is missing, unbounded, zero, or above the instance ceiling.' };
      }
      case 'provider_policy': {
        if (config.provider === undefined) {
          return { ...base, passed: false, outcome: 'failed', detail: 'No provider connection is configured.' };
        }
        try {
          const connection = await this.connections.resolve(config.provider.key);
          // `resolve()` already throws if disabled; no separate `.enabled` check needed.
          if (!connection.models.includes(config.provider.model)) {
            return { ...base, passed: false, outcome: 'failed', detail: `Model "${config.provider.model}" is not on the allowlist of "${config.provider.key}".` };
          }
          return { ...base, passed: true, outcome: 'passed', detail: `Provider "${config.provider.key}" is enabled and allows "${config.provider.model}".` };
        } catch (error) {
          // The resolve() method throws ValidationError with a specific message when disabled,
          // or when the connection does not exist.
          const message = (error as Error).message;
          if (message?.includes('disabled')) {
            return { ...base, passed: false, outcome: 'failed', detail: `Provider connection "${config.provider.key}" is disabled.` };
          }
          return { ...base, passed: false, outcome: 'failed', detail: `Provider connection "${config.provider.key}" does not exist.` };
        }
      }
      case 'memory_policy': {
        if (config.memory.mode === 'none') {
          return { ...base, passed: true, outcome: 'passed', detail: 'Memory is off: every run is isolated.' };
        }
        if (!settings.features.memory) {
          return { ...base, passed: false, outcome: 'failed', detail: 'The agent declares memory but the instance memory feature is off.' };
        }
        if (config.memory.retentionDays > settings.retention.conversationsDays) {
          return { ...base, passed: false, outcome: 'failed', detail: `Retention (${String(config.memory.retentionDays)} days) exceeds the instance ceiling (${String(settings.retention.conversationsDays)} days).` };
        }
        return { ...base, passed: true, outcome: 'passed', detail: `Memory mode "${config.memory.mode}" fits the instance retention ceiling.` };
      }
      case 'ownership': {
        const hasOwner = agent.owner_user_id !== null || agent.team_id !== null || agent.visibility === 'organization';
        const hasPurpose = (agent.purpose ?? '').trim() !== '';
        return hasOwner && hasPurpose
          ? { ...base, passed: true, outcome: 'passed', detail: 'The agent has an accountable owner (user, team or organization visibility) and a stated purpose.' }
          : { ...base, passed: false, outcome: 'failed', detail: `${hasOwner ? '' : 'No owner, team or organization visibility. '}${hasPurpose ? '' : 'No purpose stated.'}` };
      }
      case 'exact_invariant': {
        // An administrator pins an exact expectation on a config value: the deterministic
        // invariant of §17.2 "exact behavior invariants".
        const config2 = asRecord(entry.grader_config);
        const path = typeof config2['path'] === 'string' ? config2['path'] : '';
        const actual = path === '' ? undefined : path.split('.').reduce<unknown>((value, key) => asRecord(value)[key], config as unknown);
        if ('equals' in config2) {
          const ok = JSON.stringify(actual) === JSON.stringify(config2['equals']);
          return ok
            ? { ...base, passed: true, outcome: 'passed', detail: `${path} equals the pinned value.` }
            : { ...base, passed: false, outcome: 'failed', detail: `${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(config2['equals'])}.` };
        }
        if (typeof config2['max'] === 'number') {
          const ok = typeof actual === 'number' && actual <= Number(config2['max']);
          return ok
            ? { ...base, passed: true, outcome: 'passed', detail: `${path} is within the pinned maximum.` }
            : { ...base, passed: false, outcome: 'failed', detail: `${path} is ${JSON.stringify(actual)}, expected a number <= ${String(config2['max'])}.` };
        }
        return { ...base, passed: false, outcome: 'failed', detail: 'The invariant needs either an "equals" or a "max" expectation in grader_config.' };
      }
      default:
        return { ...base, passed: false, outcome: 'failed', detail: `Unknown grader "${entry.grader}".` };
    }
  }

  private async firstEnabledSuite(): Promise<{ id: string; suite_key: string } | undefined> {
    return this.database.db
      .selectFrom('ai_agent_eval_suites')
      .select(['id', 'suite_key'])
      .where('enabled', '=', true)
      .orderBy('suite_key', 'asc')
      .executeTakeFirst();
  }

  private toRunView(
    row: { id: string; agent_id: string; suite_id: string; config_checksum: string; agent_version: number | null; status: string; results: unknown; created_at: Date },
    suiteKey: string,
  ): EvalRunView {
    return {
      id: row.id,
      agentId: row.agent_id,
      suiteId: row.suite_id,
      suiteKey,
      configChecksum: row.config_checksum,
      agentVersion: row.agent_version,
      status: row.status as EvalRunView['status'],
      results: asRecordArray(row.results) as unknown as EvalCaseResult[],
      createdAt: row.created_at.toISOString(),
    };
  }
}

const KNOWN_GRADERS: ReadonlySet<string> = new Set([
  'config_schema',
  'tool_permissions',
  'approval_policy',
  'budget_bounded',
  'provider_policy',
  'memory_policy',
  'ownership',
  'exact_invariant',
  'human_review',
  'model_review',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}
