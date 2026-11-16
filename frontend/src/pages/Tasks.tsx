import { DragEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import clsx from 'clsx';
import {
  Building2, CheckSquare, KanbanSquare, List, MessageSquare, Paperclip, Plus, Search, Calendar, Trash2, Check, X, Link2, ShieldCheck, FileText,
} from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { sharesTeam, useDirectory, useTeams } from '../lib/hooks';
import { PRIORITY, TASK_STATUS, ago, fmtBytes, fmtDate, fmtDateTime, toLocalInput } from '../lib/format';
import {
  Avatar, Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, Th,
} from '../components/ui';

interface Person { id: string; fullName: string }
interface TaskRow {
  id: string; key: string; number: number; title: string; status: string; priority: string; position: number; dueAt: string | null;
  isOverdue: boolean; requiresReview: boolean; assignee: Person | null; assignees: { userId: string; user: Person }[]; createdBy: Person; team: { id: string; name: string } | null;
  lead: { id: string; fullName: string } | null; checklistDone: number;
  clients?: { clientId: string; client: { id: string; name: string } }[];
  _count: { comments: number; subtasks: number; attachments: number; checklist: number };
}
interface TaskFull extends Omit<TaskRow, '_count' | 'checklistDone'> {
  description: string | null; startAt: string | null; reviewNote: string | null; createdAt: string; completedAt: string | null;
  parent: { id: string; number: number; title: string } | null;
  subtasks: { id: string; key: string; title: string; status: string; assignee: Person | null }[];
  checklist: { id: string; text: string; done: boolean }[];
  comments: { id: string; body: string; createdAt: string; author: Person }[];
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; uploadedBy: Person | null }[];
  activities: { id: string; action: string; detail: Record<string, any> | null; createdAt: string; actor: Person | null }[];
  permissions: { canManage: boolean; canWork: boolean };
}

const COLUMNS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];

function useAssignees() {
  const { me, can } = useAuth();
  const dir = useDirectory();
  if (!can('tasks.create_for_others')) return dir.data?.filter((u) => u.id === me?.id) ?? [];
  if (can('tasks.manage.all')) return dir.data ?? [];
  return dir.data?.filter((u) => u.id === me?.id || sharesTeam(u, me?.teamIds)) ?? [];
}

/** Everyone on a task, first person first. Falls back to the single assignee for older rows. */
const peopleOf = (t: { assignee: Person | null; assignees?: { user: Person }[] }): Person[] =>
  t.assignees?.length ? t.assignees.map((a) => a.user) : t.assignee ? [t.assignee] : [];

/** Chips for the chosen people, and a menu to add more. */
function PeoplePicker({ value, onChange, options, extra = [], disabled, meId }: {
  value: string[]; onChange: (v: string[]) => void; options: Person[]; extra?: Person[]; disabled?: boolean; meId?: string;
}) {
  const all = [...options, ...extra.filter((e) => !options.some((o) => o.id === e.id))];
  const name = (id: string) => all.find((p) => p.id === id)?.fullName ?? 'Someone';
  const left = options.filter((o) => !value.includes(o.id));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {!value.length && <span className="py-1 text-sm text-slate-400">No one yet</span>}
        {value.map((id) => (
          <span key={id} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-1.5 text-sm text-slate-700">
            <Avatar name={name(id)} size="sm" />{name(id)}{id === meId && <span className="text-xs text-slate-400">(me)</span>}
            {!disabled && <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} aria-label={`Remove ${name(id)}`} className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X className="h-3.5 w-3.5" /></button>}
          </span>
        ))}
      </div>
      {!disabled && left.length > 0 && (
        <Select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label="Add a person">
          <option value="">+ Add a person…</option>
          {left.map((u) => <option key={u.id} value={u.id}>{u.id === meId ? `${u.fullName} (me)` : u.fullName}</option>)}
        </Select>
      )}
    </div>
  );
}

