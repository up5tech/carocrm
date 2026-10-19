/**
 * Phase 19-AI.7/19-AI.8 — the job names shared by the API and the worker
 * (PLAN_Phase_19_AI_Agents.md §8.1, §20 `19-AI.7`).
 *
 * The worker owns no AI logic: like the marketing, sales and service-desk cron twins it calls the
 * API's worker-authorised endpoint, so the run engine has one implementation and one authorization
 * path. The strings are duplicated in `apps/worker/src/handlers/ai-agent-handlers.ts` because the
 * worker is a separate process and does not import the API's source tree.
 */

export const AI_AGENT_RUN_JOB = 'aiAgents.executeRun';
export const AI_AGENT_RUN_EXECUTE_PATH = '/api/v1/AIAgents/action/runs';

export function aiAgentRunExecutePath(runId: string): string {
  return `${AI_AGENT_RUN_EXECUTE_PATH}/${encodeURIComponent(runId)}/execute`;
}
