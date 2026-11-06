import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Mail, Pencil, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Team, useDirectory, useTeams } from '../../lib/hooks';
import { ago, fmtPhone } from '../../lib/format';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th } from '../../components/ui';

interface UserRow {
  id: string; fullName: string; email: string; phone: string | null; isActive: boolean; lastLoginAt: string | null;
  teamId: string | null; team: { id: string; name: string } | null; roles: { role: { key: string; name: string } }[];
  _count?: { permissionOverrides: number };
}
interface Role { id: string; key: string; name: string }

function UserModal({ user, onClose }: { user: UserRow | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const teams = useTeams();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const isNew = user === 'new';
  const [f, setF] = useState({
    fullName: isNew ? '' : user.fullName, email: isNew ? '' : user.email, phone: isNew ? '' : user.phone ?? '',
    teamId: isNew ? '' : user.teamId ?? '', roleKeys: isNew ? ['employee'] : user.roles.map((r) => r.role.key),
  });
  const m = useMutation({
    mutationFn: () => isNew
      ? api.post<{ inviteSent?: boolean }>('/users', { ...f, phone: f.phone || undefined, teamId: f.teamId || undefined })
      : api.patch(`/users/${user.id}`, { fullName: f.fullName, email: f.email, phone: f.phone || null, teamId: f.teamId || null, roleKeys: f.roleKeys }),
    onSuccess: (r) => {
      if (isNew && !(r as { inviteSent?: boolean }).inviteSent) toast.warning('User created, but the invitation email failed. Use the mail button to resend it.');
      else toast.success(isNew ? 'User created. Invitation sent by email.' : 'User updated');
      qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['directory'] }); onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add user' : `Edit ${user.fullName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()} disabled={!f.fullName || !f.email || !f.roleKeys.length}>Save</Button></>}>
      <Field label="Full name"><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email (login)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone" hint="Used for click-to-call"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
      <Field label="Team">
        <Select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
          <option value="">No team</option>
          {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Roles">
        <div className="space-y-1 rounded-lg border border-slate-200 p-2">
          {roles.data?.filter((r) => r.key !== 'super_admin' || can('roles.manage')).map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.roleKeys.includes(r.key)} onChange={(e) => setF({ ...f, roleKeys: e.target.checked ? [...f.roleKeys, r.key] : f.roleKeys.filter((k) => k !== r.key) })} />{r.name}
            </label>
          ))}
        </div>
      </Field>
      {isNew && <p className="text-xs text-slate-500">They'll get an email invitation to create their sign-in. It must be this exact email address.</p>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/users/${user.id}/reset-password`, { password }),
    onSuccess: () => { toast.success(`Password changed for ${user.fullName}`); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={`Reset password for ${user.fullName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!password || password !== confirm} onClick={() => m.mutate()}>Reset password</Button></>}>
      <p className="text-sm text-slate-600">They'll be signed out on all devices and must use this password next time. Give it to them privately.</p>
      <Field label="New password" hint="Must meet your Clerk password rules (currently 15 characters or more)."><Input type="text" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="Confirm new password"><Input type="text" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      {confirm && confirm !== password && <p className="text-sm text-rose-400">Passwords don't match</p>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function TeamModal({ team, onClose }: { team: Team | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const isNew = team === 'new';
  const [name, setName] = useState(isNew ? '' : team.name);
  const [leaderId, setLeaderId] = useState(isNew ? '' : team.leaderId ?? '');
  const m = useMutation({
    mutationFn: () => (isNew ? api.post('/teams', { name, leaderId: leaderId || null }) : api.patch(`/teams/${team.id}`, { name, leaderId: leaderId || null })),
    onSuccess: () => { toast.success('Team saved'); qc.invalidateQueries({ queryKey: ['teams'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={isNew ? 'New team' : 'Edit team'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={name.length < 2} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Team name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Team leader" hint="Leaders see and manage their team's leads, calls, follow-ups and tasks (per the Team Leader role).">
        <Select value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
          <option value="">None</option>
          {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </Select>
      </Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

export default function AdminUsers() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [team, setTeam] = useState<Team | 'new' | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const users = useQuery({ queryKey: ['users', search], queryFn: () => api.get<UserRow[]>('/users', { search }) });
  const teams = useTeams();
  const manage = can('users.manage');

  const toggleActive = async (u: UserRow) => {
    if (!confirm(`${u.isActive ? 'Deactivate' : 'Reactivate'} ${u.fullName}?${u.isActive ? ' They will be signed out and unable to log in.' : ''}`)) return;
    try { await api.patch(`/users/${u.id}`, { isActive: !u.isActive }); qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['directory'] }); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (u: UserRow) => {
    const ok = confirm(`Delete ${u.fullName}?\n\nThey lose all access and their Clerk sign-in is removed. Their open leads go to Unassigned, open tasks lose their assignee and pending follow-ups are cancelled. Past calls and records keep their name.\n\nThis cannot be undone.`);
    if (!ok) return;
    try {
      const r = await api.del<{ released: { leads: number; followUps: number; tasks: number } }>(`/users/${u.id}`);
      toast.success(`${u.fullName} deleted. Released ${r.released.leads} leads and ${r.released.tasks} tasks; cancelled ${r.released.followUps} follow-ups.`);
      for (const k of ['users', 'directory', 'users-perm-list', 'leads', 'teams']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const invite = async (u: UserRow) => {
    try { await api.post(`/users/${u.id}/invite`); toast.success(`Invitation sent to ${u.email}`); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Users & Teams" subtitle="Manage employee accounts, roles and team structure"
        actions={manage && <Button onClick={() => setEditing('new')}><UserPlus className="h-4 w-4" />Add user</Button>} />
      <Card title="Users" actions={<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="w-56" />}>
        {users.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>User</Th><Th>Phone</Th><Th>Team</Th><Th>Roles</Th><Th>Last login</Th><Th>Status</Th>{(manage || can('roles.manage')) && <Th />}</tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'opacity-50'}>
                  <Td><span className="flex items-center gap-2.5"><Avatar name={u.fullName} /><span><p className="font-medium">{u.fullName}</p><p className="text-xs text-slate-500">{u.email}</p></span></span></Td>
                  <Td className="whitespace-nowrap">{fmtPhone(u.phone)}</Td>
                  <Td>{u.team?.name ?? '—'}</Td>
                  <Td><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.role.key} className="bg-indigo-50 text-indigo-700">{r.role.name}</Badge>)}
                    {!!u._count?.permissionOverrides && <Badge className="bg-amber-100 text-amber-800">+{u._count.permissionOverrides} custom</Badge>}</div></Td>
                  <Td className="whitespace-nowrap text-slate-500">{u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</Td>
                  <Td>{u.isActive ? <Badge className="bg-green-100 text-green-800">Active</Badge> : <Badge className="bg-slate-200 text-slate-600">Inactive</Badge>}</Td>
                  {(manage || can('roles.manage')) && (
                    <Td className="whitespace-nowrap text-right">
                      {can('roles.manage') && <Button size="sm" variant="ghost" onClick={() => nav(`/admin/roles?tab=user&user=${u.id}`)} title="Individual permissions"><ShieldCheck className="h-4 w-4" /></Button>}
                      {manage && <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(u)} title="Edit"><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => setResetting(u)} title="Reset password"><KeyRound className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => invite(u)} title="Send sign-in invitation"><Mail className="h-4 w-4" /></Button>
                      {u.id !== me?.id && <Button size="sm" variant="ghost" onClick={() => toggleActive(u)}>{u.isActive ? 'Deactivate' : 'Activate'}</Button>}
                      {u.id !== me?.id && <Button size="sm" variant="ghost" onClick={() => remove(u)} title="Delete user"><Trash2 className="h-4 w-4 text-rose-400" /></Button>}
                      </>}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Teams" actions={can('teams.manage') && <Button size="sm" onClick={() => setTeam('new')}><Plus className="h-4 w-4" />New team</Button>}>
        {!teams.data?.length ? <p className="p-4 text-sm text-slate-500">No teams yet.</p> : (
          <Table>
            <thead><tr><Th>Team</Th><Th>Leader</Th><Th>Members</Th>{can('teams.manage') && <Th />}</tr></thead>
            <tbody>
              {teams.data.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">{t.name}</Td>
                  <Td>{t.leader?.fullName ?? <span className="text-slate-400">—</span>}</Td>
                  <Td>{t._count.members}</Td>
                  {can('teams.manage') && (
                    <Td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setTeam(t)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        if (!confirm(`Delete team ${t.name}? Members will become team-less.`)) return;
                        try { await api.del(`/teams/${t.id}`); qc.invalidateQueries({ queryKey: ['teams'] }); } catch (e) { toast.error(errMsg(e)); }
                      }}><Trash2 className="h-4 w-4" /></Button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <UserModal user={editing} onClose={() => setEditing(null)} />}
      {team && <TeamModal team={team} onClose={() => setTeam(null)} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}
