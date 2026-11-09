import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg, setTokenGetter } from './api';
import { supabase } from './supabase';

setTokenGetter(async () => (await supabase.auth.getSession()).data.session?.access_token ?? null);

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
  /** Has a sign-in session. True even if the CRM refused them. */
  signedIn: boolean;
  /** Signed in, but the CRM refused: not added, or deactivated. */
  denied: string | null;
  logout: () => void;
  refresh: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  // Also fires on token refreshes, which is why the user id is kept rather than the session.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id ?? null);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!ready) return;
    if (!userId) {
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
  }, [ready, userId]);

  useEffect(() => {
    setLoading(true);
    refresh();
    window.addEventListener('prisim:logout', refresh);
    return () => window.removeEventListener('prisim:logout', refresh);
  }, [refresh]);

  const logout = () => {
    // State clears when Supabase reports the sign-out, so the session is really gone before /login shows.
    qc.clear();
    void supabase.auth.signOut();
  };

  const can = (...perms: string[]) => !!me && perms.some((p) => me.permissions.includes(p));

  return <Ctx.Provider value={{ me, loading, signedIn: !!userId, denied, logout, refresh, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
