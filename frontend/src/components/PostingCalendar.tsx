import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { CalendarPlus, Camera, Check, ExternalLink, FileSpreadsheet, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Spinner, Textarea } from './ui';

export type PostingStatus = 'NONE' | 'NOT_YET' | 'DONE';
interface Slot { id: string; date: string; video: string | null; videoStatus: PostingStatus; poster: string | null; posterStatus: PostingStatus; leads: string | null }
interface Period { id: string; leadStart: string; leadEnd: string; shootDate: string | null; notes: string | null; slots: Slot[]; fromSheet?: boolean; sheetTab?: string | null }
interface Plan { today: string; canEdit: boolean; periods: Period[]; sheetUrl?: string | null; lastSyncAt?: string | null }

export const POSTING_STATUS: Record<PostingStatus, { label: string; color: string }> = {
  DONE: { label: 'Done', color: 'border-green-200 bg-green-50 text-green-800' },
  NOT_YET: { label: 'Not started', color: 'border-violet-200 bg-violet-50 text-violet-800' },
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
  // Calendars that come from the Google Sheet are changed in the sheet.
  const editable = canEdit && !period?.fromSheet;

  if (!periods.length) {
    return (
      <Card>
        <Empty title="No schedule yet" icon={<CalendarPlus className="h-8 w-8" />}>
          {canEdit ? <Button className="mt-3" onClick={() => setEditing({})}><Plus className="h-4 w-4" />Add schedule dates</Button> : 'Nothing has been planned for this client yet.'}
        </Empty>
        {editing && <PeriodModal clientId={clientId} period={editing} onClose={() => setEditing(null)} onSaved={(id) => { setPeriodId(id); refresh(); }} />}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Schedule dates" className="w-full sm:w-72">
          <select value={periodId ?? ''} onChange={(e) => setPeriodId(e.target.value)} aria-label="Schedule dates"
            className="w-full rounded-xl border border-slate-300 bg-surface px-3 py-2 text-sm">
            {periods.map((p) => <option key={p.id} value={p.id}>{fmt(p.leadStart)} – {fmt(p.leadEnd, 'd MMM yyyy')}</option>)}
          </select>
        </Field>
        {editable && <Button variant="secondary" onClick={() => setEditing(period!)}><Pencil className="h-4 w-4" />Edit dates</Button>}
        {canEdit && <Button variant="secondary" onClick={() => setEditing({})}><Plus className="h-4 w-4" />Add date range</Button>}
        {editable && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={removePeriod} title="Delete this lead period"><Trash2 className="h-4 w-4" /></Button>}
      </div>

      {period?.fromSheet && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <FileSpreadsheet className="h-4 w-4" />
          <span>From the Google Sheet{period.sheetTab ? <> (tab <b>{period.sheetTab}</b>)</> : ''}. Change it in the sheet; the CRM picks it up automatically.</span>
          {q.data!.sheetUrl && <a href={q.data!.sheetUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 font-medium text-emerald-800 hover:underline">Edit in Google Sheet <ExternalLink className="h-3.5 w-3.5" /></a>}
        </div>
      )}
      {period && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Info label="Schedule starts" value={fmt(period.leadStart, 'd MMM yyyy')} />
          <Info label="Schedule ends" value={fmt(period.leadEnd, 'd MMM yyyy')} />
          <Info label="Shoot date" value={period.shootDate ? fmt(period.shootDate, 'EEE d MMM yyyy') : 'Not set'} icon={<Camera className="h-3.5 w-3.5" />} />
          <Info label="Videos done" value={`${stats.videosDone} of ${stats.videos}`} />
          <Info label="Posters done" value={`${stats.postersDone} of ${stats.posters}`} />
        </div>
        {period.notes && <p className="whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{period.notes}</p>}

        <Card>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2.5">Date</th><th className="px-3 py-2.5">Videos / reels</th><th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Posters</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Leads</th><th />
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
                      <td className="px-3 py-1.5"><Cell value={s.video} disabled={!editable} placeholder="" onSave={(v) => save(s, { video: v })} /></td>
                      <td className="px-3 py-1.5"><StatusPick value={s.videoStatus} late={past && pending(s.video, s.videoStatus)} disabled={!editable} onChange={(v) => save(s, { videoStatus: v })} label={`Reel status ${key}`} /></td>
                      <td className="px-3 py-1.5"><Cell value={s.poster} disabled={!editable} placeholder="" onSave={(v) => save(s, { poster: v })} /></td>
                      <td className="px-3 py-1.5"><StatusPick value={s.posterStatus} late={past && pending(s.poster, s.posterStatus)} disabled={!editable} onChange={(v) => save(s, { posterStatus: v })} label={`Poster status ${key}`} /></td>
                      <td className="px-3 py-1.5"><Cell value={s.leads} disabled={!editable} placeholder="" onSave={(v) => save(s, { leads: v })} narrow /></td>
                      <td className="px-2 py-1.5 text-right">{editable && <button onClick={() => removeRow(s)} className="rounded p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${key}`}><Trash2 className="h-4 w-4" /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editable && (
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
        <Field label="Schedule start date"><Input type="date" value={f.leadStart} onChange={(e) => setF({ ...f, leadStart: e.target.value })} /></Field>
        <Field label="Schedule end date"><Input type="date" value={f.leadEnd} min={f.leadStart || undefined} onChange={(e) => setF({ ...f, leadEnd: e.target.value })} /></Field>
      </div>
      <Field label="Shoot date (optional)"><Input type="date" value={f.shootDate} onChange={(e) => setF({ ...f, shootDate: e.target.value })} /></Field>
      <Field label="Notes (optional)"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Package, work to do…" /></Field>
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
            <Link to={`/media?tab=posting&client=${i.clientId}`} className="font-medium text-slate-900 hover:underline">{i.client}</Link>
            <span className="text-slate-600">{i.item ?? (i.kind === 'video' ? 'Reel / video' : 'AI poster')}</span>
            <span className="text-xs text-slate-400">{i.kind === 'video' ? 'Reel / video' : 'AI poster'}</span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => done(i.slotId, i.kind)}><Check className="h-3.5 w-3.5" />Done</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface SheetTab { name: string; gid: string; clientId: string | null; client: string | null; periodId: string | null; headers: string[]; rows: string[][]; problems: string[] }
interface SheetStatus { connected: boolean; url: string | null; lastSyncAt: string | null; lastError: string | null; tabs: SheetTab[] }

/**
 * The Media tab's "Client posting" view: the connected Google Sheet, shown exactly as it is,
 * tab by tab. While open it re-reads the sheet every minute, or straight away with Sync now.
 */
export function ClientPostingTab({ clientId }: { clientId: string | null; onPick?: (id: string | null) => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canEdit = can('clients.posting', 'clients.manage');
  // Reading the overview makes the server re-read the sheet when it is more than a minute old.
  const fresh = useQuery({ queryKey: ['posting-overview'], queryFn: () => api.get('/posting/overview'), refetchInterval: 60_000 });
  const q = useQuery({ queryKey: ['posting-sheet'], queryFn: () => api.get<SheetStatus>('/posting/sheet') });
  // When the background check has re-read the sheet, refresh the view in place (no loading flash).
  useEffect(() => { if (fresh.dataUpdatedAt) qc.invalidateQueries({ queryKey: ['posting-sheet'] }); }, [fresh.dataUpdatedAt, qc]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [tabGid, setTabGid] = useState<string | null>(null);
  const run = async (fn: () => Promise<SheetStatus>, ok: string) => {
    setBusy(true);
    try {
      const s = await fn();
      qc.setQueryData(['posting-sheet'], s);
      for (const k of ['posting-overview', 'posting-due', 'posting', 'posting-calendar']) qc.invalidateQueries({ queryKey: [k] });
      if (s.lastError) toast.error(s.lastError); else toast.success(ok);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  if (!s.connected) {
    return (
      <Card>
        {canEdit ? (
          <div className="flex flex-wrap items-end gap-2 p-4">
            <FileSpreadsheet className="mb-2 h-5 w-5 text-emerald-600" />
            <Field label="Google Sheet link" className="min-w-64 flex-1" hint='Share the sheet as "Anyone with the link can view". It is shown here exactly as it is.'>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
            </Field>
            <Button loading={busy} disabled={!url.trim()} onClick={() => run(() => api.post<SheetStatus>('/posting/sheet', { url }), 'Sheet connected')}>Connect sheet</Button>
          </div>
        ) : <Empty title="No sheet connected" icon={<FileSpreadsheet className="h-8 w-8" />}>Ask an admin to connect the posting calendar sheet.</Empty>}
      </Card>
    );
  }
  // A link from the calendar (?client=…) opens that client's tab.
  const tab = s.tabs.find((x) => x.gid === tabGid) ?? s.tabs.find((x) => x.clientId === clientId) ?? s.tabs[0];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
        <span className="font-medium text-slate-900">Posting calender</span>
        <span className="text-slate-500">· from Google Sheets · updated {s.lastSyncAt ? formatDistanceToNowStrict(new Date(s.lastSyncAt), { addSuffix: true }) : 'never'}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => api.post<SheetStatus>('/posting/sheet/sync'), 'Updated from the sheet')}><RefreshCw className="h-3.5 w-3.5" />Sync now</Button>
          {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-50">Open sheet <ExternalLink className="h-3.5 w-3.5" /></a>}
          {canEdit && <Button size="sm" variant="ghost" onClick={() => { if (confirm('Stop showing this Google Sheet?')) run(() => api.del<SheetStatus>('/posting/sheet'), 'Sheet disconnected'); }}>Disconnect</Button>}
        </div>
      </div>
      {s.lastError && <div className="mx-4 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">Couldn't update from the sheet: {s.lastError}</div>}
      {tab && <>
        <div className="scroll-thin max-h-[calc(100vh-22rem)] min-h-64 overflow-auto border-t border-slate-200">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            {tab.headers.length > 0 && (
              <thead className="sticky top-0 z-10"><tr>
                <th className="w-10 border border-slate-200 bg-slate-100 px-2 py-1.5 text-center text-xs font-medium text-slate-400">1</th>
                {tab.headers.map((h, i) => <th key={i} className="whitespace-nowrap border border-slate-200 bg-slate-100 px-3 py-1.5 font-semibold text-slate-800">{h}</th>)}
              </tr></thead>
            )}
            <tbody>
              {tab.rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-slate-50/70">
                  <td className="border border-slate-200 bg-slate-50 px-2 py-1 text-center text-xs text-slate-400">{ri + (tab.headers.length ? 2 : 1)}</td>
                  {row.map((c, ci) => <td key={ci} className="whitespace-nowrap border border-slate-200 px-3 py-1"><SheetCell value={c} /></td>)}
                </tr>
              ))}
              {!tab.rows.length && <tr><td colSpan={tab.headers.length + 1} className="px-3 py-6 text-center text-slate-400">This tab is empty.</td></tr>}
            </tbody>
          </table>
        </div>
        {/* Sheet tabs along the bottom, as in Google Sheets. */}
        <div className="scroll-thin flex gap-1 overflow-x-auto border-t border-slate-200 bg-slate-50 px-3 pb-2">
          {s.tabs.map((x) => (
            <button key={x.gid} onClick={() => setTabGid(x.gid)}
              className={clsx('-mt-px whitespace-nowrap rounded-b-lg border border-t-0 px-4 py-2 text-sm font-medium', x.gid === tab.gid ? 'border-slate-200 bg-white text-emerald-800 shadow-sm' : 'border-transparent text-slate-600 hover:bg-white/70 hover:text-slate-900')}>
              {x.name}
            </button>
          ))}
        </div>
      </>}
    </Card>
  );
}

/** A cell as the sheet shows it, with its Done / Not yet chips coloured like the sheet. */
function SheetCell({ value }: { value: string }) {
  const v = value.trim();
  const l = v.toLowerCase();
  if (/\bnot\b/.test(l) && /done|yet/.test(l)) return <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">{v.replace(/^[^A-Za-z]+/, '')}</span>;
  if (/\bdone\b/.test(l)) return <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">✓ {v.replace(/^[^A-Za-z]+/, '')}</span>;
  return <span className={clsx(!named(v) && 'text-slate-400')}>{v}</span>;
}
