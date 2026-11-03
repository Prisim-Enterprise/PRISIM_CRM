import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Briefcase, Building2, CalendarClock, FileText, Mail, MessageSquare, Paperclip, Pencil, Phone, Plus, Send, Trash2, User as UserIcon,
} from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { PRIORITY, ago, fmtBytes, fmtDate, fmtDateTime, fmtPhone } from '../lib/format';
import {
  Avatar, Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea,
} from '../components/ui';

interface Person { id: string; fullName: string }
interface Client {
  id: string; name: string; company: string | null; contactName: string | null; email: string | null; phone: string | null;
  notes: string | null; status: ClientStatus; createdBy: Person; createdAt: string; updatedAt: string;
  workCount?: number; openWorkCount?: number; lastActivityAt?: string;
}
type ClientStatus = 'ACTIVE' | 'ON_HOLD' | 'COMPLETED';
type WorkStatus = 'OPEN' | 'IN_PROGRESS' | 'SUBMITTED' | 'DONE';
interface Work {
  id: string; title: string; description: string | null; priority: string; status: WorkStatus; dueAt: string | null; isOverdue: boolean;
  completedAt: string | null; createdAt: string; updatedAt: string; createdBy: Person;
  client: { id: string; name: string; company: string | null };
  assignees: { user: Person }[]; _count: { updates: number; attachments: number };
}
interface WorkDetail extends Work {
  updates: { id: string; body: string | null; fromStatus: WorkStatus | null; toStatus: WorkStatus | null; createdAt: string; author: Person }[];
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: Person | null }[];
  permissions: { canManage: boolean; canWork: boolean; allowedStatuses: WorkStatus[] };
}

export const CLIENT_STATUS: Record<ClientStatus, { label: string; color: string }> = {
  ACTIVE: { label: 'Active', color: 'bg-green-100 text-green-800' },
  ON_HOLD: { label: 'On hold', color: 'bg-amber-100 text-amber-800' },
  COMPLETED: { label: 'Completed', color: 'bg-slate-200 text-slate-700' },
};
export const WORK_STATUS: Record<WorkStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'bg-sky-100 text-sky-800' },
  IN_PROGRESS: { label: 'In progress', color: 'bg-indigo-100 text-indigo-800' },
  SUBMITTED: { label: 'Submitted', color: 'bg-violet-100 text-violet-800' },
  DONE: { label: 'Done', color: 'bg-green-100 text-green-800' },
};

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ['clients', 'client', 'client-work', 'work', 'activity', 'client-summary']) qc.invalidateQueries({ queryKey: [k] });
};

// ───────────────────────── List page ─────────────────────────

