import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import { CalendarPlus, Camera, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Spinner, Textarea } from './ui';

export type PostingStatus = 'NONE' | 'NOT_YET' | 'DONE';
interface Slot { id: string; date: string; video: string | null; videoStatus: PostingStatus; poster: string | null; posterStatus: PostingStatus; leads: string | null }
interface Period { id: string; leadStart: string; leadEnd: string; shootDate: string | null; notes: string | null; slots: Slot[] }
interface Plan { today: string; canEdit: boolean; periods: Period[] }

export const POSTING_STATUS: Record<PostingStatus, { label: string; color: string }> = {
  DONE: { label: 'Done', color: 'border-green-200 bg-green-50 text-green-800' },
  NOT_YET: { label: 'Not yet', color: 'border-violet-200 bg-violet-50 text-violet-800' },
  NONE: { label: '—', color: 'border-slate-200 bg-white text-slate-400' },
};
const d = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`);
const fmt = (s: string | null, f = 'd MMM') => (s ? format(d(s), f) : '—');
const named = (s?: string | null) => !!s && !/^[\s\-–—_.]*$/.test(s);
const pending = (text: string | null, st: PostingStatus) => st === 'NOT_YET' || (named(text) && st === 'NONE');

export default function PostingCalendar({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['posting', clientId], queryFn: () => api.get<Plan>(`/clients/${clientId}/posting`) });
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Period> | null>(null);
  const [newDate, setNewDate] = useState('');
  const periods = q.data?.periods ?? [];
  // Default to the period covering today, else the latest one.
  useEffect(() => {
    if (!q.data || (periodId && periods.some((p) => p.id === periodId))) return;
    const t = q.data.today;
    setPeriodId((periods.find((p) => p.leadStart.slice(0, 10) <= t && p.leadEnd.slice(0, 10) >= t) ?? periods[0])?.id ?? null);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const period = periods.find((p) => p.id === periodId);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['posting', clientId] }); qc.invalidateQueries({ queryKey: ['posting-due'] }); };

  const save = async (slot: Slot, change: Partial<Slot>) => {
    try { await api.patch(`/posting/rows/${slot.id}`, change); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const addRow = async () => {
    if (!period || !newDate) return;
    try { await api.post(`/posting/periods/${period.id}/rows`, { date: newDate }); setNewDate(''); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const removeRow = async (s: Slot) => {
    if (!confirm(`Remove the row for ${fmt(s.date, 'd MMM yyyy')}?`)) return;
    try { await api.del(`/posting/rows/${s.id}`); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const removePeriod = async () => {
    if (!period || !confirm(`Delete the lead period ${fmt(period.leadStart)} – ${fmt(period.leadEnd, 'd MMM yyyy')} and its ${period.slots.length} rows?`)) return;
    try { await api.del(`/posting/periods/${period.id}`); setPeriodId(null); refresh(); toast.success('Lead period deleted'); } catch (e) { toast.error(errMsg(e)); }
  };

  const stats = useMemo(() => {
    const s = period?.slots ?? [];
    const v = s.filter((x) => named(x.video) || x.videoStatus !== 'NONE'), p = s.filter((x) => named(x.poster) || x.posterStatus !== 'NONE');
    return { videos: v.length, videosDone: v.filter((x) => x.videoStatus === 'DONE').length, posters: p.length, postersDone: p.filter((x) => x.posterStatus === 'DONE').length };
  }, [period]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const { canEdit, today } = q.data!;

  if (!periods.length) {
    return (
      <Card>
        <Empty title="No posting calendar yet" icon={<CalendarPlus className="h-8 w-8" />}>
          {canEdit ? <Button className="mt-3" onClick={() => setEditing({})}><Plus className="h-4 w-4" />Add lead period</Button> : 'Nothing has been planned for this client yet.'}
        </Empty>
        {editing && <PeriodModal clientId={clientId} period={editing} onClose={() => setEditing(null)} onSaved={(id) => { setPeriodId(id); refresh(); }} />}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Lead period" className="w-full sm:w-72">
          <select value={periodId ?? ''} onChange={(e) => setPeriodId(e.target.value)} aria-label="Lead period"
            className="w-full rounded-xl border border-slate-300 bg-surface px-3 py-2 text-sm">
            {periods.map((p) => <option key={p.id} value={p.id}>{fmt(p.leadStart)} – {fmt(p.leadEnd, 'd MMM yyyy')}</option>)}
          </select>
        </Field>
        {canEdit && <>
          <Button variant="secondary" onClick={() => setEditing(period!)}><Pencil className="h-4 w-4" />Edit period</Button>
          <Button variant="secondary" onClick={() => setEditing({})}><Plus className="h-4 w-4" />New lead period</Button>
          <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={removePeriod} title="Delete this lead period"><Trash2 className="h-4 w-4" /></Button>
        </>}
      </div>

      {period && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Info label="Lead start" value={fmt(period.leadStart, 'd MMM yyyy')} />
          <Info label="Lead end" value={fmt(period.leadEnd, 'd MMM yyyy')} />
          <Info label="Shoot date" value={period.shootDate ? fmt(period.shootDate, 'EEE d MMM yyyy') : 'Not set'} icon={<Camera className="h-3.5 w-3.5" />} />
          <Info label="Reels / videos done" value={`${stats.videosDone} of ${stats.videos}`} />
          <Info label="AI posters done" value={`${stats.postersDone} of ${stats.posters}`} />
        </div>
        {period.notes && <p className="whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{period.notes}</p>}

        <Card>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5">Schedule date</th><th className="px-3 py-2.5">Reels / AI videos</th><th className="px-3 py-2.5">Update</th>
                <th className="px-3 py-2.5">AI posters</th><th className="px-3 py-2.5">Update</th><th className="px-3 py-2.5">Leads</th><th />
              </tr></thead>
              <tbody>
                {!period.slots.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No dates yet. Add one below.</td></tr>}
                {period.slots.map((s) => {
                  const key = s.date.slice(0, 10);
                  const isToday = key === today, past = key < today;
                  return (
                    <tr key={s.id} className={clsx('border-b border-slate-100', isToday && 'bg-indigo-50/60')}>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <span className={clsx('font-medium', isToday ? 'text-indigo-700' : 'text-slate-800')}>{fmt(s.date, 'EEE d MMM')}</span>
                        {isToday && <Badge className="ml-1.5 bg-indigo-600 text-white">Today</Badge>}
                      </td>
                      <td className="px-3 py-1.5"><Cell value={s.video} disabled={!canEdit} placeholder="" onSave={(v) => save(s, { video: v })} /></td>
                      <td className="px-3 py-1.5"><StatusPick value={s.videoStatus} late={past && pending(s.video, s.videoStatus)} disabled={!canEdit} onChange={(v) => save(s, { videoStatus: v })} label={`Reel status ${key}`} /></td>
                      <td className="px-3 py-1.5"><Cell value={s.poster} disabled={!canEdit} placeholder="" onSave={(v) => save(s, { poster: v })} /></td>
                      <td className="px-3 py-1.5"><StatusPick value={s.posterStatus} late={past && pending(s.poster, s.posterStatus)} disabled={!canEdit} onChange={(v) => save(s, { posterStatus: v })} label={`Poster status ${key}`} /></td>
                      <td className="px-3 py-1.5"><Cell value={s.leads} disabled={!canEdit} placeholder="" onSave={(v) => save(s, { leads: v })} narrow /></td>
                      <td className="px-2 py-1.5 text-right">{canEdit && <button onClick={() => removeRow(s)} className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${key}`}><Trash2 className="h-4 w-4" /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2.5">
              <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-44" aria-label="New schedule date" />
              <Button size="sm" variant="secondary" disabled={!newDate} onClick={addRow}><Plus className="h-3.5 w-3.5" />Add date</Button>
              <span className="text-xs text-slate-400">Changes save as you go. Reminders go out on the day, and the day after if still not done.</span>
            </div>
          )}
        </Card>
      </>}
      {editing && <PeriodModal clientId={clientId} period={editing} onClose={() => setEditing(null)} onSaved={(id) => { setPeriodId(id); refresh(); }} />}
    </div>
  );
}

