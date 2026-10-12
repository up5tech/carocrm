import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client.js';
import type {
  ProcessCatalog,
  ProcessDefinitionShape,
  ProcessInstanceListResult,
  ProcessInstanceView,
  ProcessListResult,
  ProcessTaskListResult,
  ProcessView,
} from '../api/types.js';

/**
 * Process queries (PLAN §36).
 *
 * Definitions are administrator-only server-side; instances and tasks are *per-person* — everyone
 * sees the processes they started or hold a task in, so these hooks need no admin gate. The error
 * the API returns is surfaced as-is: following a link to `/admin/processes` without admin rights
 * shows the refusal rather than an empty page pretending nothing exists.
 */
export function useProcesses(admin: boolean | undefined) {
  return useQuery<ProcessListResult>({
    queryKey: ['processes'],
    queryFn: () => api.processes(),
    enabled: admin === true,
    retry: false,
  });
}

export function useProcess(id: string | undefined, admin: boolean | undefined) {
  return useQuery<ProcessView>({
    queryKey: ['processes', id],
    queryFn: () => api.process(id ?? ''),
    enabled: Boolean(id) && admin === true,
    retry: false,
  });
}

export function useProcessCatalog(admin: boolean | undefined) {
  return useQuery<ProcessCatalog>({
    queryKey: ['processes', 'catalog'],
    queryFn: () => api.processCatalog(),
    enabled: admin === true,
    retry: false,
  });
}

export function useProcessInstances(params: { status?: string | undefined; definitionId?: string | undefined } = {}) {
  return useQuery<ProcessInstanceListResult>({
    queryKey: ['processes', 'instances', params.status ?? 'all', params.definitionId ?? ''],
    queryFn: () => api.processInstances(params),
    retry: false,
  });
}

export function useProcessInstance(id: string | undefined) {
  return useQuery<ProcessInstanceView>({
    queryKey: ['processes', 'instances', 'detail', id],
    queryFn: () => api.processInstance(id ?? ''),
    enabled: Boolean(id),
    retry: false,
  });
}

/** The signed-in person's tasks. `status` undefined means "the ones I can answer". */
export function useProcessTasks(params: { status?: string | undefined; all?: boolean | undefined } = {}) {
  return useQuery<ProcessTaskListResult>({
    queryKey: ['processes', 'tasks', params.status ?? 'answerable', params.all === true],
    queryFn: () => api.processTasks(params),
    retry: false,
  });
}

/** The definition currently being edited: the live draft when there is one, else the published. */
export function editableProcessDefinition(process: ProcessView | undefined): ProcessDefinitionShape | undefined {
  if (!process) return undefined;
  const current = process.versions.find((version) => version.status === 'draft') ?? process.versions[0];
  return current?.definition;
}
