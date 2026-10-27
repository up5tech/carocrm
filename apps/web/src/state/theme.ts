import { createContext, useContext } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
/** The mode the interface is actually painted in — `system` resolved against the OS. */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'carocrm.themePreference';

export function readCachedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

/** The colour scheme the operating system asks for. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The mode a preference resolves to. `system` follows the operating system, so the answer can change
 * while the tab is open — which is why the shell listens for it (see `watchSystemTheme`).
 */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return systemTheme();
}

/**
 * Paint the document in the resolved mode.
 *
 * `data-theme` is always written — light included. Leaving it off for `system` made the CSS follow
 * the media query while Ant Design followed the resolved mode, so the two halves of the interface
 * could disagree; one explicit attribute keeps them in step.
 */
export function applyResolvedTheme(mode: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
}

/**
 * Paint the document in the mode the preference resolves to and remember the preference itself.
 *
 * The two are written separately on purpose: the mode changes when the OS flips under a `system`
 * preference, and caching *that* would silently turn "follow the OS" into "always light".
 */
export function applyThemePreference(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  applyResolvedTheme(resolved);
  cacheThemePreference(pref);
  return resolved;
}

export function cacheThemePreference(pref: ThemePreference): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, pref);
  }
}

/**
 * Watch the operating system's colour scheme. The callback fires with the new resolved theme so a
 * `system` preference repaints when the OS switches, without a reload.
 */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = (): void => onChange(query.matches ? 'dark' : 'light');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** The mode the shell resolved, for the components that paint with the mode's own colours. */
export const ThemeModeContext = createContext<ResolvedTheme>('light');

export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeModeContext);
}
