import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import clsx from 'clsx';
import {
  ArrowLeft, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, CalendarPlus, NotebookPen, ArrowRightLeft, UserPlus, UserMinus,
  Mail, MapPin, Megaphone, Pencil, CheckCircle2, Clock, XCircle, ListTodo, Copy,
} from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  CALL_OUTCOMES, CALL_STATUS, FOLLOW_UP_TYPES, LEAD_STATUS, ago, fmtDateTime, fmtDuration, fmtPhone, fmtRelativeDay, toLocalInput,
} from '../lib/format';
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Spinner, Tabs, Textarea } from '../components/ui';
import { AssignModal, CompleteFollowUpModal, FollowUpModal, LogCallModal, StatusModal } from '../components/LeadModals';
import { RecordingPlayer, UploadRecording } from '../components/Recording';
import { CreateTaskModal } from './Tasks';

interface Lead {
  id: string; fullName: string; phoneE164: string | null; email: string | null; city: string | null; status: string; closeReason: string | null;
  campaignName: string | null; adsetName: string | null; adName: string | null; formName: string | null; externalLeadId: string | null;
  sourceCreatedAt: string | null; createdAt: string; lastContactedAt: string | null; sourceData: Record<string, string> | null;
  source: { key: string; name: string }; assignedUser: { id: string; fullName: string; phone: string | null } | null;
  duplicateOf: { id: string; fullName: string; status: string } | null; duplicates: { id: string; fullName: string; status: string; createdAt: string }[];
  permissions: { canEdit: boolean; canAssign: boolean };
}
interface Actor { id: string; fullName: string }
interface Event { type: 'status' | 'assignment' | 'note' | 'call' | 'follow_up'; at: string; actor: Actor | null; data: Record<string, any> }
interface FollowUp { id: string; dueAt: string; type: string; note: string | null; status: string; isOverdue: boolean; owner: Actor; lead: { fullName: string } }
interface Call { id: string; status: string; durationSeconds: number | null; outcome: string | null }

const TERMINAL = ['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED'];

/** Extra answers from the website form / webhook (message, service, budget…), minus what's shown elsewhere. */
const SHOWN_KEYS = /^(id|lead_id|full_name|name|your_name|first_name|phone|phone_number|mobile|mobile_no|mobile_number|phone_no|contact_number|whatsapp|email|e_mail|email_address|city|campaign_name|adset_name|ad_name|form_name|created_time|timestamp|key|source)$/;
function formDetails(l: { sourceData: Record<string, string> | null }) {
  return Object.entries(l.sourceData ?? {}).filter(([k, v]) => v && String(v).trim() && !SHOWN_KEYS.test(k)).slice(0, 30);
}

function LiveCall({ callId, onDone }: { callId: string; onDone: (c: Call) => void }) {
  const { data } = useQuery({ queryKey: ['call', callId], queryFn: () => api.get<Call>(`/calls/${callId}`), refetchInterval: 2000 });
  const fired = useRef(false);
  useEffect(() => {
    if (data && TERMINAL.includes(data.status) && !fired.current) { fired.current = true; onDone(data); }
  }, [data, onDone]);
  const st = CALL_STATUS[data?.status ?? 'INITIATED'];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
      <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" /></span>
      <div className="text-sm">
        <p className="font-medium text-emerald-900">{st?.label ?? data?.status}</p>
        <p className="text-xs text-emerald-700">Your phone rings first. Answer it and you'll be connected to the customer.</p>
      </div>
    </div>
  );
}

