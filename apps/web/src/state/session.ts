import { create } from 'zustand';

import { api, getStoredToken, refreshAccessToken, setStoredToken } from '../api/client.js';
import type { Principal } from '../api/types.js';
import { activateLocale, setActiveUserInfo, t } from './i18n.js';

interface SessionState {
  token: string | null;
  principal: Principal | null;
  restored: boolean;
  loading: boolean;
  error: string | null;
  /** §4.9: set when the password matched but a TOTP code is still required. */
  pendingChallenge: string | null;
  signIn: (userName: string, password: string) => Promise<boolean>;
  completeChallenge: (code: string) => Promise<boolean>;
  clearChallenge: () => void;
  loadPrincipal: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  token: getStoredToken(),
  principal: null,
  restored: false,
  loading: false,
  error: null,
  pendingChallenge: null,
 
  async loadPrincipal() {
    // The access token is short-lived; the HttpOnly refresh cookie (14 days) can
    // mint a new one, so a returning user is not bounced to the login screen.
    if (!getStoredToken()) {
      await refreshAccessToken();
    }
    const token = getStoredToken();
    if (!token) {
      set({ restored: true });
      return;
    }
    try {
      const principal = await api.me();
      // Phase 7A (PLAN §41.6): the user's own locale/timezone now drive catalog + formatting.
      setActiveUserInfo(principal.locale, principal.timezone);
      const stored = window.localStorage.getItem('carocrm.locale');
      if (principal.locale && principal.locale !== (stored ?? '')) {
        window.localStorage.setItem('carocrm.locale', principal.locale);
        await activateLocale(principal.locale);
      }
      set({ token, principal, restored: true });
    } catch {
      setStoredToken(null);
      set({ token: null, principal: null, restored: true });
    }
  },

  async signIn(userName, password) {
    set({ loading: true, error: null, pendingChallenge: null });
    try {
      const result = await api.login(userName, password);
      if ('challengeId' in result) {
        // §4.9: the password was only the first factor; the session is issued by the challenge.
        set({ loading: false, pendingChallenge: result.challengeId });
        return false;
      }
      setStoredToken(result.accessToken);
      set({ token: result.accessToken, loading: false });
      await get().loadPrincipal();
      return true;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : t('web.login.failed') });
      return false;
    }
  },

  async completeChallenge(code) {
    const challengeId = get().pendingChallenge;
    if (challengeId === null) return false;
    set({ loading: true, error: null });
    try {
      const result = await api.completeLoginChallenge(challengeId, code);
      setStoredToken(result.accessToken);
      set({ token: result.accessToken, pendingChallenge: null, loading: false });
      await get().loadPrincipal();
      return true;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : t('web.login.failed') });
      return false;
    }
  },

  clearChallenge() {
    set({ pendingChallenge: null, error: null });
  },

  async signOut() {
    try {
      await api.logout();
    } catch {
      // the local session is dropped even if the server call fails
    }
    setStoredToken(null);
    set({ token: null, principal: null, restored: true });
  },
}));
