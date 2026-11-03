import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { CALL_OUTCOMES, FOLLOW_UP_TYPES, LEAD_STATUS, toLocalInput } from '../lib/format';
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea } from './ui';

function useInvalidateLead() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['leads', 'lead', 'timeline', 'follow-ups', 'fu-summary', 'calls', 'dashboard', 'notifications']) qc.invalidateQueries({ queryKey: [k] });
  };
}

/** People the current user may assign leads to (all users, or own team for team leaders). */
function useAssignableUsers() {
  const { me, can } = useAuth();
  const dir = useDirectory();
  return useMemo(
    () => (dir.data ?? []).filter((u) => can('leads.assign.all') || (u.teamId && me?.teamIds.includes(u.teamId)) || u.id === me?.id),
    [dir.data, me, can],
  );
}

export function AssignModal({ open, onClose, leadIds, onDone }: { open: boolean; onClose: () => void; leadIds: string[]; onDone?: () => void }) {
  const users = useAssignableUsers();
  const [method, setMethod] = useState<'manual' | 'round_robin' | 'workload'>('manual');
  const [userId, setUserId] = useState('');
  const [pool, setPool] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const invalidate = useInvalidateLead();

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ assigned: number; skipped: number }>('/leads/assign', {
        leadIds, method, ...(method === 'manual' ? { userId } : { userIds: pool }), reason: reason || undefined,
      });
      toast.success(`${r.assigned} lead${r.assigned === 1 ? '' : 's'} assigned${r.skipped ? ` (${r.skipped} already with that owner)` : ''}`);
      invalidate(); onDone?.(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Assign ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={method === 'manual' ? !userId : !pool.length} onClick={submit}>Assign</Button></>}>
      {leadIds.length > 1 && (
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="manual">One person</option>
            <option value="round_robin">Round-robin across selected people</option>
            <option value="workload">Workload-based (fewest open leads first)</option>
          </Select>
        </Field>
      )}
      {method === 'manual' ? (
        <Field label="Assign to">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Select a person…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        </Field>
      ) : (
        <Field label="Distribute between">
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={pool.includes(u.id)} onChange={(e) => setPool(e.target.checked ? [...pool, u.id] : pool.filter((x) => x !== u.id))} />
                {u.fullName}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rebalancing workload" /></Field>
      <ErrorBox error={err} />
    </Modal>
  );
}

function NextFollowUpFields({ enabled, setEnabled, dueAt, setDueAt, type, setType, note, setNote, label = 'Schedule next follow-up' }: {
  enabled: boolean; setEnabled: (v: boolean) => void; dueAt: string; setDueAt: (v: string) => void; type: string; setType: (v: string) => void;
  note: string; setNote: (v: string) => void; label?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {label}
      </label>
      {enabled && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="When"><Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(FOLLOW_UP_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="What to do" className="col-span-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Share brochure, confirm site visit" /></Field>
        </div>
      )}
    </div>
  );
}

const tomorrow10 = () => { const d = new Date(Date.now() + 86400e3); d.setHours(10, 0, 0, 0); return toLocalInput(d); };