function Info({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface px-3 py-2.5">
      <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500">{icon}{label}</p>
      <p className="mt-0.5 font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/** A text cell that saves when you leave it. */
function Cell({ value, onSave, disabled, placeholder, narrow }: { value: string | null; onSave: (v: string | null) => void; disabled?: boolean; placeholder?: string; narrow?: boolean }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  if (disabled) return <span className="text-slate-700">{value || '—'}</span>;
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
      onBlur={() => { if ((v.trim() || null) !== (value || null)) onSave(v.trim() || null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value ?? ''); (e.target as HTMLInputElement).blur(); } }}
      className={clsx('rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm hover:border-slate-200 focus:border-indigo-400 focus:bg-white focus:outline-none', narrow ? 'w-24' : 'w-full min-w-40')} />
  );
}

function StatusPick({ value, onChange, disabled, late, label }: { value: PostingStatus; onChange: (v: PostingStatus) => void; disabled?: boolean; late?: boolean; label: string }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as PostingStatus)} aria-label={label}
      className={clsx('rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-80', POSTING_STATUS[value].color, late && 'ring-2 ring-rose-300')}
      title={late ? 'Past its date and not done' : undefined}>
      <option value="NONE">—</option>
      <option value="NOT_YET">Not yet</option>
      <option value="DONE">✓ Done</option>
    </select>
  );
}

