import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The contract between a settings tab and the shell that hosts it
 * (PLAN_Phase_20_Settings_UX.md §4.1, §9.2).
 *
 * The shell owns the sticky save bar, so every tab offers Save / Discard / Reload in the same place
 * and under the same rules: Save is enabled only while the tab is dirty, a failed write keeps the
 * user's input, and leaving a dirty tab asks first. A tab reports its state; it never draws its own
 * button row.
 */
export interface TabActions {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly modifiedAt?: string | null;
  readonly modifiedBy?: string | null;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onReload: () => void;
}

export interface ShellMeta {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly modifiedAt: string | null;
  readonly modifiedBy: string | null;
}

const IDLE_META: ShellMeta = { dirty: false, saving: false, canSave: false, modifiedAt: null, modifiedBy: null };

const noop = (): void => undefined;

interface ShellValue {
  readonly meta: ShellMeta;
  readonly actions: { current: TabActions };
  publish: (actions: TabActions) => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useSettingsShellMeta(): ShellMeta {
  return useContext(ShellContext)?.meta ?? IDLE_META;
}

/** A tab calls this on every render with its current state; the shell renders the bar from it. */
export function usePublishTabActions(actions: TabActions): void {
  const shell = useContext(ShellContext);
  useEffect(() => {
    shell?.publish(actions);
  });
}

export function useSettingsShellState(): ShellValue & { reset: () => void } {
  const actions = useRef<TabActions>({
    dirty: false,
    saving: false,
    canSave: false,
    modifiedAt: null,
    modifiedBy: null,
    onSave: noop,
    onDiscard: noop,
    onReload: noop,
  });
  const [meta, setMeta] = useState<ShellMeta>(IDLE_META);

  const publish = useCallback((next: TabActions): void => {
    actions.current = next;
    setMeta((previous) => {
      const settled: ShellMeta = {
        dirty: next.dirty,
        saving: next.saving,
        canSave: next.canSave,
        modifiedAt: next.modifiedAt ?? null,
        modifiedBy: next.modifiedBy ?? null,
      };
      return previous.dirty === settled.dirty &&
        previous.saving === settled.saving &&
        previous.canSave === settled.canSave &&
        previous.modifiedAt === settled.modifiedAt &&
        previous.modifiedBy === settled.modifiedBy
        ? previous
        : settled;
    });
  }, []);

  const value = useMemo<ShellValue>(() => ({ meta, actions, publish }), [meta, publish]);
  const reset = useCallback(() => setMeta(IDLE_META), []);
  return { ...value, reset };
}

/** The shell's own view of the active tab, for the save bar buttons. */
export function useShellValue(): ShellValue | null {
  return useContext(ShellContext);
}

export const SettingsShellProvider = ShellContext.Provider;