interface ClientOption { id: string; name: string; status: string }
const useClientDirectory = () => useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<ClientOption[]>('/clients/directory'), staleTime: 60_000 });

/** Tick the clients this task is for. Every client is listed, with a search box. */
function ClientPicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const dir = useClientDirectory();
  const [q, setQ] = useState('');
  const all = dir.data ?? [];
  const shown = all.filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const picked = all.filter((c) => value.includes(c.id));
  if (disabled) return <p className="text-sm text-slate-700">{picked.length ? picked.map((c) => c.name).join(', ') : <span className="text-slate-400">No client</span>}</p>;
  return (
    <div className="rounded-xl border border-slate-200">
      {all.length > 8 && <div className="border-b border-slate-100 p-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients…" aria-label="Search clients" /></div>}
      <div className="scroll-thin grid max-h-44 gap-0.5 overflow-y-auto p-1.5 sm:grid-cols-2">
        {dir.isLoading && <p className="px-2 py-1 text-sm text-slate-400">Loading clients…</p>}
        {!dir.isLoading && !shown.length && <p className="px-2 py-1 text-sm text-slate-400">{all.length ? 'No match' : 'No clients yet'}</p>}
        {shown.map((c) => (
          <label key={c.id} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm', value.includes(c.id) ? 'bg-indigo-50 text-slate-900' : 'hover:bg-slate-50')}>
            <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
            <span className="truncate">{c.name}</span>
            {c.status !== 'ACTIVE' && <span className="ml-auto shrink-0 text-[10px] uppercase text-slate-400">{c.status.replace('_', ' ').toLowerCase()}</span>}
          </label>
        ))}
      </div>
      {value.length > 0 && <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-500">{value.length} selected: {picked.map((c) => c.name).join(', ')}</p>}
    </div>
  );
}

