import { create } from 'zustand';

import { api, getStoredToken, refreshAccessToken, setStoredToken } from '../api/client.js';
import type { Principal } from '../api/types.js';

interface SessionState {
  token: string | null;
  principal: Principal | null;
  restored: boolean;
  loading: boolean;
  error: string | null;
  signIn: (userName: string, password: string) => Promise<boolean>;
  loadPrincipal: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  token: getStoredToken(),
  principal: null,
  restored: false,
  loading: false,
  error: null,

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
      set({ token, principal: await api.me(), restored: true });
    } catch {
      setStoredToken(null);
      set({ token: null, principal: null, restored: true });
    }
  },

  async signIn(userName, password) {
    set({ loading: true, error: null });
    try {
      const result = await api.login(userName, password);
      setStoredToken(result.accessToken);
      set({ token: result.accessToken, loading: false });
      await get().loadPrincipal();
      return true;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'Login failed.' });
      return false;
    }
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
