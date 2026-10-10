import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { request, setAuthToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface Session {
  token: string;
  user: User;
}

interface AuthValue {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const STORAGE_KEY = 'stocksync.session';
const AuthContext = createContext<AuthValue | null>(null);

// sessionStorage keeps the user signed in across a page reload but not across browser sessions.
// Trade-off: a token in web storage is readable by injected scripts; the CSP-less dev setup accepts that.
function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(() => {
    const s = loadSession();
    setAuthToken(s?.token ?? null); // must be set before the first request of the first render
    return s;
  });

  const logout = useCallback(() => {
    setAuthToken(null);
    setSession(null);
    queryClient.clear(); // never show one user's cached data to the next user
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await request<Session>('/auth/login', { method: 'POST', body: { email, password } });
    setAuthToken(result.token);
    setSession(result);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    } catch {
      /* storage unavailable: the session just won't survive a reload */
    }
  }, []);

  const value = useMemo<AuthValue>(() => ({ user: session?.user ?? null, login, logout }), [session, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
