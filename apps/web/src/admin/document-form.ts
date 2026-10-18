import { App as AntApp } from 'antd';
import { useEffect, useState } from 'react';

import { ApiError } from '../api/client.js';
import type { SettingsDocumentWarning } from '../api/types.js';
import { useSettingsDocument, useSettingsDocumentResetter, useSettingsDocumentWriter } from '../state/admin.js';
import { t } from '../state/i18n.js';

/**
 * One settings document, edited as a draft (PLAN_Phase_20_Settings_UX.md §9.2).
 *
 * The tab owns the form; this owns the round trip: it reads the server value and its version, keeps a
 * local draft, reports dirtiness, saves with the version it read, and on a 409 keeps the user's input
 * and says the document changed under them, rather than overwriting the other administrator's work.
 */
export interface DocumentForm<T> {
  readonly value: T | undefined;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly loading: boolean;
  readonly failed: string | null;
  readonly conflict: boolean;
  readonly warnings: readonly SettingsDocumentWarning[];
  readonly modifiedAt: string | null;
  readonly modifiedBy: string | null;
  readonly version: number;
  edit: (patch: Partial<T>) => void;
  /** Saves the draft, or `next` when the caller computed the value in this same render. */
  save: (next?: T) => Promise<void>;
  discard: () => void;
  reload: () => Promise<void>;
  restoreDefaults: () => Promise<void>;
}

export function useDocumentForm<T extends object>(name: string): DocumentForm<T> {
  const query = useSettingsDocument<T>(name);
  const write = useSettingsDocumentWriter(name);
  const restore = useSettingsDocumentResetter<T>(name);
  const { message } = AntApp.useApp();

  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const server = query.data?.value;
  // Seed the draft from the server once; a reload clears it so the new value takes over.
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
    conflict,
    warnings: query.data?.warnings ?? [],
    modifiedAt: query.data?.updatedAt ?? null,
    modifiedBy: query.data?.updatedBy ?? null,
    version: query.data?.version ?? 0,

    edit: (patch) => {
      setDraft((current) => ({ ...(current ?? ({} as T)), ...patch }) as T);
      setFailed(null);
    },
    save: async (next) => {
      const source = next ?? draft;
      if (source === undefined || query.data === undefined) return;
      setSaving(true);
      setConflict(false);
      setDraft(source);
      try {
        await write(source as unknown as Record<string, unknown>, query.data.version);
        void message.success(t('web.adminShell.saved'));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'CONCURRENCY_CONFLICT') {
          setConflict(true);
          setFailed(t('web.adminShell.conflict'));
        } else {
          setFailed(error instanceof Error ? error.message : t('web.adminShell.saveFailed'));
        }
      } finally {
        setSaving(false);
      }
    },
    discard: () => {
      setDraft(server);
      setFailed(null);
      setConflict(false);
    },
    reload: async () => {
      setDraft(undefined);
      setFailed(null);
      setConflict(false);
      await query.refetch();
    },
    restoreDefaults: async () => {
      setSaving(true);
      try {
        const restored = await restore();
        setDraft(restored.value as unknown as T);
        void message.success(t('web.adminShell.restored'));
      } catch (error) {
        setFailed(error instanceof Error ? error.message : t('web.adminShell.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
  };
}
