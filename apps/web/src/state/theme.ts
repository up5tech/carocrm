export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'carocrm.themePreference';

export function readCachedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function isDarkPreference(pref: ThemePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemePreference(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (pref === 'system') {
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', pref);
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, pref);
  }
}

export function cacheThemePreference(pref: ThemePreference): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, pref);
  }
}
