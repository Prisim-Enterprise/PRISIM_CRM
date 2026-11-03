import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  LayoutDashboard, Users, CalendarClock, PhoneCall, KanbanSquare, MessageSquareText, Shield, Plug, ScrollText,
  Bell, LogOut, Menu, UserCog, X,
  Building2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ago } from '../lib/format';
import { Avatar } from './ui';

interface Notification { id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unreadCount: number }>('/notifications'),
    refetchInterval: 30_000,
  });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const openItem = async (n: Notification) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    setOpen(false);
    if (n.link) nav(n.link);
  };
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
        <Bell className="h-5 w-5" />
        {!!data?.unreadCount && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {data.unreadCount > 99 ? '99+' : data.unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-96 max-w-[90vw] rounded-xl border border-slate-200 bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {!!data?.unreadCount && <button className="text-xs text-indigo-400 hover:underline" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <div className="scroll-thin max-h-[60vh] overflow-y-auto">
            {!data?.items.length && <p className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up.</p>}
            {data?.items.map((n) => (
              <button key={n.id} onClick={() => openItem(n)} className={clsx('block w-full border-b border-slate-50 px-4 py-2.5 text-left hover:bg-slate-50', !n.readAt && 'bg-indigo-50/60')}>
                <p className={clsx('text-sm', !n.readAt ? 'font-semibold text-slate-900' : 'text-slate-700')}>{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{n.body}</p>}
                <p className="mt-0.5 text-[11px] text-slate-400">{ago(n.createdAt)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { me, can, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const main = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/leads', label: 'Leads', icon: Users },
    { to: '/follow-ups', label: 'Follow-ups', icon: CalendarClock },
    { to: '/calls', label: 'Calls', icon: PhoneCall },
    { to: '/tasks', label: 'Tasks', icon: KanbanSquare },
    { to: '/clients', label: 'Clients', icon: Building2 },
    { to: '/feedback', label: 'Feedback & Queries', icon: MessageSquareText },
  ];
  const admin = [
    can('users.view', 'users.manage', 'teams.manage') && { to: '/admin/users', label: 'Users & Teams', icon: UserCog },
    { to: '/admin/roles', label: 'Roles & Permissions', icon: Shield, show: can('roles.manage', 'users.manage') },
    can('integrations.manage', 'leads.import') && { to: '/admin/integrations', label: 'Integrations', icon: Plug },
    can('audit.view') && { to: '/admin/audit', label: 'Audit Log', icon: ScrollText },
  ].filter((x): x is { to: string; label: string; icon: typeof Plug; show?: boolean } => !!x && (x as { show?: boolean }).show !== false);

  const link = (i: { to: string; label: string; icon: typeof Plug; end?: boolean }) => (
    <NavLink
      key={i.to} to={i.to} end={i.end} onClick={() => setMobileOpen(false)}
      className={({ isActive }) => clsx(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
        isActive ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-200 hover:text-white',
      )}
    >
      <i.icon className="h-4.5 w-4.5 h-[18px] w-[18px]" />
      {i.label}
    </NavLink>
  );

  const sidebar = (
    <div className="flex h-full flex-col border-r border-slate-200 bg-black">
      <NavLink to="/" className="flex items-end gap-2 px-5 py-5">
        <img src="/prisim-logo.png" alt="Prisim" className="h-9 w-auto" />
        <span className="mb-0.5 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-slate-700">CRM</span>
      </NavLink>
      <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3">
        {main.map(link)}
        {admin.length > 0 && <p className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Administration</p>}
        {admin.map(link)}
      </nav>
      <div className="border-t border-slate-200 p-3">
        <NavLink to="/profile" onClick={() => setMobileOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-slate-200">
          <Avatar name={me?.fullName} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">{me?.fullName}</p>
            <p className="truncate text-xs text-slate-600">{me?.team?.name ?? me?.email}</p>
          </div>
        </NavLink>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="w-64">{sidebar}</div>
          <div className="flex-1 bg-black/60" onClick={() => setMobileOpen(false)}>
            <button className="m-3 rounded bg-surface p-1"><X className="h-5 w-5" /></button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-black px-4">
          <button className="rounded p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
          <div className="hidden text-sm text-slate-500 lg:block">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <button onClick={logout} className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-slate-500 hover:bg-slate-100" title="Sign out">
              <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="scroll-thin min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
          <div className="mx-auto max-w-[1400px]"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