function PeriodModal({ clientId, period, onClose, onSaved }: { clientId: string; period: Partial<Period>; onClose: () => void; onSaved: (id: string) => void }) {
  const isNew = !period.id;
  const [f, setF] = useState({
    leadStart: period.leadStart?.slice(0, 10) ?? '', leadEnd: period.leadEnd?.slice(0, 10) ?? '',
    shootDate: period.shootDate?.slice(0, 10) ?? '', notes: period.notes ?? '', fillDays: true,
  });
  const [busy, setBusy] = useState(false);
  const days = f.leadStart && f.leadEnd ? Math.round((d(f.leadEnd).getTime() - d(f.leadStart).getTime()) / 86_400_000) + 1 : 0;
  const save = async () => {
    setBusy(true);
    try {
      const body = { leadStart: f.leadStart, leadEnd: f.leadEnd, shootDate: f.shootDate || null, notes: f.notes || null };
      const r = isNew
        ? await api.post<{ id: string }>(`/clients/${clientId}/posting/periods`, { ...body, fillDays: f.fillDays })
        : await api.patch<{ id: string }>(`/posting/periods/${period.id}`, body);
      toast.success(isNew ? 'Lead period added' : 'Saved'); onSaved(r.id); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'New lead period' : 'Edit lead period'} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!f.leadStart || !f.leadEnd || days < 1} onClick={save}>{isNew ? 'Add' : 'Save'}</Button>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lead start date"><Input type="date" value={f.leadStart} onChange={(e) => setF({ ...f, leadStart: e.target.value })} /></Field>
        <Field label="Lead end date"><Input type="date" value={f.leadEnd} min={f.leadStart || undefined} onChange={(e) => setF({ ...f, leadEnd: e.target.value })} /></Field>
      </div>
      <Field label="Shoot date (optional)"><Input type="date" value={f.shootDate} onChange={(e) => setF({ ...f, shootDate: e.target.value })} /></Field>
      <Field label="Notes (optional)"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Package, deliverables…" /></Field>
      {isNew && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.fillDays} onChange={(e) => setF({ ...f, fillDays: e.target.checked })} />Add a row for every day{days > 0 && ` (${days} days)`}</label>}
      {days < 1 && f.leadStart && f.leadEnd && <p className="text-sm text-rose-600">The end date is before the start date.</p>}
    </Modal>
  );
}

/** Today's and overdue reels and posters across all clients, with a quick Done. */
export function PostingDue() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['posting-due'], queryFn: () => api.get<{ today: string; items: { slotId: string; clientId: string; client: string; date: string; kind: 'video' | 'poster'; item: string | null; overdue: boolean }[] }>('/posting/due'), refetchInterval: 5 * 60_000 });
  if (!q.data?.items.length) return null;
  const done = async (slotId: string, kind: 'video' | 'poster') => {
    try {
      await api.patch(`/posting/rows/${slotId}`, kind === 'video' ? { videoStatus: 'DONE' } : { posterStatus: 'DONE' });
      toast.success('Marked done');
      qc.invalidateQueries({ queryKey: ['posting-due'] }); qc.invalidateQueries({ queryKey: ['posting'] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const today = q.data.items.filter((i) => !i.overdue), late = q.data.items.filter((i) => i.overdue);
  return (
    <Card title={<span>Posting due: <span className="text-indigo-700">{today.length} today</span>{late.length > 0 && <span className="text-rose-600"> · {late.length} overdue</span>}</span>}>
      <ul className="divide-y divide-slate-100">
        {[...late, ...today].map((i) => (
          <li key={`${i.slotId}-${i.kind}`} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <Badge className={i.overdue ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'}>{i.overdue ? fmt(i.date) : 'Today'}</Badge>
            <Link to={`/clients/${i.clientId}?tab=posting`} className="font-medium text-slate-900 hover:underline">{i.client}</Link>
            <span className="text-slate-600">{i.item ?? (i.kind === 'video' ? 'Reel / video' : 'AI poster')}</span>
            <span className="text-xs text-slate-400">{i.kind === 'video' ? 'Reel / video' : 'AI poster'}</span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => done(i.slotId, i.kind)}><Check className="h-3.5 w-3.5" />Done</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
