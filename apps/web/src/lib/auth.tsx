import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, tokenStore } from './api';

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
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onLogout = () => { setMe(null); qc.clear(); };
    window.addEventListener('prisim:logout', onLogout);
    return () => window.removeEventListener('prisim:logout', onLogout);
  }, [refresh, qc]);

  const login = async (email: string, password: string) => {
    const { accessToken } = await api.post<{ accessToken: string }>('/auth/login', { email, password });
    tokenStore.set(accessToken);
    await refresh();
  };

  const logout = () => {
    tokenStore.clear();
    setMe(null);
    qc.clear();
  };

  const can = (...perms: string[]) => !!me && perms.some((p) => me.permissions.includes(p));

  return <Ctx.Provider value={{ me, loading, login, logout, refresh, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