export function CreateTaskModal({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: { leadId?: string; title?: string; parentId?: string; status?: string; clientIds?: string[] } }) {
  const { me } = useAuth();
  const assignees = useAssignees();
  const teams = useTeams();
  const qc = useQueryClient();
  const [f, setF] = useState({ title: defaults?.title ?? '', description: '', assigneeIds: me?.id ? [me.id] : [] as string[], clientIds: defaults?.clientIds ?? [] as string[], priority: 'MEDIUM', dueAt: '', teamId: '', requiresReview: false });
  const m = useMutation({
    mutationFn: () => api.post('/tasks', {
      title: f.title, description: f.description || undefined, assigneeIds: f.assigneeIds, clientIds: f.clientIds, priority: f.priority,
      dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined, teamId: f.teamId || undefined, requiresReview: f.requiresReview,
      leadId: defaults?.leadId, parentId: defaults?.parentId,
    }),
    onSuccess: () => { toast.success('Task created'); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['task'] }); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title={defaults?.parentId ? 'New subtask' : 'New task'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={f.title.trim().length < 2} onClick={() => m.mutate()}>Create task</Button></>}>
      <Field label="Title"><Input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What needs to be done?" /></Field>
      <Field label="Description"><Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Details, expected outcome, links…" /></Field>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Assigned to</p>
        <PeoplePicker value={f.assigneeIds} onChange={(v) => setF({ ...f, assigneeIds: v })} options={assignees} meId={me?.id} />
        {f.assigneeIds.length > 1 && <p className="mt-1 text-xs text-slate-500">One shared task: they all see it, can move it and get its updates.</p>}
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Client (optional)</p>
        <ClientPicker value={f.clientIds} onChange={(v) => setF({ ...f, clientIds: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </Field>
        <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Team (optional)">
          <Select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
            <option value="">—</option>
            {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.requiresReview} onChange={(e) => setF({ ...f, requiresReview: e.target.checked })} />Requires manager review before it can be marked done</label>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function TaskCard({ t, onOpen, onDragStart, onMove }: { t: TaskRow; onOpen: () => void; onDragStart: (e: DragEvent) => void; onMove: (status: string) => void }) {
  return (
    <div draggable onDragStart={onDragStart} onClick={onOpen}
      className="min-w-0 cursor-pointer rounded-lg border border-slate-200 bg-surface p-3 shadow-sm transition hover:border-indigo-300 hover:shadow">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-slate-400">{t.key}</span>
        <Badge className={PRIORITY[t.priority].color}>{PRIORITY[t.priority].label}</Badge>
      </div>
      <p className="text-sm font-medium leading-snug text-slate-800 [overflow-wrap:anywhere]">{t.title}</p>
      {t.lead && <p className="mt-1 flex items-center gap-1 text-xs text-indigo-700"><Link2 className="h-3 w-3" />{t.lead.fullName}</p>}
      {!!t.clients?.length && (
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-slate-500" title={t.clients.map((c) => c.client.name).join(', ')}>
          <Building2 className="h-3 w-3 shrink-0" /><span className="truncate">{t.clients[0].client.name}{t.clients.length > 1 && ` +${t.clients.length - 1}`}</span>
        </p>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400">
          {t.dueAt && <span className={clsx('flex items-center gap-0.5', t.isOverdue && 'font-semibold text-rose-600')}><Calendar className="h-3 w-3" />{fmtDate(t.dueAt)}</span>}
          {t._count.checklist > 0 && <span className="flex items-center gap-0.5"><CheckSquare className="h-3 w-3" />{t.checklistDone}/{t._count.checklist}</span>}
          {t._count.comments > 0 && <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{t._count.comments}</span>}
          {t._count.attachments > 0 && <span className="flex items-center gap-0.5"><Paperclip className="h-3 w-3" />{t._count.attachments}</span>}
          {t.requiresReview && <span title="Requires review"><ShieldCheck className="h-3 w-3" /></span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Touch screens can't drag, so offer a quick status menu. */}
          <select
            aria-label="Move task"
            value={t.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onMove(e.target.value)}
            className="rounded-md border border-slate-300 bg-surface px-1.5 py-0.5 text-[11px] text-slate-600 md:hidden"
          >
            {COLUMNS.map((c) => <option key={c} value={c}>{c === t.status ? 'Move…' : TASK_STATUS[c].label}</option>)}
          </select>
          <AvatarStack people={peopleOf(t)} />
        </div>
      </div>
    </div>
  );
}

function AvatarStack({ people, max = 3 }: { people: Person[]; max?: number }) {
  if (!people.length) return <span className="text-[11px] text-slate-400">Unassigned</span>;
  return (
    <span className="flex -space-x-1.5" title={people.map((p) => p.fullName).join(', ')}>
      {people.slice(0, max).map((p) => <span key={p.id} className="rounded-full ring-2 ring-white"><Avatar name={p.fullName} size="sm" /></span>)}
      {people.length > max && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-600 ring-2 ring-white">+{people.length - max}</span>}
    </span>
  );
}

function activityText(a: TaskFull['activities'][number]) {
  const d = a.detail ?? {};
  switch (a.action) {
    case 'created': return 'created the task';
    case 'status_changed': return `moved it from ${TASK_STATUS[d.from]?.label} to ${TASK_STATUS[d.to]?.label}`;
    case 'review_approved': return 'approved the review';
    case 'review_rejected': return 'requested changes';
    case 'attachment_added': return `attached ${d.fileName}`;
    case 'description_updated': return 'updated the description';
    case 'updated': return `changed ${Object.keys(d).map((k) => (k === 'assignees' ? 'who is assigned' : k.replace(/Id$/, '').replace(/At$/, ' date'))).join(', ')}`;
    default: return a.action;
  }
}

type Draft = { title: string; description: string; priority: string; assigneeIds: string[]; clientIds: string[]; due: string; requiresReview: boolean };
const toDraft = (t: TaskFull): Draft => ({
  title: t.title, description: t.description ?? '', priority: t.priority, assigneeIds: peopleOf(t).map((p) => p.id),
  clientIds: (t.clients ?? []).map((c) => c.clientId),
  due: t.dueAt ? toLocalInput(new Date(t.dueAt)) : '', requiresReview: t.requiresReview,
});

function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const assignees = useAssignees();
  const { data: t, isLoading, error } = useQuery({ queryKey: ['task', id], queryFn: () => api.get<TaskFull>(`/tasks/${id}`) });
  const [comment, setComment] = useState('');
  const [item, setItem] = useState('');
  // Edits are kept here until Save changes, so refreshes from comments or the checklist don't wipe them.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [sub, setSub] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['tasks'] }); };
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try { await fn(); if (okMsg) toast.success(okMsg); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  useEffect(() => { setDraft(null); }, [id]);

  if (isLoading) return <Drawer open onClose={onClose}><Spinner /></Drawer>;
  if (error || !t) return <Drawer open onClose={onClose}><div className="p-5"><ErrorBox error={error ?? 'Not found'} /></div></Drawer>;
  const { canManage, canWork } = t.permissions;
  const saved = toDraft(t);
  const d = draft ?? saved;
  const edit = (change: Partial<Draft>) => setDraft({ ...d, ...change });
  const changes: Record<string, unknown> = {};
  if (d.title.trim() !== saved.title) changes.title = d.title.trim();
  if (d.description !== saved.description) changes.description = d.description;
  if (d.priority !== saved.priority) changes.priority = d.priority;
  if (d.assigneeIds.join() !== saved.assigneeIds.join()) changes.assigneeIds = d.assigneeIds;
  if ([...d.clientIds].sort().join() !== [...saved.clientIds].sort().join()) changes.clientIds = d.clientIds;
  if (d.due !== saved.due) changes.dueAt = d.due ? new Date(d.due).toISOString() : null;
  if (d.requiresReview !== saved.requiresReview) changes.requiresReview = d.requiresReview;
  const dirty = Object.keys(changes).length > 0;
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/tasks/${id}`, changes);
      // Wait for the saved task before dropping the edits, so the old values don't flash back.
      await qc.invalidateQueries({ queryKey: ['task', id] });
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('Task saved');
    }
    catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  };
  const close = () => { if (!dirty || confirm('Discard your unsaved changes to this task?')) onClose(); };

  return (
    <Drawer open onClose={close} title={
      <div className="flex items-center gap-2 text-sm">
        {t.parent && <><button className="text-slate-500 hover:underline" onClick={() => qc.setQueryData(['open-task'], t.parent!.id)}>PRS-{t.parent.number}</button><span className="text-slate-400">/</span></>}
        <span className="font-mono text-slate-500">{t.key}</span>
        <Badge className={TASK_STATUS[t.status].color}>{TASK_STATUS[t.status].label}</Badge>
        {t.isOverdue && <Badge className="bg-rose-100 text-rose-700">Overdue</Badge>}
      </div>
    }>
      <div className="space-y-6 p-5">
        <div>
          {canManage ? (
            <Field label="Title"><Input value={d.title} onChange={(e) => edit({ title: e.target.value })} className="text-base font-semibold" /></Field>
          ) : (
            <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{t.title}</h2>
          )}
          <p className="mt-1 text-xs text-slate-500">Created by {t.createdBy.fullName} {ago(t.createdAt)}</p>
        </div>

        {t.status === 'REVIEW' && canManage && !peopleOf(t).some((p) => p.id === me?.id) && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3">
            <span className="flex-1 text-sm text-violet-900">This task is waiting for your review.</span>
            <Button size="sm" variant="success" onClick={() => run(() => api.post(`/tasks/${id}/review`, { decision: 'approve' }), 'Approved')}><Check className="h-4 w-4" />Approve</Button>
            <Button size="sm" variant="danger" onClick={() => { const note = prompt('What needs to change?'); if (note) run(() => api.post(`/tasks/${id}/review`, { decision: 'reject', note }), 'Sent back'); }}><X className="h-4 w-4" />Request changes</Button>
          </div>
        )}
        {t.reviewNote && t.status !== 'DONE' && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><b>Review note:</b> {t.reviewNote}</div>}

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Field label="Status" hint="Saves straight away.">
            <Select value={t.status} disabled={!canWork} onChange={(e) => run(() => api.post(`/tasks/${id}/move`, { status: e.target.value }))}>
              {COLUMNS.map((c) => <option key={c} value={c}>{TASK_STATUS[c].label}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={d.priority} disabled={!canManage} onChange={(e) => edit({ priority: e.target.value })}>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <div className="col-span-2">
            <p className="mb-1 text-sm font-medium text-slate-700">Assigned to</p>
            <PeoplePicker value={d.assigneeIds} onChange={(v) => edit({ assigneeIds: v })} options={assignees} extra={peopleOf(t)} disabled={!canManage} meId={me?.id} />
          </div>
          <div className="col-span-2">
            <p className="mb-1 text-sm font-medium text-slate-700">Client</p>
            <ClientPicker value={d.clientIds} onChange={(v) => edit({ clientIds: v })} disabled={!canManage} />
          </div>
          <Field label="Due">
            <Input type="datetime-local" disabled={!canManage} value={d.due} onChange={(e) => edit({ due: e.target.value })} />
          </Field>
          {t.lead && <div className="col-span-2 text-sm">Linked lead: <Link to={`/leads/${t.lead.id}`} className="text-indigo-700 hover:underline">{t.lead.fullName}</Link></div>}
          {canManage && (
            <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={d.requiresReview} onChange={(e) => edit({ requiresReview: e.target.checked })} />Requires manager review
            </label>
          )}
        </div>

        <section>
          <h3 className="mb-1.5 text-sm font-semibold">Description</h3>
          {canWork ? (
            <Textarea rows={5} value={d.description} onChange={(e) => edit({ description: e.target.value })} placeholder="Add a description…" />
          ) : (
            <div className="min-h-12 whitespace-pre-wrap rounded-lg p-2 text-sm text-slate-700">
              {t.description || <span className="text-slate-400">No description</span>}
            </div>
          )}
        </section>

        {(canManage || canWork) && (
          <div className="sticky bottom-0 z-10 -mx-5 flex items-center justify-end gap-2 border-t border-slate-200 bg-surface px-5 py-3">
            {dirty && <span className="mr-auto text-xs text-amber-700">Unsaved changes</span>}
            <Button variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(null)}>Discard</Button>
            <Button loading={saving} disabled={!dirty || d.title.trim().length < 2} onClick={save}>Save changes</Button>
          </div>
        )}

        <section>
          <h3 className="mb-1.5 text-sm font-semibold">Checklist {t.checklist.length > 0 && <span className="font-normal text-slate-400">{t.checklist.filter((c) => c.done).length}/{t.checklist.length}</span>}</h3>
          {t.checklist.length > 0 && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(t.checklist.filter((c) => c.done).length / t.checklist.length) * 100}%` }} />
            </div>
          )}
          <ul className="space-y-1">
            {t.checklist.map((c) => (
              <li key={c.id} className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                <input type="checkbox" checked={c.done} disabled={!canWork} onChange={(e) => run(() => api.patch(`/tasks/${id}/checklist/${c.id}`, { done: e.target.checked }))} />
                <span className={clsx('flex-1 text-sm', c.done && 'text-slate-400 line-through')}>{c.text}</span>
                {canWork && <button className="invisible text-slate-400 hover:text-rose-500 group-hover:visible" onClick={() => run(() => api.del(`/tasks/${id}/checklist/${c.id}`))}><Trash2 className="h-3.5 w-3.5" /></button>}
              </li>
            ))}
          </ul>
          {canWork && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (item.trim()) run(() => api.post(`/tasks/${id}/checklist`, { text: item })).then(() => setItem('')); }}>
              <Input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Add an item" /><Button size="sm" variant="secondary" type="submit">Add</Button>
            </form>
          )}
        </section>

        {!t.parent && (
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Subtasks</h3>
              {canWork && <Button size="sm" variant="ghost" onClick={() => setSub(true)}><Plus className="h-3.5 w-3.5" />Add</Button>}
            </div>
            {!t.subtasks.length ? <p className="text-sm text-slate-400">No subtasks.</p> : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {t.subtasks.map((s) => (
                  <li key={s.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50" onClick={() => qc.setQueryData(['open-task'], s.id)}>
                    <span className={clsx('h-2 w-2 rounded-full', TASK_STATUS[s.status].dot)} />
                    <span className="font-mono text-xs text-slate-400">{s.key}</span>
                    <span className={clsx('flex-1', s.status === 'DONE' && 'text-slate-400 line-through')}>{s.title}</span>
                    {s.assignee && <Avatar name={s.assignee.fullName} size="sm" />}
                  </li>
                ))}
              </ul>
            )}
            {sub && <CreateTaskModal open onClose={() => setSub(false)} defaults={{ parentId: id }} />}
          </section>
        )}

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Attachments</h3>
            {canWork && (
              <>
                <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => api.upload(`/tasks/${id}/attachments`, f), 'File attached'); e.target.value = ''; }} />
                <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Paperclip className="h-3.5 w-3.5" />Attach</Button>
              </>
            )}
          </div>
          {!t.attachments.length ? <p className="text-sm text-slate-400">No files. Images, PDFs, Office files and CSV up to 25 MB.</p> : (
            <ul className="space-y-1">
              {t.attachments.map((a) => (
                <li key={a.id} className="group flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 text-slate-400" />
                  <button className="flex-1 truncate text-left text-indigo-700 hover:underline" onClick={async () => {
                    try { const url = await api.blobUrl(`/attachments/${a.id}`); window.open(url, '_blank'); } catch (e) { toast.error(errMsg(e)); }
                  }}>{a.fileName}</button>
                  <span className="text-xs text-slate-400">{fmtBytes(a.sizeBytes)}</span>
                  {canWork && <button className="invisible text-slate-400 hover:text-rose-500 group-hover:visible" onClick={() => confirm('Delete this file?') && run(() => api.del(`/attachments/${a.id}`), 'Deleted')}><Trash2 className="h-3.5 w-3.5" /></button>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Comments</h3>
          <ul className="space-y-3">
            {t.comments.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar name={c.author.fullName} size="sm" />
                <div className="flex-1 rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-xs"><b>{c.author.fullName}</b> <span className="text-slate-400">{ago(c.createdAt)}</span></p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" />
            <Button disabled={!comment.trim()} onClick={() => run(() => api.post(`/tasks/${id}/comments`, { body: comment })).then(() => setComment(''))}>Send</Button>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">History</h3>
          <ul className="space-y-1.5 text-xs text-slate-500">
            {t.activities.map((a) => <li key={a.id}><b className="text-slate-700">{a.actor?.fullName ?? 'System'}</b> {activityText(a)} · <span title={fmtDateTime(a.createdAt)}>{ago(a.createdAt)}</span></li>)}
          </ul>
        </section>

        {canManage && (
          <div className="border-t border-slate-100 pt-4">
            <Button variant="ghost" className="text-rose-600" onClick={async () => {
              if (!confirm('Delete this task and its subtasks?')) return;
              try { await api.del(`/tasks/${id}`); toast.success('Task deleted'); qc.invalidateQueries({ queryKey: ['tasks'] }); onClose(); } catch (e) { toast.error(errMsg(e)); }
            }}><Trash2 className="h-4 w-4" />Delete task</Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

export default function Tasks() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const dir = useDirectory();
  const [sp, setSp] = useSearchParams();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [search, setSearch] = useState('');
  const [due, setDue] = useState(sp.get('due') ?? '');
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [mobileCol, setMobileCol] = useState('TODO');
  const openId = useQuery({ queryKey: ['open-task'], queryFn: () => sp.get('open'), initialData: sp.get('open'), staleTime: Infinity }).data;
  const setOpen = (id: string | null) => {
    qc.setQueryData(['open-task'], id);
    const n = new URLSearchParams(sp); if (id) n.set('open', id); else n.delete('open'); setSp(n, { replace: true });
  };
  useEffect(() => { const o = sp.get('open'); if (o && o !== openId) qc.setQueryData(['open-task'], o); }, [sp]); // eslint-disable-line

  const q = { assignee, priority, search, due };
  const { data, isLoading } = useQuery({ queryKey: ['tasks', q], queryFn: () => api.get<TaskRow[]>('/tasks', q) });

  const move = async (taskId: string, status: string, beforeId?: string) => {
    const col = (data ?? []).filter((t) => t.status === status && t.id !== taskId).sort((a, b) => a.position - b.position);
    let position: number;
    if (beforeId) {
      const idx = col.findIndex((t) => t.id === beforeId);
      const prev = col[idx - 1]?.position ?? (col[idx]?.position ?? 0) - 2000;
      position = (prev + (col[idx]?.position ?? prev + 2000)) / 2;
    } else position = (col[col.length - 1]?.position ?? 0) + 1000;
    // Optimistic update so the card moves immediately.
    qc.setQueryData<TaskRow[]>(['tasks', q], (old) => old?.map((t) => (t.id === taskId ? { ...t, status, position } : t)));
    try { await api.post(`/tasks/${taskId}/move`, { status, position }); } catch (e) { toast.error(errMsg(e)); }
    qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const onDrop = (e: DragEvent, status: string, beforeId?: string) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task');
    if (id && id !== beforeId) move(id, status, beforeId);
  };

  const byCol = (col: string) => (data ?? []).filter((t) => t.status === col).sort((a, b) => a.position - b.position);

  const column = (col: string, mobile = false) => {
    const items = byCol(col);
    return (
      <div key={col} onDragOver={(e) => { e.preventDefault(); setDragOver(col); }} onDragLeave={() => setDragOver(null)} onDrop={(e) => onDrop(e, col)}
        className={clsx('flex min-w-0 snap-start flex-col rounded-xl bg-slate-100/50 p-2.5 transition', dragOver === col && 'bg-indigo-50 ring-2 ring-indigo-300')}>
        {!mobile && (
          <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
            <span className="flex min-w-0 items-center gap-2 truncate text-xs font-semibold uppercase tracking-wide text-slate-600"><span className={clsx('h-2 w-2 shrink-0 rounded-full', TASK_STATUS[col].dot)} />{TASK_STATUS[col].label}</span>
            <span className="rounded-full bg-surface px-2 text-xs text-slate-500">{items.length}</span>
          </div>
        )}
        <div className="flex min-h-24 flex-1 flex-col gap-2">
          {items.map((t) => (
            <div key={t.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, col, t.id)}>
              <TaskCard t={t} onOpen={() => setOpen(t.id)} onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                onMove={(status) => move(t.id, status)} />
            </div>
          ))}
          {!items.length && mobile && <p className="py-8 text-center text-sm text-slate-500">No tasks in {TASK_STATUS[col].label.toLowerCase()}.</p>}
          {col === 'TODO' && <button onClick={() => setCreating(true)} className="rounded-lg border border-dashed border-slate-300 py-2 text-sm text-slate-500 hover:border-indigo-400 hover:text-indigo-700"><Plus className="inline h-4 w-4" /> Add task</button>}
        </div>
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <PageHeader title="Tasks" subtitle={can('tasks.view.all') ? 'Plan, assign and review work. Drag cards between columns, or use Move on a card.' : 'Your tasks: the ones assigned to you and the ones you added. Drag cards between columns, or use Move on a card.'}
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New task</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <div className="col-span-2 flex rounded-lg border border-slate-300 bg-surface p-0.5 sm:col-span-1">
          <button onClick={() => setView('board')} className={clsx('flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1 text-sm', view === 'board' ? 'bg-slate-900 text-white' : 'text-slate-600')}><KanbanSquare className="h-4 w-4" />Board</button>
          <button onClick={() => setView('list')} className={clsx('flex flex-1 items-center justify-center gap-1 rounded-md px-2.5 py-1 text-sm', view === 'list' ? 'bg-slate-900 text-white' : 'text-slate-600')}><List className="h-4 w-4" />List</button>
        </div>
        <div className="relative col-span-2 sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or PRS-12" className="pl-9" />
        </div>
        {/* Only Admins and Super Admins see other people's tasks, so only they get the person filter. */}
        {can('tasks.view.all') && (
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full sm:w-44" aria-label="Whose tasks">
            <option value="">Everyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
            {dir.data?.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        )}
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full sm:w-36">
          <option value="">Any priority</option>
          {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select value={due} onChange={(e) => setDue(e.target.value)} className="col-span-2 w-full sm:w-40">
          <option value="">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Due this week</option>
        </Select>
      </div>

      {isLoading ? <Spinner /> : view === 'board' ? (
        <>
          {/* Phones: one column at a time, picked with status tabs */}
          <div className="md:hidden">
            <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {COLUMNS.map((col) => (
                <button key={col} onClick={() => setMobileCol(col)}
                  className={clsx('flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium', mobileCol === col ? 'bg-slate-900 text-white' : 'bg-surface text-slate-600 ring-1 ring-slate-200')}>
                  <span className={clsx('h-2 w-2 rounded-full', TASK_STATUS[col].dot)} />{TASK_STATUS[col].label}
                  <span className={clsx('rounded-full px-1.5 text-xs', mobileCol === col ? 'bg-white/20' : 'bg-slate-100')}>{byCol(col).length}</span>
                </button>
              ))}
            </div>
            {column(mobileCol, true)}
          </div>
          {/* Tablets: swipeable columns inside the page. Large screens: all five fit side by side. */}
          <div className="scroll-thin hidden snap-x gap-3 overflow-x-auto pb-3 md:grid md:auto-cols-[minmax(15rem,1fr)] md:grid-flow-col xl:grid-flow-row xl:grid-cols-5 xl:overflow-visible">
            {COLUMNS.map((col) => column(col))}
          </div>
        </>
      ) : (
        <Card>
          {!data?.length ? <Empty title="No tasks" /> : (
            <Table>
              <thead><tr><Th>Key</Th><Th>Title</Th><Th>Status</Th><Th>Priority</Th><Th>Assigned to</Th><Th>Due</Th><Th>Progress</Th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(t.id)}>
                    <Td className="font-mono text-xs text-slate-500">{t.key}</Td>
                    <Td className="max-w-md font-medium [overflow-wrap:anywhere]">{t.title}{t.lead && <span className="ml-2 text-xs text-indigo-700">· {t.lead.fullName}</span>}</Td>
                    <Td><Badge className={TASK_STATUS[t.status].color}>{TASK_STATUS[t.status].label}</Badge></Td>
                    <Td><Badge className={PRIORITY[t.priority].color}>{PRIORITY[t.priority].label}</Badge></Td>
                    <Td>{peopleOf(t).length ? <span className="flex items-center gap-2"><AvatarStack people={peopleOf(t)} /><span className="max-w-56 truncate">{peopleOf(t).map((p) => p.fullName).join(', ')}</span></span> : '—'}</Td>
                    <Td className={clsx('whitespace-nowrap', t.isOverdue && 'font-semibold text-rose-600')}>{fmtDate(t.dueAt)}</Td>
                    <Td className="text-xs text-slate-500">{t._count.checklist ? `${t.checklistDone}/${t._count.checklist} items` : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {creating && <CreateTaskModal open onClose={() => setCreating(false)} />}
      {openId && <TaskDrawer id={openId} onClose={() => setOpen(null)} />}
    </div>
  );
}
