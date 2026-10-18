import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { ModuleSettingsView, SettingsDocumentWarning } from '../api/types.js';

/**
 * A module settings document (`sales`, `serviceDesk`, `customerSuccess`) edited as a draft
 * (PLAN_Phase_20_Settings_UX.md §8.3, §9.1).
 *
 * The document stays owned by its module: the tab reads and writes the module's own endpoint, and the
 * shell supplies the save bar around it. Version, actor and warnings come from the same response, so
 * an administrator sees the state the server is actually holding.
 */
export interface ModuleDocumentView<T> {
  readonly settings: T;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly warnings: readonly SettingsDocumentWarning[];
}

export interface ModuleDocumentForm<T> {
  readonly value: T | undefined;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly loading: boolean;
  readonly failed: string | null;
  readonly warnings: readonly SettingsDocumentWarning[];
  readonly modifiedAt: string | null;
  readonly modifiedBy: string | null;
  readonly version: number;
  edit: (patch: Partial<T>) => void;
  replace: (value: T) => void;
  save: (next?: T) => Promise<void>;
  discard: () => void;
  reload: () => Promise<void>;
}

export function useModuleDocument<T extends object>(input: {
  readonly queryKey: readonly unknown[];
  readonly load: () => Promise<ModuleSettingsView<T>>;
  readonly persist: (patch: Record<string, unknown>) => Promise<unknown>;
  readonly savedMessage: string;
  readonly failedMessage: string;
  readonly onSaved: () => void;
}): ModuleDocumentForm<T> {
  const client = useQueryClient();
  const query = useQuery<ModuleSettingsView<T>>({
    queryKey: input.queryKey,
    queryFn: () => input.load(),
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const server = query.data?.settings;
  useEffect(() => {
    if (server !== undefined && draft === undefined) setDraft(server);
  }, [server, draft]);

  const dirty = draft !== undefined && server !== undefined && JSON.stringify(draft) !== JSON.stringify(server);

  return {
    value: draft,
    dirty,
    saving,
    loading: query.isLoading,
    failed,
    warnings: query.data?.warnings ?? [],
    modifiedAt: query.data?.updatedAt ?? null,
    modifiedBy: query.data?.updatedBy ?? null,
    version: query.data?.version ?? 0,

    edit: (patch) => {
      setDraft((current) => ({ ...(current ?? ({} as T)), ...patch }) as T);
      setFailed(null);
    },
    replace: (value) => {
      setDraft(value);
      setFailed(null);
    },
    save: async (next) => {
      const source = next ?? draft;
      if (source === undefined) return;
      setSaving(true);
      setFailed(null);
      try {
        await input.persist(source as unknown as Record<string, unknown>);
        await client.invalidateQueries({ queryKey: input.queryKey });
        input.onSaved();
      } catch (error) {
        // The module answers a refused policy change with its own reason; that reason is the whole
        // diagnostic, so it is shown rather than replaced by a generic failure string.
        setFailed(error instanceof Error ? error.message : input.failedMessage);
      } finally {
        setSaving(false);
      }
    },
    discard: () => {
      setDraft(server);
      setFailed(null);
    },
    reload: async () => {
      setDraft(undefined);
      setFailed(null);
      await query.refetch();
    },
  };
}