/** Manual call log, or disposition for a provider call (callId set). */
export function LogCallModal({ open, onClose, leadId, callId }: { open: boolean; onClose: () => void; leadId: string; callId?: string }) {
  const [outcome, setOutcome] = useState('CONNECTED');
  const [direction, setDirection] = useState('OUTBOUND');
  const [minutes, setMinutes] = useState('');
  const [notes, setNotes] = useState('');
  const [next, setNext] = useState(true);
  const [dueAt, setDueAt] = useState(tomorrow10());
  const [type, setType] = useState('call');
  const [fuNote, setFuNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const invalidate = useInvalidateLead();

  const submit = async () => {
    setBusy(true); setErr(null);
    const nextFollowUp = next ? { dueAt: new Date(dueAt).toISOString(), type, note: fuNote || undefined } : undefined;
    try {
      if (callId) await api.patch(`/calls/${callId}/disposition`, { outcome, notes: notes || undefined, nextFollowUp });
      else {
        await api.post('/calls', {
          leadId, outcome, direction, notes: notes || undefined, nextFollowUp,
          durationSeconds: minutes ? Math.round(Number(minutes) * 60) : undefined,
        });
      }
      toast.success('Call saved');
      invalidate(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={callId ? 'How did the call go?' : 'Log a call'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Save call</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {Object.entries(CALL_OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        {!callId && (
          <>
            <Field label="Direction">
              <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="OUTBOUND">I called the customer</option>
                <option value="INBOUND">Customer called me</option>
              </Select>
            </Field>
            <Field label="Duration (minutes)"><Input type="number" min="0" step="0.5" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="optional" /></Field>
          </>
        )}
      </div>
      <Field label="Conversation notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did the customer say? Requirements, objections, budget…" /></Field>
      <NextFollowUpFields enabled={next} setEnabled={setNext} dueAt={dueAt} setDueAt={setDueAt} type={type} setType={setType} note={fuNote} setNote={setFuNote} />
      <ErrorBox error={err} />
    </Modal>
  );
}

export function FollowUpModal({ open, onClose, leadId }: { open: boolean; onClose: () => void; leadId: string }) {
  const [dueAt, setDueAt] = useState(tomorrow10());
  const [type, setType] = useState('call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const invalidate = useInvalidateLead();
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/follow-ups', { leadId, dueAt: new Date(dueAt).toISOString(), type, note: note || undefined });
      toast.success('Follow-up scheduled');
      invalidate(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Schedule follow-up"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Schedule</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="When"><Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(FOLLOW_UP_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="What to do"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Send EMI calculation and confirm visit" /></Field>
      <ErrorBox error={err} />
    </Modal>
  );
}

export function CompleteFollowUpModal({ open, onClose, followUp }: {
  open: boolean; onClose: () => void; followUp: { id: string; lead: { fullName: string } } | null;
}) {
  const [outcome, setOutcome] = useState('Spoke to customer');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'next' | 'close'>('next');
  const [dueAt, setDueAt] = useState(tomorrow10());
  const [type, setType] = useState('call');
  const [fuNote, setFuNote] = useState('');
  const [leadStatus, setLeadStatus] = useState('');
  const [closeStatus, setCloseStatus] = useState('CONVERTED');
  const [closeReason, setCloseReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const invalidate = useInvalidateLead();
  if (!followUp) return null;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/follow-ups/${followUp.id}/complete`, {
        outcome, notes: notes || undefined,
        ...(mode === 'next'
          ? { next: { dueAt: new Date(dueAt).toISOString(), type, note: fuNote || undefined }, leadStatus: leadStatus || undefined }
          : { closeStatus, closeReason: closeReason || undefined }),
      });
      toast.success('Follow-up completed');
      invalidate(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Complete follow-up · ${followUp.lead.fullName}`} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Complete</Button></>}>
      <Field label="Outcome">
        <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {['Spoke to customer', 'Shared details on WhatsApp', 'Site visit done', 'No answer', 'Asked to call later', 'Sent email'].map((o) => <option key={o}>{o}</option>)}
        </Select>
      </Field>
      <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div>
        <p className="mb-2 text-sm font-medium text-slate-700">What happens next?</p>
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'next' ? 'primary' : 'secondary'} onClick={() => setMode('next')}>Schedule next action</Button>
          <Button size="sm" variant={mode === 'close' ? 'primary' : 'secondary'} onClick={() => setMode('close')}>Close the lead</Button>
        </div>
      </div>
      {mode === 'next' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Next follow-up"><Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(FOLLOW_UP_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="What to do"><Input value={fuNote} onChange={(e) => setFuNote(e.target.value)} /></Field>
          <Field label="Mark lead as">
            <Select value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)}>
              <option value="">Keep current status</option>
              <option value="INTERESTED">Interested</option>
              <option value="FOLLOW_UP_REQUIRED">Follow-up required</option>
            </Select>
          </Field>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Close as">
            <Select value={closeStatus} onChange={(e) => setCloseStatus(e.target.value)}>
              <option value="CONVERTED">Converted</option>
              <option value="LOST">Lost / not interested</option>
              <option value="INVALID">Invalid</option>
            </Select>
          </Field>
          <Field label={closeStatus === 'CONVERTED' ? 'Note (optional)' : 'Reason (required)'}><Input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} /></Field>
        </div>
      )}
      <ErrorBox error={err} />
    </Modal>
  );
}

