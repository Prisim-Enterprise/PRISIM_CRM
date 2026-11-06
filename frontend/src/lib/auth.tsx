import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth as useClerkAuth, useClerk } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg, setTokenGetter } from './api';

export interface Me {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  timezone: string;
  teamId: string | null;
  team: { id: string; name: string } | null;
  roles: string[];
  permissions: string[];
  teamIds: string[];
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  /** Signed in with Clerk, but the CRM refused: not added, or deactivated. */
  denied: string | null;
  logout: () => void;
  refresh: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useClerkAuth();
  const clerk = useClerk();
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => { setTokenGetter(() => getToken()); }, [getToken]);

  const refresh = useCallback(async () => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setMe(null); setDenied(null); setLoading(false);
      return;
    }
    try {
      setMe(await api.get<Me>('/auth/me'));
      setDenied(null);
    } catch (e) {
      setMe(null);
      setDenied(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    setLoading(true);
    refresh();
    window.addEventListener('prisim:logout', refresh);
    return () => window.removeEventListener('prisim:logout', refresh);
  }, [refresh]);

  const logout = () => {
    // State clears when Clerk reports the sign-out, so the session is really gone before /login shows.
    qc.clear();
    void clerk.signOut({ redirectUrl: '/login' });
  };

  const can = (...perms: string[]) => !!me && perms.some((p) => me.permissions.includes(p));

  return <Ctx.Provider value={{ me, loading, denied, logout, refresh, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