function EditLeadModal({ lead, open, onClose }: { lead: Lead; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ fullName: lead.fullName, phone: lead.phoneE164 ?? '', email: lead.email ?? '', city: lead.city ?? '' });
  const m = useMutation({
    mutationFn: () => api.patch(`/leads/${lead.id}`, { fullName: f.fullName, phone: f.phone || null, email: f.email || null, city: f.city || null }),
    onSuccess: () => { toast.success('Lead updated'); qc.invalidateQueries({ queryKey: ['lead'] }); onClose(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit contact details"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Full name"><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
      <p className="text-xs text-slate-500">Fields you edit here won't be overwritten by future Google Sheets syncs.</p>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function RescheduleModal({ fu, onClose }: { fu: FollowUp | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { if (fu) setDueAt(toLocalInput(new Date(Math.max(Date.now() + 3600e3, new Date(fu.dueAt).getTime())))); }, [fu]);
  const m = useMutation({
    mutationFn: () => api.post(`/follow-ups/${fu!.id}/reschedule`, { dueAt: new Date(dueAt).toISOString(), reason: reason || undefined }),
    onSuccess: () => { toast.success('Rescheduled'); for (const k of ['timeline', 'follow-ups', 'leads', 'fu-summary']) qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  return (
    <Modal open={!!fu} onClose={onClose} title="Reschedule follow-up"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Reschedule</Button></>}>
      <Field label="New time"><Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
      <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer travelling" /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

export function FollowUpActions({ fu, onComplete, onReschedule }: { fu: FollowUp; onComplete: () => void; onReschedule: () => void }) {
  const qc = useQueryClient();
  const cancel = async () => {
    const reason = prompt('Why cancel this follow-up?');
    if (!reason) return;
    try {
      await api.post(`/follow-ups/${fu.id}/cancel`, { reason });
      toast.success('Follow-up cancelled');
      for (const k of ['timeline', 'follow-ups', 'leads', 'fu-summary']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="success" onClick={onComplete}><CheckCircle2 className="h-3.5 w-3.5" />Done</Button>
      <Button size="sm" variant="secondary" onClick={onReschedule}><Clock className="h-3.5 w-3.5" />Reschedule</Button>
      <Button size="sm" variant="ghost" onClick={cancel} title="Cancel"><XCircle className="h-3.5 w-3.5" /></Button>
    </div>
  );
}

function TimelineItem({ e, canEdit, meId }: { e: Event; canEdit: boolean; meId?: string }) {
  const who = e.actor ? (e.actor.id === meId ? 'You' : e.actor.fullName) : 'System';
  let icon = <NotebookPen className="h-4 w-4" />;
  let tone = 'bg-slate-100 text-slate-600';
  let body: React.ReactNode = null;
  let title: React.ReactNode = null;
  if (e.type === 'call') {
    const d = e.data;
    icon = d.direction === 'INBOUND' ? <PhoneIncoming className="h-4 w-4" /> : <PhoneOutgoing className="h-4 w-4" />;
    tone = d.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700';
    title = (
      <>
        <b>{who}</b> {d.direction === 'INBOUND' ? 'received a call from the customer' : 'called the customer'}
        {d.provider !== 'manual' && <Badge className="ml-2 bg-slate-100 text-slate-600">via {d.provider === 'mock' ? 'simulator' : d.provider}</Badge>}
      </>
    );
    body = (
      <div className="mt-1.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge className={CALL_STATUS[d.status]?.color}>{CALL_STATUS[d.status]?.label}</Badge>
          {d.outcome && <Badge className="bg-indigo-50 text-indigo-700">{CALL_OUTCOMES[d.outcome] ?? d.outcome}</Badge>}
          {d.durationSeconds ? <span className="text-slate-500">{fmtDuration(d.durationSeconds)}</span> : null}
          <span className="text-slate-400">{fmtPhone(d.fromNumber)} → {fmtPhone(d.toNumber)}</span>
        </div>
        {d.notes && <p className="whitespace-pre-wrap text-sm text-slate-700">{d.notes}</p>}
        {d.hasRecording ? <RecordingPlayer callId={d.id} canPlay={d.canPlayRecording} /> : canEdit && TERMINAL.includes(d.status) && d.status === 'COMPLETED' ? <UploadRecording callId={d.id} /> : null}
      </div>
    );
  } else if (e.type === 'note') {
    title = <><b>{who}</b> added a note</>;
    body = <p className="mt-1 whitespace-pre-wrap rounded-lg bg-amber-50/60 px-3 py-2 text-sm text-slate-700">{e.data.body}</p>;
    tone = 'bg-amber-100 text-amber-700';
  } else if (e.type === 'status') {
    icon = <ArrowRightLeft className="h-4 w-4" />;
    tone = 'bg-indigo-100 text-indigo-700';
    title = (
      <><b>{who}</b> changed status {e.data.from && <>from <Badge className={LEAD_STATUS[e.data.from]?.color}>{LEAD_STATUS[e.data.from]?.label}</Badge> </>}to <Badge className={LEAD_STATUS[e.data.to]?.color}>{LEAD_STATUS[e.data.to]?.label}</Badge></>
    );
    if (e.data.reason) body = <p className="mt-1 text-xs text-slate-500">{e.data.reason}</p>;
  } else if (e.type === 'assignment') {
    icon = <UserPlus className="h-4 w-4" />;
    tone = 'bg-sky-100 text-sky-700';
    title = <><b>{who}</b> assigned the lead to <b>{e.data.to?.fullName}</b>{e.data.method !== 'manual' && <span className="text-slate-500"> ({e.data.method.replace('_', '-')})</span>}</>;
    if (e.data.reason) body = <p className="mt-1 text-xs text-slate-500">{e.data.reason}</p>;
  } else if (e.type === 'follow_up') {
    icon = <CalendarPlus className="h-4 w-4" />;
    tone = 'bg-violet-100 text-violet-700';
    title = <><b>{who}</b> scheduled a {FOLLOW_UP_TYPES[e.data.followUpType]?.toLowerCase() ?? 'follow-up'} for <b>{fmtDateTime(e.data.dueAt)}</b>{e.data.owner && e.data.owner.id !== e.actor?.id && <> (owner: {e.data.owner.fullName})</>}</>;
    body = (
      <div className="mt-1 text-xs text-slate-500">
        {e.data.note && <p className="text-sm text-slate-700">{e.data.note}</p>}
        {e.data.status === 'COMPLETED' && <p className="text-emerald-700">✓ Completed {fmtDateTime(e.data.completedAt)}: {e.data.outcome}</p>}
        {e.data.status === 'CANCELLED' && <p>Cancelled</p>}
      </div>
    );
  }
  return (
    <li className="relative flex gap-3 pb-5">
      <span className={clsx('relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface', tone)}>{icon}</span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-slate-700">
          <span>{title}</span>
          <span className="whitespace-nowrap text-xs text-slate-400" title={fmtDateTime(e.at)}>{ago(e.at)}</span>
        </div>
        {body}
      </div>
    </li>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const qc = useQueryClient();
  const lead = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<Lead>(`/leads/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: () => api.get<Event[]>(`/leads/${id}/history`) });
  const pending = useQuery({ queryKey: ['follow-ups', 'lead', id], queryFn: () => api.get<{ items: FollowUp[] }>('/follow-ups', { leadId: id, view: 'pending', pageSize: 20 }) });
  const provider = useQuery({ queryKey: ['call-provider'], queryFn: () => api.get<{ provider: string; configured: boolean; simulated: boolean }>('/calls/provider'), staleTime: Infinity });
  const [modal, setModal] = useState<null | 'call' | 'followup' | 'status' | 'assign' | 'edit' | 'task'>(null);
  const [dispositionFor, setDispositionFor] = useState<string | null>(null);
  const [liveCall, setLiveCall] = useState<string | null>(null);
  const [complete, setComplete] = useState<FollowUp | null>(null);
  const [resched, setResched] = useState<FollowUp | null>(null);
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<'all' | 'call' | 'note' | 'follow_up' | 'status'>('all');

  const addNote = useMutation({
    mutationFn: () => api.post(`/leads/${id}/notes`, { body: note }),
    onSuccess: () => { setNote(''); qc.invalidateQueries({ queryKey: ['timeline', id] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const startCall = useMutation({
    mutationFn: () => api.post<{ id: string }>('/calls/click-to-call', { leadId: id }),
    onSuccess: (c) => { setLiveCall(c.id); qc.invalidateQueries({ queryKey: ['timeline', id] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const unassign = async () => {
    const reason = prompt('Reason for unassigning (optional)') ?? undefined;
    try { await api.post(`/leads/${id}/unassign`, { reason }); toast.success('Lead unassigned'); qc.invalidateQueries({ queryKey: ['lead', id] }); qc.invalidateQueries({ queryKey: ['timeline', id] }); }
    catch (e) { toast.error(errMsg(e)); }
  };

  if (lead.isLoading) return <Spinner />;
  if (lead.error || !lead.data) return <ErrorBox error={lead.error ?? 'Lead not found'} />;
  const l = lead.data;
  const { canEdit, canAssign } = l.permissions;
  const closed = ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'].includes(l.status);
  const events = (timeline.data ?? []).filter((e) => filter === 'all' || (filter === 'status' ? ['status', 'assignment'].includes(e.type) : e.type === filter));
  const counts = (t: string) => (timeline.data ?? []).filter((e) => e.type === t).length;

  return (
    <div>
      <Link to="/leads" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Leads</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar name={l.fullName} />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{l.fullName}</h1>
              <Badge className={LEAD_STATUS[l.status]?.color}>{LEAD_STATUS[l.status]?.label}</Badge>
            </div>
            <p className="text-sm text-slate-500">
              {l.assignedUser ? <>Owner: <b className="text-slate-700">{l.assignedUser.id === me?.id ? 'You' : l.assignedUser.fullName}</b></> : <span className="text-amber-600">Unassigned</span>}
              {' · '}received {ago(l.createdAt)}{l.lastContactedAt && <> · last spoke {ago(l.lastContactedAt)}</>}
            </p>
            {l.closeReason && <p className="text-sm text-slate-500">Reason: {l.closeReason}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && l.phoneE164 && !closed && (
            <Button variant="success" loading={startCall.isPending} disabled={!!liveCall} onClick={() => startCall.mutate()}
              title={provider.data?.simulated ? 'Simulated call (telephony provider not connected yet)' : 'Calls your phone, then connects the customer'}>
              <PhoneCall className="h-4 w-4" />Call{provider.data?.simulated ? ' (simulated)' : ''}
            </Button>
          )}
          {canEdit && <Button variant="secondary" onClick={() => setModal('call')}><Phone className="h-4 w-4" />Log call</Button>}
          {canEdit && !closed && <Button variant="secondary" onClick={() => setModal('followup')}><CalendarPlus className="h-4 w-4" />Follow-up</Button>}
          {canEdit && <Button variant="secondary" onClick={() => setModal('status')}><ArrowRightLeft className="h-4 w-4" />{closed ? 'Reopen' : 'Status'}</Button>}
          {canAssign && <Button variant="secondary" onClick={() => setModal('assign')}><UserPlus className="h-4 w-4" />{l.assignedUser ? 'Reassign' : 'Assign'}</Button>}
          {canAssign && l.assignedUser && <Button variant="ghost" onClick={unassign} title="Unassign"><UserMinus className="h-4 w-4" /></Button>}
          <Button variant="ghost" onClick={() => setModal('task')} title="Create a task linked to this lead"><ListTodo className="h-4 w-4" />Task</Button>
        </div>
      </div>

      {!canEdit && <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">You can view this lead, but only its owner{l.assignedUser ? ` (${l.assignedUser.fullName})` : ''} or a manager can update it.</div>}
      {liveCall && <div className="mb-4"><LiveCall callId={liveCall} onDone={(c) => {
        setLiveCall(null);
        qc.invalidateQueries({ queryKey: ['timeline', id] }); qc.invalidateQueries({ queryKey: ['lead', id] });
        toast.info(c.status === 'COMPLETED' ? `Call ended (${fmtDuration(c.durationSeconds)})` : `Call ${CALL_STATUS[c.status]?.label.toLowerCase()}`);
        setDispositionFor(c.id);
      }} /></div>}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Card title="Contact" actions={canEdit && <button onClick={() => setModal('edit')} className="text-slate-400 hover:text-indigo-600"><Pencil className="h-4 w-4" /></button>}>
            <dl className="space-y-2.5 p-4 text-sm">
              <div className="flex items-center gap-2"><Phone className="h-4 w-4 text-slate-400" />
                {l.phoneE164 ? <><a href={`tel:${l.phoneE164}`} className="font-medium text-indigo-700 hover:underline">{fmtPhone(l.phoneE164)}</a>
                  <button onClick={() => { navigator.clipboard.writeText(l.phoneE164!); toast.success('Copied'); }} className="text-slate-400 hover:text-slate-500"><Copy className="h-3.5 w-3.5" /></button></> : <span className="text-slate-400">No phone</span>}
              </div>
              <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-slate-400" />{l.email ? <a href={`mailto:${l.email}`} className="truncate hover:underline">{l.email}</a> : <span className="text-slate-400">No email</span>}</div>
              <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-slate-400" />{l.city ?? <span className="text-slate-400">—</span>}</div>
            </dl>
          </Card>
          <Card title="Source">
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2 p-4 text-sm">
              <dt className="text-slate-500">Source</dt><dd className="col-span-2">{l.source.name}</dd>
              <dt className="text-slate-500">Campaign</dt><dd className="col-span-2 flex items-center gap-1"><Megaphone className="h-3.5 w-3.5 text-slate-400" />{l.campaignName ?? '—'}</dd>
              <dt className="text-slate-500">Ad set</dt><dd className="col-span-2">{l.adsetName ?? '—'}</dd>
              <dt className="text-slate-500">Ad</dt><dd className="col-span-2">{l.adName ?? '—'}</dd>
              <dt className="text-slate-500">Form</dt><dd className="col-span-2">{l.formName ?? '—'}</dd>
              <dt className="text-slate-500">Submitted</dt><dd className="col-span-2">{fmtDateTime(l.sourceCreatedAt ?? l.createdAt)}</dd>
              {l.externalLeadId && !l.externalLeadId.startsWith('h:') && <><dt className="text-slate-500">{l.source.key === 'meta_ads' ? 'Meta ID' : 'Lead ID'}</dt><dd className="col-span-2 truncate font-mono text-xs">{l.externalLeadId}</dd></>}
            </dl>
          </Card>
          {formDetails(l).length > 0 && (
            <Card title="Form details">
              <dl className="space-y-2 p-4 text-sm">
                {formDetails(l).map(([k, v]) => (
                  <div key={k}><dt className="text-xs capitalize text-slate-500">{k.replace(/_/g, ' ')}</dt><dd className="whitespace-pre-wrap break-words">{v}</dd></div>
                ))}
              </dl>
            </Card>
          )}
          {(l.duplicateOf || l.duplicates.length > 0) && (
            <Card title="Duplicates">
              <div className="space-y-2 p-4 text-sm">
                {l.duplicateOf && <p>Duplicate of <Link className="text-indigo-700 hover:underline" to={`/leads/${l.duplicateOf.id}`}>{l.duplicateOf.fullName}</Link></p>}
                {l.duplicates.map((d) => <p key={d.id}>Re-submitted {ago(d.createdAt)}: <Link className="text-indigo-700 hover:underline" to={`/leads/${d.id}`}>{d.fullName}</Link></p>)}
              </div>
            </Card>
          )}
          <Card title="Upcoming follow-ups">
            {!pending.data?.items.length ? <p className="p-4 text-sm text-slate-500">None scheduled.</p> : (
              <ul className="divide-y divide-slate-100">
                {pending.data.items.map((f) => (
                  <li key={f.id} className="space-y-2 p-4">
                    <div className="flex items-center justify-between">
                      <span className={clsx('text-sm font-medium', f.isOverdue && 'text-rose-600')}>{f.isOverdue && 'Overdue · '}{fmtRelativeDay(f.dueAt)}</span>
                      <Badge className="bg-violet-50 text-violet-700">{FOLLOW_UP_TYPES[f.type] ?? f.type}</Badge>
                    </div>
                    {f.note && <p className="text-sm text-slate-600">{f.note}</p>}
                    {canEdit && <FollowUpActions fu={f} onComplete={() => setComplete(f)} onReschedule={() => setResched(f)} />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2">
          {canEdit && (
            <div className="border-b border-slate-100 p-4">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note about this customer…" rows={2}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && note.trim()) addNote.mutate(); }} />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-slate-400">Ctrl + Enter to save</span>
                <Button size="sm" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add note</Button>
              </div>
            </div>
          )}
          <div className="px-4 pt-2">
            <Tabs value={filter} onChange={setFilter} tabs={[
              { value: 'all', label: 'All activity' }, { value: 'call', label: 'Calls', count: counts('call') },
              { value: 'note', label: 'Notes', count: counts('note') }, { value: 'follow_up', label: 'Follow-ups', count: counts('follow_up') },
              { value: 'status', label: 'Status & owner' },
            ]} />
          </div>
          <div className="p-4">
            {timeline.isLoading ? <Spinner /> : !events.length ? <Empty title="No activity yet" /> : (
              <ul className="relative before:absolute before:bottom-4 before:left-4 before:top-2 before:w-px before:bg-slate-200">
                {events.map((e, i) => <TimelineItem key={i} e={e} canEdit={canEdit} meId={me?.id} />)}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <LogCallModal open={modal === 'call'} onClose={() => setModal(null)} leadId={l.id} />
      {dispositionFor && <LogCallModal open onClose={() => setDispositionFor(null)} leadId={l.id} callId={dispositionFor} />}
      <FollowUpModal open={modal === 'followup'} onClose={() => setModal(null)} leadId={l.id} />
      {modal === 'status' && <StatusModal open onClose={() => setModal(null)} lead={l} />}
      <AssignModal open={modal === 'assign'} onClose={() => setModal(null)} leadIds={[l.id]} />
      {modal === 'edit' && <EditLeadModal open lead={l} onClose={() => setModal(null)} />}
      {modal === 'task' && <CreateTaskModal open onClose={() => setModal(null)} defaults={{ leadId: l.id, title: `Follow up with ${l.fullName}` }} />}
      <CompleteFollowUpModal open={!!complete} onClose={() => setComplete(null)} followUp={complete} />
      <RescheduleModal fu={resched} onClose={() => setResched(null)} />
    </div>
  );
}

export { RescheduleModal };