const MANUAL = ['CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP_REQUIRED', 'CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'];
const CLOSED = ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'];

export function StatusModal({ open, onClose, lead }: { open: boolean; onClose: () => void; lead: { id: string; status: string } }) {
  const isClosed = CLOSED.includes(lead.status);
  const options = MANUAL.filter((s) => s !== lead.status && (!isClosed || !CLOSED.includes(s)));
  const [status, setStatus] = useState(options[0]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const invalidate = useInvalidateLead();
  const needsReason = ['LOST', 'INVALID', 'DUPLICATE'].includes(status) || isClosed;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/leads/${lead.id}/status`, { status, reason: reason || undefined });
      toast.success(`Status changed to ${LEAD_STATUS[status].label}`);
      invalidate(); onClose();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={isClosed ? 'Reopen lead' : 'Change status'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit} disabled={needsReason && !reason.trim()}>Save</Button></>}>
      <Field label="New status">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {options.map((s) => <option key={s} value={s}>{LEAD_STATUS[s].label}</option>)}
        </Select>
      </Field>
      <Field label={needsReason ? 'Reason (required)' : 'Reason (optional)'}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={status === 'LOST' ? 'e.g. Budget too low, bought elsewhere' : ''} />
      </Field>
      {CLOSED.includes(status) && <p className="text-xs text-slate-500">Closing a lead cancels its pending follow-ups.</p>}
      <ErrorBox error={err} />
    </Modal>
  );
}

export function CreateLeadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const users = useAssignableUsers();
  const { can } = useAuth();
  const [f, setF] = useState({ fullName: '', phone: '', email: '', city: '', campaignName: '', assignToUserId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  const invalidate = useInvalidateLead();
  const submit = async (force = false) => {
    setBusy(true); setErr(null);
    try {
      await api.post('/leads', { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), force });
      toast.success('Lead created');
      invalidate(); onClose();
      setF({ fullName: '', phone: '', email: '', city: '', campaignName: '', assignToUserId: '' }); setDupId(null);
    } catch (e) {
      const body = (e as { body?: { existingLeadId?: string } }).body;
      if (body?.existingLeadId) setDupId(body.existingLeadId);
      setErr(e);
    } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New lead"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        {dupId && <Button variant="secondary" onClick={() => submit(true)}>Create anyway</Button>}
        <Button loading={busy} onClick={() => submit()} disabled={!f.fullName || (!f.phone && !f.email)}>Create</Button></>}>
      <Field label="Full name"><Input value={f.fullName} onChange={set('fullName')} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} placeholder="+91 98765 43210" /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="Campaign / source note"><Input value={f.campaignName} onChange={set('campaignName')} /></Field>
      </div>
      {can('leads.assign.all', 'leads.assign.team') && (
        <Field label="Assign to (optional)">
          <Select value={f.assignToUserId} onChange={set('assignToUserId')}>
            <option value="">Leave unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        </Field>
      )}
      <ErrorBox error={err} />
      {dupId && <a href={`/leads/${dupId}`} className="text-sm text-indigo-400 hover:underline">Open the existing lead →</a>}
    </Modal>
  );
}

export { errMsg };