export default function Clients() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'clients' | 'work') || 'clients';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [workStatus, setWorkStatus] = useState('active');
  const [mineOnly, setMineOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const manage = can('clients.manage');
  const seesAll = manage || can('clients.view.all');

  const clients = useQuery({ queryKey: ['clients', search, status], queryFn: () => api.get<Client[]>('/clients', { search, status }), enabled: tab === 'clients' });
  const work = useQuery({
    queryKey: ['client-work', search, workStatus, mineOnly],
    queryFn: () => api.get<Work[]>('/client-work', {
      search, assignee: mineOnly ? 'me' : undefined,
      status: workStatus === 'active' ? 'OPEN,IN_PROGRESS,SUBMITTED' : workStatus || undefined,
    }),
    enabled: tab === 'work',
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clients"
        subtitle={manage ? 'Add clients and post their work to anyone in the team' : seesAll ? 'Every client, the work posted for them and its progress' : 'Client work posted to you'}
        actions={manage && <Button onClick={() => setEditing(true)}><Plus className="h-4 w-4" />Add client</Button>}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onChange={(v) => setParams(v === 'clients' ? {} : { tab: v }, { replace: true })}
          tabs={[{ value: 'clients', label: 'Clients' }, { value: 'work', label: seesAll ? 'All work' : 'My work' }]} />
        <div className="flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tab === 'clients' ? 'Search clients…' : 'Search work or client…'} className="w-56" />
          {tab === 'clients' ? (
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
              <option value="">All statuses</option>
              {Object.entries(CLIENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          ) : (
            <>
              <Select value={workStatus} onChange={(e) => setWorkStatus(e.target.value)} className="w-40">
                <option value="active">Not done yet</option>
                <option value="">All statuses</option>
                {Object.entries(WORK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
              {seesAll && <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />Posted to me</label>}
            </>
          )}
        </div>
      </div>

      {tab === 'clients' ? (
        clients.isLoading ? <Spinner /> : !clients.data?.length ? (
          <Card><Empty title={manage ? 'No clients yet' : 'No client work yet'} icon={<Building2 className="h-8 w-8" />}>
            {manage ? 'Add a client, then post work for them to anyone.' : 'When work is posted to you it shows up here.'}
          </Empty></Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {clients.data.map((c) => (
              <Link key={c.id} to={`/clients/${c.id}`} className="block rounded-xl border border-slate-200 bg-surface p-4 transition hover:border-indigo-300 hover:shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{c.name}</p>
                    <p className="truncate text-sm text-slate-500">{c.company || c.contactName || '—'}</p>
                  </div>
                  <Badge className={CLIENT_STATUS[c.status].color}>{CLIENT_STATUS[c.status].label}</Badge>
                </div>
                <div className="mt-3 flex items-center gap-4 text-sm">
                  <span><span className="font-semibold tabular-nums">{c.openWorkCount}</span> <span className="text-slate-500">open</span></span>
                  <span><span className="font-semibold tabular-nums">{c.workCount}</span> <span className="text-slate-500">total work</span></span>
                  <span className="ml-auto text-xs text-slate-400">{ago(c.lastActivityAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )
      ) : (
        <Card>
          {work.isLoading ? <Spinner /> : !work.data?.length ? <Empty title="No work here" icon={<Briefcase className="h-8 w-8" />}>Try another status filter.</Empty> : (
            <WorkList items={work.data} showClient />
          )}
        </Card>
      )}
      {editing && <ClientModal onClose={() => setEditing(false)} />}
    </div>
  );
}

function WorkList({ items, showClient }: { items: Work[]; showClient?: boolean }) {
  const nav = useNavigate();
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((w) => (
        <li key={w.id}>
          <button onClick={() => nav(`/clients/${w.client.id}?work=${w.id}`)} className="flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-slate-50 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{w.title}</p>
              <p className="truncate text-xs text-slate-500">
                {showClient && <><span className="font-medium text-slate-600">{w.client.name}</span> · </>}
                Posted by {w.createdBy.fullName} {ago(w.createdAt)}
                {!!w._count.updates && <> · <MessageSquare className="inline h-3 w-3" /> {w._count.updates}</>}
                {!!w._count.attachments && <> · <Paperclip className="inline h-3 w-3" /> {w._count.attachments}</>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex -space-x-1.5">{w.assignees.slice(0, 4).map((a) => <span key={a.user.id} title={a.user.fullName}><Avatar name={a.user.fullName} size="sm" /></span>)}</div>
              {w.assignees.length > 4 && <span className="text-xs text-slate-500">+{w.assignees.length - 4}</span>}
              <Badge className={PRIORITY[w.priority]?.color}>{PRIORITY[w.priority]?.label ?? w.priority}</Badge>
              {w.dueAt && <span className={`text-xs ${w.isOverdue ? 'font-semibold text-rose-400' : 'text-slate-500'}`}><CalendarClock className="mr-0.5 inline h-3 w-3" />{fmtDate(w.dueAt)}</span>}
              <Badge className={WORK_STATUS[w.status].color}>{WORK_STATUS[w.status].label}</Badge>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── Client detail ─────────────────────────

export function ClientDetail() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const q = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Client & { works: Work[]; permissions: { canManage: boolean } }>(`/clients/${id}`) });
  const workId = params.get('work');

  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Client not found')} />;
  const c = q.data;
  const manage = c.permissions.canManage;
  const open = c.works.filter((w) => w.status !== 'DONE');
  const done = c.works.filter((w) => w.status === 'DONE');

  const remove = async () => {
    if (!confirm(`Delete ${c.name} and all ${c.works.length} work item(s), updates and files? This cannot be undone.`)) return;
    try { await api.del(`/clients/${id}`); invalidateAll(qc); toast.success('Client deleted'); nav('/clients'); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-5">
      <Link to="/clients" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Clients</Link>
      <PageHeader
        title={c.name}
        subtitle={<span className="flex flex-wrap items-center gap-2">{c.company && <span>{c.company}</span>}<Badge className={CLIENT_STATUS[c.status].color}>{CLIENT_STATUS[c.status].label}</Badge></span>}
        actions={manage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>
            <Button variant="secondary" onClick={remove} title="Delete client"><Trash2 className="h-4 w-4" /></Button>
            <Button onClick={() => setPosting(true)}><Send className="h-4 w-4" />Post work</Button>
          </div>
        )}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Client details" className="lg:order-2">
          <dl className="space-y-2.5 p-4 text-sm">
            <Row icon={<UserIcon className="h-4 w-4" />} label="Contact">{c.contactName || '—'}</Row>
            <Row icon={<Mail className="h-4 w-4" />} label="Email">{c.email ? <a className="text-indigo-700 hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '—'}</Row>
            <Row icon={<Phone className="h-4 w-4" />} label="Phone">{c.phone ? fmtPhone(c.phone) : '—'}</Row>
            <Row icon={<Building2 className="h-4 w-4" />} label="Added">{fmtDate(c.createdAt)} by {c.createdBy.fullName}</Row>
            {c.notes && <div className="border-t border-slate-100 pt-2.5"><p className="mb-1 text-xs font-medium uppercase text-slate-500">Notes</p><p className="whitespace-pre-wrap text-slate-700">{c.notes}</p></div>}
          </dl>
        </Card>
        <div className="space-y-5 lg:col-span-2">
          <Card title={`Open work (${open.length})`}>
            {open.length ? <WorkList items={open} /> : <Empty title="Nothing open" icon={<Briefcase className="h-8 w-8" />}>{manage ? 'Use "Post work" to give someone a job for this client.' : 'All your work for this client is done.'}</Empty>}
          </Card>
          {!!done.length && <Card title={`Done (${done.length})`}><WorkList items={done} /></Card>}
        </div>
      </div>
      {editing && <ClientModal client={c} onClose={() => setEditing(false)} />}
      {posting && <PostWorkModal clientId={id} clientName={c.name} onClose={() => setPosting(false)} />}
      {workId && <WorkDrawer id={workId} onClose={() => setParams({}, { replace: true })} />}
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <dt className="w-16 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

// ───────────────────────── Modals ─────────────────────────

function ClientModal({ client, onClose }: { client?: Client; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({
    name: client?.name ?? '', company: client?.company ?? '', contactName: client?.contactName ?? '', email: client?.email ?? '',
    phone: client?.phone ?? '', notes: client?.notes ?? '', status: client?.status ?? 'ACTIVE' as ClientStatus,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => (client ? api.patch<Client>(`/clients/${client.id}`, f) : api.post<Client>('/clients', f)),
    onSuccess: (c) => { invalidateAll(qc); toast.success(client ? 'Client updated' : 'Client added'); onClose(); if (!client) nav(`/clients/${c.id}`); },
  });
  return (
    <Modal open wide onClose={onClose} title={client ? `Edit ${client.name}` : 'Add client'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={f.name.trim().length < 2} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client name"><Input value={f.name} onChange={set('name')} placeholder="e.g. Sunrise Realty" autoFocus /></Field>
        <Field label="Company"><Input value={f.company} onChange={set('company')} /></Field>
        <Field label="Contact person"><Input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Status">
          <Select value={f.status} onChange={set('status')}>{Object.entries(CLIENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        </Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
      </div>
      <Field label="Notes"><Textarea rows={4} value={f.notes} onChange={set('notes')} placeholder="Scope, contract details, anything the team should know" /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

/** Like Field, but not a <label>: the picker holds its own checkbox labels. */
function GroupField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="group" aria-label={label}><span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>{children}</div>;
}

function PeoplePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const dir = useDirectory();
  const [q, setQ] = useState('');
  const people = useMemo(() => (dir.data ?? []).filter((u) => u.fullName.toLowerCase().includes(q.toLowerCase())), [dir.data, q]);
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-100 p-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" className="h-8" />
        <span className="shrink-0 text-xs text-slate-500">{value.length} chosen</span>
      </div>
      <div className="scroll-thin max-h-48 space-y-0.5 overflow-y-auto p-1.5">
        {dir.isLoading ? <Spinner /> : people.map((u) => (
          <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50">
            <input type="checkbox" checked={value.includes(u.id)} onChange={(e) => onChange(e.target.checked ? [...value, u.id] : value.filter((v) => v !== u.id))} />
            <Avatar name={u.fullName} size="sm" />{u.fullName}
          </label>
        ))}
      </div>
    </div>
  );
}

function PostWorkModal({ clientId, clientName, onClose }: { clientId: string; clientName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: '', description: '', priority: 'MEDIUM', dueAt: '', assigneeIds: [] as string[] });
  const m = useMutation({
    mutationFn: () => api.post(`/clients/${clientId}/work`, { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined }),
    onSuccess: () => { invalidateAll(qc); toast.success(`Work posted to ${f.assigneeIds.length} ${f.assigneeIds.length === 1 ? 'person' : 'people'}`); onClose(); },
  });
  return (
    <Modal open wide onClose={onClose} title={`Post work for ${clientName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={f.title.trim().length < 2 || !f.assigneeIds.length} onClick={() => m.mutate()}><Send className="h-4 w-4" />Post</Button></>}>
      <Field label="What needs doing"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Design 3 Instagram creatives for the Diwali offer" autoFocus /></Field>
      <Field label="Details" hint="Brief, links, expectations. The people you choose get a notification."><Textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        </Field>
        <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
      </div>
      <GroupField label="Post to"><PeoplePicker value={f.assigneeIds} onChange={(assigneeIds) => setF({ ...f, assigneeIds })} /></GroupField>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ───────────────────────── Work drawer ─────────────────────────

function WorkDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['work', id], queryFn: () => api.get<WorkDetail>(`/client-work/${id}`) });
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<WorkStatus | ''>('');
  const [editing, setEditing] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); invalidateAll(qc); toast.success(ok); return true; } catch (e) { toast.error(errMsg(e)); return false; }
  };
  const w = q.data;

  return (
    <Drawer open onClose={onClose} title={w && (
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate font-semibold">{w.title}</span>
        <Badge className={WORK_STATUS[w.status].color}>{WORK_STATUS[w.status].label}</Badge>
      </div>
    )}>
      {q.isLoading ? <Spinner /> : q.error || !w ? <div className="p-5"><ErrorBox error={q.error} /></div> : (
        <div className="space-y-6 p-5">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Meta label="Client">{w.client.name}</Meta>
            <Meta label="Priority"><Badge className={PRIORITY[w.priority]?.color}>{PRIORITY[w.priority]?.label}</Badge></Meta>
            <Meta label="Due"><span className={w.isOverdue ? 'font-semibold text-rose-400' : ''}>{w.dueAt ? fmtDateTime(w.dueAt) : '—'}</span></Meta>
            <Meta label="Posted by">{w.createdBy.fullName}</Meta>
          </div>
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Posted to</h3>
              {w.permissions.canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" />Edit work</Button>}
            </div>
            <div className="flex flex-wrap gap-2">
              {w.assignees.map((a) => <span key={a.user.id} className="flex items-center gap-1.5 rounded-full border border-slate-200 py-0.5 pl-0.5 pr-2.5 text-sm"><Avatar name={a.user.fullName} size="sm" />{a.user.fullName}</span>)}
            </div>
          </section>
          {w.description && <section><h3 className="mb-1.5 text-sm font-semibold">Details</h3><p className="whitespace-pre-wrap text-sm text-slate-700">{w.description}</p></section>}

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Files</h3>
              {w.permissions.canWork && (
                <>
                  <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => api.upload(`/client-work/${id}/attachments`, f), 'File attached'); e.target.value = ''; }} />
                  <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Paperclip className="h-3.5 w-3.5" />Attach</Button>
                </>
              )}
            </div>
            {!w.attachments.length ? <p className="text-sm text-slate-400">No files yet.</p> : (
              <ul className="space-y-1">
                {w.attachments.map((a) => (
                  <li key={a.id} className="group flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <FileText className="h-4 w-4 text-slate-400" />
                    <button className="flex-1 truncate text-left text-indigo-700 hover:underline" onClick={async () => {
                      try { window.open(await api.blobUrl(`/attachments/${a.id}`), '_blank'); } catch (e) { toast.error(errMsg(e)); }
                    }}>{a.fileName}</button>
                    <span className="hidden text-xs text-slate-400 sm:inline">{a.uploadedBy?.fullName} · {fmtBytes(a.sizeBytes)}</span>
                    {w.permissions.canWork && <button className="text-slate-300 hover:text-rose-500 sm:invisible sm:group-hover:visible" title="Delete file" onClick={() => confirm('Delete this file?') && run(() => api.del(`/attachments/${a.id}`), 'Deleted')}><Trash2 className="h-3.5 w-3.5" /></button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">Updates</h3>
            <ol className="space-y-3">
              {w.updates.map((u) => (
                <li key={u.id} className="flex gap-2.5">
                  <Avatar name={u.author.fullName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{u.author.fullName}</span>
                      {u.toStatus && u.fromStatus && <span className="text-slate-500"> moved it to <Badge className={WORK_STATUS[u.toStatus].color}>{WORK_STATUS[u.toStatus].label}</Badge></span>}
                      <span className="ml-2 text-xs text-slate-400" title={fmtDateTime(u.createdAt)}>{ago(u.createdAt)}</span>
                    </p>
                    {u.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{u.body}</p>}
                  </div>
                </li>
              ))}
            </ol>
            {w.permissions.canWork && (
              <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-3">
                <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Share progress, ask a question or describe what you delivered…" />
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={status} onChange={(e) => setStatus(e.target.value as WorkStatus | '')} className="w-full sm:w-60">
                    <option value="">Keep status ({WORK_STATUS[w.status].label})</option>
                    {w.permissions.allowedStatuses.filter((s) => s !== w.status).map((s) => <option key={s} value={s}>Move to {WORK_STATUS[s].label}</option>)}
                  </Select>
                  <Button className="ml-auto" disabled={!body.trim() && !status} onClick={async () => {
                    if (await run(() => api.post(`/client-work/${id}/updates`, { body: body || undefined, status: status || undefined }), 'Update posted')) { setBody(''); setStatus(''); }
                  }}><Send className="h-4 w-4" />Post update</Button>
                </div>
                {!w.permissions.canManage && <p className="text-xs text-slate-500">When you finish, move it to Submitted. A Super Admin reviews it and marks it Done. Admins see every update.</p>}
              </div>
            )}
          </section>
          {w.permissions.canManage && (
            <div className="border-t border-slate-100 pt-4">
              <Button variant="ghost" className="text-rose-500" onClick={async () => {
                if (confirm('Delete this work item with its updates and files?') && await run(() => api.del(`/client-work/${id}`), 'Work deleted')) onClose();
              }}><Trash2 className="h-4 w-4" />Delete work</Button>
            </div>
          )}
          {editing && <EditWorkModal work={w} onClose={() => setEditing(false)} />}
        </div>
      )}
    </Drawer>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="text-xs text-slate-500">{label}</p><div className="mt-0.5">{children}</div></div>;
}

function EditWorkModal({ work, onClose }: { work: WorkDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const local = (d: string | null) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [f, setF] = useState({
    title: work.title, description: work.description ?? '', priority: work.priority, dueAt: local(work.dueAt), assigneeIds: work.assignees.map((a) => a.user.id),
  });
  const m = useMutation({
    mutationFn: () => api.patch(`/client-work/${work.id}`, { ...f, description: f.description || null, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null }),
    onSuccess: () => { invalidateAll(qc); toast.success('Work updated'); onClose(); },
  });
  return (
    <Modal open wide onClose={onClose} title="Edit work"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={f.title.trim().length < 2 || !f.assigneeIds.length} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Details"><Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        </Field>
        <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
      </div>
      <GroupField label="Posted to"><PeoplePicker value={f.assigneeIds} onChange={(assigneeIds) => setF({ ...f, assigneeIds })} /></GroupField>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
