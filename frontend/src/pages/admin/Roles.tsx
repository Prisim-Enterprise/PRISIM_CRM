import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import clsx from 'clsx';
import { Check, Minus, Plus, RotateCcw, Search, X } from 'lucide-react';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Avatar, Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, Tabs } from '../../components/ui';

interface Role { id: string; key: string; name: string; description: string | null; isSystem: boolean; userCount: number; permissions: string[] }
interface Perm { key: string; group: string; description: string }
interface UserRow { id: string; fullName: string; email: string; isActive: boolean; roles: { role: { key: string; name: string } }[]; _count?: { permissionOverrides: number } }
interface UserPerms {
  user: { id: string; fullName: string; email: string };
  roles: { key: string; name: string }[];
  fromRoles: string[]; grants: string[]; denies: string[]; effective: string[];
}
type Override = 'inherit' | 'allow' | 'deny';

// ───────────────────────── By role ─────────────────────────

function ByRole({ perms, editable }: { perms: Perm[]; editable: boolean }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles-full'], queryFn: () => api.get<Role[]>('/roles') });
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  useEffect(() => { if (roles.data) setDraft(Object.fromEntries(roles.data.map((r) => [r.id, r.permissions]))); }, [roles.data]);
  if (roles.isLoading) return <Spinner />;
  const groups = [...new Set(perms.map((p) => p.group))];
  const dirty = (r: Role) => JSON.stringify([...(draft[r.id] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort());
  const toggle = (roleId: string, key: string) =>
    setDraft((d) => ({ ...d, [roleId]: d[roleId].includes(key) ? d[roleId].filter((k) => k !== key) : [...d[roleId], key] }));
  const save = async (r: Role) => {
    try { await api.put(`/roles/${r.id}/permissions`, { permissions: draft[r.id] }); toast.success(`${r.name} updated`); qc.invalidateQueries({ queryKey: ['roles-full'] }); }
    catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th className="min-w-72 border-b border-slate-200 px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">Permission</th>
              {roles.data!.map((r) => (
                <th key={r.id} className="min-w-36 border-b border-slate-200 px-3 py-3 text-center">
                  <p className="font-semibold text-slate-800">{r.name}</p>
                  <p className="text-xs font-normal text-slate-400">{r.userCount} user{r.userCount === 1 ? '' : 's'}</p>
                  {editable && r.key !== 'super_admin' && dirty(r) && <Button size="sm" className="mt-1" onClick={() => save(r)}>Save</Button>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr><td colSpan={roles.data!.length + 1} className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g}</td></tr>
                {perms.filter((p) => p.group === g).map((p) => (
                  <tr key={p.key} className="hover:bg-slate-50">
                    <td className="border-b border-slate-100 px-4 py-2"><p>{p.description}</p><p className="font-mono text-[11px] text-slate-400">{p.key}</p></td>
                    {roles.data!.map((r) => (
                      <td key={r.id} className="border-b border-slate-100 text-center">
                        <input type="checkbox" className="h-4 w-4 accent-indigo-600" disabled={!editable || r.key === 'super_admin'}
                          checked={draft[r.id]?.includes(p.key) ?? false} onChange={() => toggle(r.id, p.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────────────────── By user ─────────────────────────

const OPTIONS: { value: Override; label: string; icon: typeof Check; on: string }[] = [
  { value: 'allow', label: 'Allow', icon: Check, on: 'bg-emerald-600 text-white' },
  { value: 'deny', label: 'Deny', icon: X, on: 'bg-rose-600 text-white' },
];

function UserPermissionsEditor({ userId, perms, editable }: { userId: string; perms: Perm[]; editable: boolean }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['user-perms', userId], queryFn: () => api.get<UserPerms>(`/users/${userId}/permissions`) });
  const [draft, setDraft] = useState<Record<string, Override>>({});
  const [saving, setSaving] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);

  const initial = useMemo(() => {
    const m: Record<string, Override> = {};
    for (const p of perms) m[p.key] = data?.grants.includes(p.key) ? 'allow' : data?.denies.includes(p.key) ? 'deny' : 'inherit';
    return m;
  }, [data, perms]);
  useEffect(() => setDraft(initial), [initial]);

  if (isLoading || !data) return <Spinner />;
  const isSelf = userId === me?.id;
  const canEdit = editable && !isSelf;
  const fromRole = (k: string) => data.fromRoles.includes(k);
  const effective = (k: string) => (draft[k] === 'allow' ? true : draft[k] === 'deny' ? false : fromRole(k));
  const dirty = perms.some((p) => draft[p.key] !== initial[p.key]);
  const overrideCount = Object.values(draft).filter((v) => v !== 'inherit').length;
  const groups = [...new Set(perms.map((p) => p.group))];

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/users/${userId}/permissions`, {
        grants: perms.filter((p) => draft[p.key] === 'allow').map((p) => p.key),
        denies: perms.filter((p) => draft[p.key] === 'deny').map((p) => p.key),
      });
      toast.success(`Permissions updated for ${data.user.fullName}. Applies on their next action.`);
      qc.invalidateQueries({ queryKey: ['user-perms', userId] });
      qc.invalidateQueries({ queryKey: ['users-perm-list'] });
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <div className="flex items-center gap-3">
          <Avatar name={data.user.fullName} />
          <div>
            <p className="font-semibold">{data.user.fullName}</p>
            <p className="text-xs text-slate-500">{data.user.email}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {data.roles.length ? data.roles.map((r) => <Badge key={r.key} className="bg-indigo-50 text-indigo-700">{r.name}</Badge>) : <span className="text-xs text-slate-500">No role</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />Show only overrides ({overrideCount})
          </label>
          {canEdit && overrideCount > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setDraft(Object.fromEntries(perms.map((p) => [p.key, 'inherit'])))}><RotateCcw className="h-3.5 w-3.5" />Reset all to role</Button>
          )}
          {canEdit && <Button size="sm" disabled={!dirty} loading={saving} onClick={save}>Save changes</Button>}
        </div>
      </div>
      {isSelf && <p className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-sm text-amber-800">You can't change your own permissions, so you can't lock yourself out. Ask another Super Admin.</p>}
      {!editable && !isSelf && <p className="border-b border-slate-100 bg-slate-100 px-4 py-2 text-sm text-slate-600">Read-only. Only a Super Admin can change permissions.</p>}

      <div className="scroll-thin overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold uppercase text-slate-500">
              <th className="min-w-64 border-b border-slate-200 px-4 py-2.5 text-left">Permission</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">From role</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">For this user</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-center">Result</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const rows = perms.filter((p) => p.group === g && (!onlyChanged || draft[p.key] !== 'inherit'));
              if (!rows.length) return null;
              return (
                <Fragment key={g}>
                  <tr><td colSpan={4} className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g}</td></tr>
                  {rows.map((p) => {
                    const changed = draft[p.key] !== initial[p.key];
                    return (
                      <tr key={p.key} className={clsx('hover:bg-slate-50', changed && 'bg-indigo-50/40')}>
                        <td className="border-b border-slate-100 px-4 py-2"><p>{p.description}</p><p className="font-mono text-[11px] text-slate-400">{p.key}</p></td>
                        <td className="border-b border-slate-100 text-center">
                          {fromRole(p.key) ? <Check className="mx-auto h-4 w-4 text-emerald-600" /> : <Minus className="mx-auto h-4 w-4 text-slate-400" />}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-1.5">
                          <div className="mx-auto flex w-fit rounded-lg border border-slate-300 p-0.5">
                            {OPTIONS.map((o) => (
                              <button key={o.value} disabled={!canEdit}
                                // Clicking the active choice again clears it, so the role's setting applies.
                                onClick={() => setDraft({ ...draft, [p.key]: draft[p.key] === o.value ? 'inherit' : o.value })}
                                title={draft[p.key] === o.value ? 'Click again to go back to the role setting' : undefined}
                                className={clsx('flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed',
                                  draft[p.key] === o.value ? o.on : 'text-slate-500 hover:bg-slate-100')}>
                                <o.icon className="h-3 w-3" />{o.label}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="border-b border-slate-100 text-center">
                          {effective(p.key)
                            ? <Badge className="bg-green-100 text-green-800">Has access</Badge>
                            : <Badge className="bg-slate-200 text-slate-600">No access</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ByUser({ perms, editable }: { perms: Perm[]; editable: boolean }) {
  const [sp, setSp] = useSearchParams();
  const selected = sp.get('user');
  const [search, setSearch] = useState('');
  const users = useQuery({ queryKey: ['users-perm-list'], queryFn: () => api.get<UserRow[]>('/users') });
  const list = (users.data ?? []).filter((u) => !search || `${u.fullName} ${u.email}`.toLowerCase().includes(search.toLowerCase()));
  const pick = (id: string) => { const n = new URLSearchParams(sp); n.set('tab', 'user'); n.set('user', id); setSp(n, { replace: true }); };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="h-fit">
        <div className="border-b border-slate-100 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a user" className="pl-9" />
          </div>
        </div>
        {users.isLoading ? <Spinner /> : (
          <ul className="scroll-thin max-h-[32rem] overflow-y-auto p-1.5">
            {list.map((u) => (
              <li key={u.id}>
                <button onClick={() => pick(u.id)}
                  className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left', selected === u.id ? 'bg-slate-900 text-white' : 'hover:bg-slate-100', !u.isActive && 'opacity-50')}>
                  <Avatar name={u.fullName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{u.fullName}</span>
                    <span className={clsx('block truncate text-xs', selected === u.id ? 'text-indigo-100' : 'text-slate-500')}>{u.roles.map((r) => r.role.name).join(', ') || 'No role'}</span>
                  </span>
                  {!!u._count?.permissionOverrides && (
                    <span title="Has individual permission changes" className={clsx('rounded-full px-1.5 text-[10px] font-semibold', selected === u.id ? 'bg-white/20' : 'bg-amber-100 text-amber-800')}>
                      {u._count.permissionOverrides}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {selected ? <UserPermissionsEditor key={selected} userId={selected} perms={perms} editable={editable} />
        : <Card><Empty title="Pick a user">Choose someone on the left to allow or deny individual permissions on top of their role.</Empty></Card>}
    </div>
  );
}

// ───────────────────────── Page ─────────────────────────

export default function AdminRoles() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'user' ? 'user' : 'role';
  const editable = can('roles.manage');
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Perm[]>('/roles/permissions') });
  const [newRole, setNewRole] = useState<{ name: string; description: string } | null>(null);

  return (
    <div>
      <PageHeader title="Roles & Permissions"
        subtitle="Roles set the default permissions. Individual users can then be allowed or denied specific permissions. Everyone can always work their own leads, tasks, calls and feedback, and the server enforces every rule."
        actions={editable && tab === 'role' && <Button onClick={() => setNewRole({ name: '', description: '' })}><Plus className="h-4 w-4" />New role</Button>} />
      <div className="mb-4">
        <Tabs value={tab} onChange={(t) => setSp(t === 'user' ? { tab: 'user' } : {}, { replace: true })}
          tabs={[{ value: 'role', label: 'By role' }, { value: 'user', label: 'By user' }]} />
      </div>
      {!editable && tab === 'role' && <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">Read-only. Only a Super Admin can change role permissions.</p>}
      {perms.isLoading || !perms.data ? <Spinner /> : tab === 'role' ? <ByRole perms={perms.data} editable={editable} /> : <ByUser perms={perms.data} editable={editable} />}
      {newRole && (
        <Modal open onClose={() => setNewRole(null)} title="New role"
          footer={<><Button variant="secondary" onClick={() => setNewRole(null)}>Cancel</Button><Button disabled={newRole.name.length < 2} onClick={async () => {
            try { await api.post('/roles', newRole); qc.invalidateQueries({ queryKey: ['roles-full'] }); qc.invalidateQueries({ queryKey: ['roles'] }); setNewRole(null); toast.success('Role created. Tick its permissions in the table.'); }
            catch (e) { toast.error(errMsg(e)); }
          }}>Create</Button></>}>
          <Field label="Name"><Input value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} placeholder="e.g. Telecaller" /></Field>
          <Field label="Description"><Input value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}
