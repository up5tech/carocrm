import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type {
  WorkflowDefinitionShape,
  WorkflowListResult,
  WorkflowRunListResult,
  WorkflowRunView,
  WorkflowView,
} from '../api/types.js';

/**
 * Workflow queries (PLAN §35).
 *
 * Everything here is admin-only server-side, so the hooks simply surface the error the API returns
 * instead of hiding it: a regular user following a link to `/admin/workflows` sees the refusal.
 */
export function useWorkflows(admin: boolean | undefined) {
  return useQuery<WorkflowListResult>({
    queryKey: ['workflows'],
    queryFn: () => api.workflows(),
    enabled: admin === true,
    retry: false,
  });
}

export function useWorkflow(id: string | undefined, admin: boolean | undefined) {
  return useQuery<WorkflowView>({
    queryKey: ['workflows', id],
    queryFn: () => api.workflow(id ?? ''),
    enabled: Boolean(id) && admin === true,
    retry: false,
  });
}

export function useWorkflowCatalog(admin: boolean | undefined) {
  return useQuery<{ events: string[]; actions: { name: string; label: string; description: string }[] }>({
    queryKey: ['workflows', 'catalog'],
    queryFn: () => api.workflowCatalog(),
    enabled: admin === true,
    staleTime: 300_000,
    retry: false,
  });
}

export function useWorkflowRuns(admin: boolean | undefined, status?: string) {
  return useQuery<WorkflowRunListResult>({
    queryKey: ['workflows', 'runs', status ?? 'all'],
    queryFn: () => api.workflowRuns({ ...(status === undefined ? {} : { status }), limit: 50 }),
    enabled: admin === true,
    retry: false,
  });
}

export function useWorkflowRun(id: string | undefined, admin: boolean | undefined) {
  return useQuery<WorkflowRunView>({
    queryKey: ['workflows', 'runs', id],
    queryFn: () => api.workflowRun(id ?? ''),
    enabled: Boolean(id) && admin === true,
    retry: false,
  });
}

/** The definition currently being edited: the live draft when there is one, else the published. */
export function editableDefinition(workflow: WorkflowView | undefined): WorkflowDefinitionShape | undefined {
  if (!workflow) return undefined;
  const current = workflow.versions.find((version) => version.id === workflow.currentVersion?.toString() && version.status === 'draft');
  const source = current ?? workflow.versions[0];
  return source?.definition;
}