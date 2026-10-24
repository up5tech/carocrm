import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { api, type CalendarEvent, type DashboardRow, type StreamItem } from '../../api/client.js';
import type { ProcessInstanceListResult, ProcessTaskListResult, SetupChecklistView } from '../../api/types.js';
import { kpiDashletsOf, localDayBounds, localDayKey } from './home-model.js';

/**
 * One React Query key per home card (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Each card owns its own request and its own loading/empty/error state, so one failing source never
 * blanks the page and the page issues the same handful of requests whatever the module count is.
 * There is no per-entity count call anywhere: that fan-out is exactly what this page replaced.
 */

/** The activity types the home agenda shows — the set the calendar screen draws. */
const AGENDA_ENTITIES = ['Task', 'Call', 'Meeting', 'ProjectTask'] as const;

/** My answerable tasks. The default status set already covers `open`, `overdue` and `escalated`. */
export function useHomeTasks() {
  return useQuery<ProcessTaskListResult>({
    queryKey: ['home', 'tasks'],
    queryFn: () => api.processTasks({ limit: 50 }),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

/** The approval instances currently running for me — the focus card shows the count only. */
export function useHomeApprovals() {
  return useQuery<ProcessInstanceListResult>({
    queryKey: ['home', 'approvals'],
    queryFn: () => api.processInstances({ status: 'running', limit: 1 }),
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

export interface HomeAgenda {
  /** Events are already the day's; `dayKey` lets a component cap them without re-filtering. */
  events: CalendarEvent[];
  dayKey: string;
  now: Date;
}

/**
 * Today, as the calendar screen defines it: midnight to midnight in the browser's time zone, asked
 * for with the same four activity types.
 */
export function useHomeAgenda() {
  const [now] = useState(() => new Date());
  const bounds = useMemo(() => localDayBounds(now), [now]);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const dayKey = localDayKey(now);
  const query = useQuery<CalendarEvent[]>({
    queryKey: ['home', 'today', dayKey],
    queryFn: async () => {
      const result = await api.calendar({
        from: bounds.from,
        to: bounds.to,
        timeZone: zone,
        entities: [...AGENDA_ENTITIES],
        maxSize: 50,
      });
      return result.list;
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  return { ...query, events: query.data ?? [], dayKey, now };
}

/** The dashboards the user can see; the pulse rail picks its default from this list. */
export function useHomeDashboards() {
  return useQuery<DashboardRow[]>({
    queryKey: ['home', 'dashboards'],
    queryFn: () => api.dashboards(),
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

export interface HomePulseTile {
  name: string;
  value: number | null;
}

/**
 * The (at most three) KPI dashlets of the effective default dashboard, run in parallel.
 *
 * Disabled when the dashboard has no KPI dashlet: the rail is then simply absent, never replaced by
 * module counts. A dashlet that fails is dropped rather than taking the other tiles with it.
 */
export function useHomePulse(dashboard: DashboardRow | null) {
  const dashlets = useMemo(() => kpiDashletsOf(dashboard), [dashboard]);
  const dashboardId = dashboard?.id ?? '';
  const dashletKey = dashlets.map((dashlet) => dashlet.id).join(',');
  return useQuery<HomePulseTile[]>({
    queryKey: ['home', 'pulse', dashboardId, dashletKey],
    queryFn: async () => {
      if (!dashboard) return [];
      const settled = await Promise.allSettled(
        dashlets.map(async (dashlet) => {
          const result = await api.runDashlet(dashboard.id, dashlet.id);
          return { name: dashlet.name, value: kpiValue(result) };
        }),
      );
      return settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : []));
    },
    enabled: dashboard !== null && dashlets.length > 0,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

/** A KPI dashlet answers with `value` or, for a count, `count`; anything else is shown as unknown. */
function kpiValue(result: Record<string, unknown>): number | null {
  for (const key of ['value', 'count']) {
    const candidate = result[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

/** The latest entries of the followed stream. */
export function useHomeActivity() {
  return useQuery<StreamItem[]>({
    queryKey: ['home', 'activity'],
    queryFn: async () => {
      const result = await api.activityStream({ view: 'followed', maxSize: 5 });
      return result.list;
    },
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}

/** The first-run checklist — requested only for an administrator. */
export function useHomeSetup(enabled: boolean) {
  return useQuery<SetupChecklistView>({
    queryKey: ['home', 'setup'],
    queryFn: () => api.setupChecklist(),
    enabled,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: true,
  });
}
