import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  addDays, addMonths, endOfMonth, format, isSameDay, isSameMonth, startOfMonth, startOfWeek,
} from 'date-fns';
import { Camera, CheckCircle2, ChevronLeft, ChevronRight, Clapperboard, FileText, Image, IndianRupee, PenLine, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { toLocalInput } from '../lib/format';
import { ClientPicker } from './Tasks';
import {
  Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Table, Tabs, Td, Textarea, Th,
} from '../components/ui';

type Kind = 'SHOOT' | 'REEL' | 'CONTENT' | 'IMAGE';
type Status = 'PLANNED' | 'IN_PROGRESS' | 'READY' | 'DONE' | 'CANCELLED';
type Category = 'MODEL' | 'LOCATION' | 'EQUIPMENT' | 'TRAVEL' | 'FOOD' | 'PROPS' | 'OTHER';
interface Person { id: string; fullName: string }
interface Item {
  id: string; kind: Kind; title: string; scheduledAt: string; status: Status;
  assignee: Person | null; createdBy: Person; clients: { id: string; name: string }[];
  platform: string | null; location: string | null; models: string | null; link: string | null; notes: string | null;
  _count: { expenses: number };
  permissions: { canManage: boolean; canUpdate: boolean };
  /** Opened from a view-only type tab. */
  readOnly?: boolean;
}
interface Expense {
  id: string; spentOn: string; category: Category; payee: string; description: string | null; amount: number;
  paid: boolean; paidOn: string | null; shoot: { id: string; title: string; scheduledAt: string } | null; createdBy: Person;
}
interface Expenses { items: Expense[]; totals: { total: number; paid: number; unpaid: number; byCategory: Record<Category, number> } }
type ScriptStatus = 'WRITTEN' | 'APPROVED';
interface Script {
  id: string; title: string; body: string; scheduledAt: string; status: ScriptStatus; approvedAt: string | null; updatedAt: string;
  client: { id: string; name: string }; writer: Person; permissions: { canEdit: boolean };
  /** Opened from the view-only Scripts tab. */
  readOnly?: boolean;
}
interface Summary { thisWeek: Record<Kind, number>; overdue: number; mine: number }

export const KIND: Record<Kind, { label: string; plural: string; icon: typeof Camera; chip: string; dot: string }> = {
  SHOOT: { label: 'Shoot', plural: 'Shoots', icon: Camera, chip: 'bg-rose-50 text-rose-800 border-rose-200', dot: 'bg-rose-500' },
  REEL: { label: 'Reel post', plural: 'Reels', icon: Clapperboard, chip: 'bg-violet-50 text-violet-800 border-violet-200', dot: 'bg-violet-500' },
  CONTENT: { label: 'Content writing', plural: 'Content', icon: PenLine, chip: 'bg-sky-50 text-sky-800 border-sky-200', dot: 'bg-sky-500' },
  IMAGE: { label: 'Image post', plural: 'Images', icon: Image, chip: 'bg-amber-50 text-amber-800 border-amber-200', dot: 'bg-amber-500' },
};
const KINDS = Object.keys(KIND) as Kind[];
export const MEDIA_STATUS: Record<Status, { label: string; color: string }> = {
  PLANNED: { label: 'Planned', color: 'bg-slate-100 text-slate-700' },
  IN_PROGRESS: { label: 'In progress', color: 'bg-blue-100 text-blue-800' },
  READY: { label: 'Ready', color: 'bg-violet-100 text-violet-800' },
  DONE: { label: 'Done', color: 'bg-green-100 text-green-800' },
  CANCELLED: { label: 'Cancelled', color: 'bg-slate-200 text-slate-500 line-through' },
};
/** "Done" reads as "Posted" for things that get posted. */
const doneLabel = (k: Kind) => (k === 'REEL' || k === 'IMAGE' ? 'Posted' : k === 'SHOOT' ? 'Shot' : 'Written');
const statusLabel = (k: Kind, s: Status) => (s === 'DONE' ? doneLabel(k) : MEDIA_STATUS[s].label);
const CATEGORY: Record<Category, string> = {
  MODEL: 'Model fee', LOCATION: 'Location', EQUIPMENT: 'Equipment', TRAVEL: 'Travel', FOOD: 'Food', PROPS: 'Props & styling', OTHER: 'Other',
};
const PLATFORMS = ['Instagram', 'Facebook', 'YouTube', 'LinkedIn', 'X', 'Website', 'Blog', 'WhatsApp'];
const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const isOpen = (s: Status) => s !== 'DONE' && s !== 'CANCELLED';
const invalidate = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ['media', 'media-summary', 'media-expenses']) qc.invalidateQueries({ queryKey: [k] }); };

type Tab = 'calendar' | Kind | 'scripts' | 'expenses';
/** How many entries a calendar day shows before "+N more". */
const MAX_PER_DAY = 3;

export default function Media() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'calendar';
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [assignee, setAssignee] = useState('');
  const [client, setClient] = useState(''); // '' every client, 'none' entries without one (from before it was required), or a client id
  const [editing, setEditing] = useState<Partial<Item> | null>(null);
  const [expense, setExpense] = useState<Partial<Expense> | null>(null);
  const [script, setScript] = useState<Partial<Script> | null>(null);
  const manage = can('media.manage');
  const seesAll = manage || can('media.view.all');
  // Expenses are for Super Admins only (the API enforces this too).
  const money = !!me?.roles.includes('super_admin');
  const dir = useDirectory();

  // The calendar shows whole weeks, so it reaches a few days into the months either side.
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const to = addDays(startOfWeek(endOfMonth(month), { weekStartsOn: 1 }), 7); // Midnight after the last Sunday shown
  const items = useQuery({
    queryKey: ['media', from.toISOString(), assignee, client],
    queryFn: () => api.get<Item[]>('/media', { from: from.toISOString(), to: to.toISOString(), assignee: assignee || undefined, client: client || undefined }),
  });
  // Clients to filter by: the client list, plus any client already on this month's schedule.
  const clientList = useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<{ id: string; name: string }[]>('/clients/directory'), staleTime: 60_000 });
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clientList.data ?? []) m.set(c.id, c.name);
    for (const i of items.data ?? []) for (const c of i.clients) m.set(c.id, c.name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [clientList.data, items.data]);
  const summary = useQuery({ queryKey: ['media-summary'], queryFn: () => api.get<Summary>('/media/summary') });
  // Scripts due in the weeks the calendar shows. Every script has a client, so "No client" shows none.
  const calendarScripts = useQuery({
    queryKey: ['media-scripts', 'calendar', from.toISOString(), client],
    queryFn: () => api.get<Script[]>('/media-scripts', { from: from.toISOString(), to: to.toISOString(), client: client || undefined }),
    enabled: (tab === 'calendar' || tab === 'scripts') && client !== 'none',
  });

  // A notification links to /media?item=<id>.
  const openId = params.get('item');
  useEffect(() => {
    if (!openId) return;
    api.get<Item[]>('/media', {}).then((all) => {
      const found = all.find((i) => i.id === openId);
      if (found) { setMonth(startOfMonth(new Date(found.scheduledAt))); setEditing(found); }
      else toast.error('That schedule entry is no longer there');
    }).catch(() => undefined);
    params.delete('item'); setParams(params, { replace: true });
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (v: Tab) => setParams(v === 'calendar' ? {} : { tab: v }, { replace: true });
  // Shoots, Reels, Content, Images and Scripts are view-only calendars of one type; changes are made on Calendar.
  const typeTab: Kind | 'script' | null = (KINDS as string[]).includes(tab) ? (tab as Kind) : tab === 'scripts' ? 'script' : null;
  // Expenses without Super Admin, or an unknown tab, falls back to the calendar.
  const view: Tab = tab === 'expenses' ? (money ? 'expenses' : 'calendar') : typeTab ? tab : 'calendar';
  const inMonth = (items.data ?? []).filter((i) => isSameMonth(new Date(i.scheduledAt), month));
  const pickedClient = client && client !== 'none' ? clientOptions.find((c) => c.id === client) : undefined;
  const newScript = (at?: Date) => {
    const d = at ? new Date(at) : new Date();
    if (at) d.setHours(10, 0, 0, 0);
    setScript({ status: 'WRITTEN', scheduledAt: d.toISOString(), client: pickedClient });
  };
  const newItem = (kind: Kind, at?: Date) => {
    const d = at ? new Date(at) : new Date();
    if (at) d.setHours(10, 0, 0, 0);
    setEditing({ kind, scheduledAt: d.toISOString(), status: 'PLANNED', clients: pickedClient ? [pickedClient] : [] });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Media"
        subtitle={seesAll ? 'Shoots, reels, content and image posts: when they happen and who is on each' : 'Media work assigned to you'}
        actions={<>
          {money && view === 'expenses' && <Button variant="secondary" onClick={() => setExpense({ category: 'MODEL', spentOn: format(new Date(), 'yyyy-MM-dd') })}><IndianRupee className="h-4 w-4" />Add expense</Button>}
          {view === 'calendar' && <Button variant={manage ? 'secondary' : 'primary'} onClick={() => newScript()}><FileText className="h-4 w-4" />New script</Button>}
          {view === 'calendar' && manage && <Button onClick={() => newItem('SHOOT')}><Plus className="h-4 w-4" />Add to schedule</Button>}
        </>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {KINDS.map((k) => <StatCard key={k} label={`${KIND[k].plural} · next 7 days`} value={summary.data?.thisWeek[k] ?? '—'} onClick={() => setTab(k)} />)}
        <StatCard label="Past date, not done" value={summary.data?.overdue ?? '—'} tone={summary.data?.overdue ? 'bad' : 'default'} />
        <StatCard label="Open and assigned to me" value={summary.data?.mine ?? '—'} onClick={() => setAssignee(assignee === 'me' ? '' : 'me')} sub={assignee === 'me' ? 'Showing only mine' : undefined} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={view} onChange={setTab} tabs={[
          { value: 'calendar', label: 'Calendar' },
          ...KINDS.map((k) => ({ value: k as Tab, label: KIND[k].plural, count: typeTab ? inMonth.filter((i) => i.kind === k).length : undefined })),
          { value: 'scripts' as Tab, label: 'Scripts', count: typeTab ? (calendarScripts.data ?? []).filter((x) => isSameMonth(new Date(x.scheduledAt), month)).length : undefined },
          ...(money ? [{ value: 'expenses' as Tab, label: 'Expenses' }] : []),
        ]} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="w-32 text-center text-sm font-semibold">{format(month, 'MMMM yyyy')}</span>
            <Button size="sm" variant="secondary" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
          </div>
          {seesAll && view !== 'expenses' && view !== 'scripts' && (
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-44" aria-label="Assigned to">
              <option value="">Everyone</option>
              <option value="me">Assigned to me</option>
              {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          )}
          {view !== 'expenses' && (
            <Select value={client} onChange={(e) => setClient(e.target.value)} className="w-44" aria-label="Client">
              <option value="">All clients</option>
              {view !== 'scripts' && <option value="none">No client (older entries)</option>}
              {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {client && client !== 'none' && !clientOptions.some((c) => c.id === client) && <option value={client}>Selected client</option>}
            </Select>
          )}
        </div>
      </div>

      {view === 'expenses' ? (
        <ExpensesTab month={month} onEdit={setExpense} />
      ) : items.isLoading ? <Spinner /> : items.error ? <ErrorBox error={items.error} /> : typeTab ? (
        <Calendar month={month} from={from} to={to} only={typeTab}
          items={typeTab === 'script' ? [] : (items.data ?? []).filter((i) => i.kind === typeTab)}
          scripts={typeTab === 'script' && client !== 'none' ? calendarScripts.data ?? [] : []}
          onOpen={(i) => setEditing({ ...i, readOnly: true })} onOpenScript={(x) => setScript({ ...x, readOnly: true })} />
      ) : (
        <Calendar month={month} from={from} to={to} items={items.data ?? []} scripts={client === 'none' ? [] : calendarScripts.data ?? []}
          onOpen={setEditing} onOpenScript={setScript} onAdd={manage ? (kind, d) => newItem(kind, d) : undefined} onAddScript={newScript} />
      )}

      {editing && <ItemModal item={editing} readOnly={!!editing.readOnly} costs={money} onClose={() => setEditing(null)} onAddExpense={money && !editing.readOnly ? (shoot) => setExpense({ category: 'MODEL', spentOn: shoot.scheduledAt.slice(0, 10), shoot: { id: shoot.id, title: shoot.title, scheduledAt: shoot.scheduledAt } }) : undefined} onSaved={() => invalidate(qc)} />}
      {expense && <ExpenseModal expense={expense} onClose={() => setExpense(null)} onSaved={() => invalidate(qc)} />}
      {script && <ScriptModal script={script} readOnly={!!script.readOnly} clients={clientOptions} onClose={() => setScript(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['media-scripts'] })} />}
    </div>
  );
}

// ───── Calendar ─────

/** Scripts on the calendar, next to the four kinds of schedule entry. */
const SCRIPT_CHIP = { label: 'Script', plural: 'Scripts', icon: FileText, chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' };
/** One line on a calendar day: a schedule entry or a script. */
type Entry = { type: 'item'; at: string; item: Item } | { type: 'script'; at: string; script: Script };
const byTime = (a: Entry, b: Entry) => a.at.localeCompare(b.at);

function Calendar({ month, from, to, items, scripts, onOpen, onOpenScript, onAdd, onAddScript, only }: {
  month: Date; from: Date; to: Date; items: Item[]; scripts: Script[];
  /** Show just this one type, view only: no type toggles, and no adding (the caller passes no onAdd). */
  only?: Kind | 'script';
  onOpen: (i: Item) => void; onOpenScript: (s: Script) => void;
  onAdd?: (kind: Kind, d: Date) => void; onAddScript?: (d: Date) => void;
}) {
  const [hidden, setHidden] = useState<Kind[]>([]);
  const [hideScripts, setHideScripts] = useState(false);
  const [dayOpen, setDayOpen] = useState<Date | null>(null); // Day whose full list is open
  const [menuDay, setMenuDay] = useState<string | null>(null); // Day whose "add" menu is open
  const canAdd = !!onAdd || !!onAddScript;
  useEffect(() => {
    if (!menuDay) return;
    const close = () => setMenuDay(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('click', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [menuDay]);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const entries: Entry[] = [
    ...items.filter((i) => !hidden.includes(i.kind)).map((item) => ({ type: 'item' as const, at: item.scheduledAt, item })),
    ...(hideScripts ? [] : scripts.map((script) => ({ type: 'script' as const, at: script.scheduledAt, script }))),
  ];
  const onDay = (d: Date) => entries.filter((e) => isSameDay(new Date(e.at), d)).sort(byTime);
  const open = (e: Entry) => (e.type === 'item' ? onOpen(e.item) : onOpenScript(e.script));
  const chip = (on: boolean, c: { chip: string; dot: string }) => ({
    className: clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', on ? c.chip : 'border-slate-200 text-slate-400'),
    dot: clsx('h-2 w-2 rounded-full', on ? c.dot : 'bg-slate-300'),
  });
  const sc = chip(!hideScripts, SCRIPT_CHIP);
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        {only ? (() => {
          const c = only === 'script' ? SCRIPT_CHIP : KIND[only];
          return <span className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', c.chip)}><span className={clsx('h-2 w-2 rounded-full', c.dot)} />{c.plural}</span>;
        })() : <>{KINDS.map((k) => {
          const c = chip(!hidden.includes(k), KIND[k]);
          return (
            <button key={k} onClick={() => setHidden(hidden.includes(k) ? hidden.filter((h) => h !== k) : [...hidden, k])} className={c.className}>
              <span className={c.dot} />{KIND[k].plural}
            </button>
          );
        })}
        <button onClick={() => setHideScripts(!hideScripts)} className={sc.className}><span className={sc.dot} />{SCRIPT_CHIP.plural}</button></>}
        <span className="ml-auto text-xs text-slate-400">
          {only ? 'View only. Add and change entries on the Calendar tab.' : canAdd ? 'Use + on a day to schedule something. Click a date to see that day.' : 'Click a date to see that day.'}
        </span>
      </div>
      <div className="scroll-thin overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b border-slate-100 px-2 py-1.5 text-xs font-semibold uppercase text-slate-500">{d}</div>)}
          {days.map((d, idx) => {
            const nearBottom = idx >= days.length - 14; // Last two weeks open the menu upwards so it isn't cut off.
            const today = isSameDay(d, new Date());
            const list = onDay(d);
            const key = d.toISOString();
            return (
              <div key={key} className={clsx('group relative min-h-28 border-b border-r border-slate-100 p-1.5', !isSameMonth(d, month) && 'bg-slate-50/70', canAdd && 'hover:bg-indigo-50/30')}>
                <div className="mb-1 flex items-center justify-between">
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); setDayOpen(d); }} title="See this day"
                    className={clsx('flex h-6 w-6 items-center justify-center rounded-full text-xs', today ? 'bg-slate-900 font-semibold text-white' : isSameMonth(d, month) ? 'text-slate-700 hover:bg-slate-200' : 'text-slate-400 hover:bg-slate-200')}>{format(d, 'd')}</button>
                  {canAdd && (
                    <button type="button" aria-label={`Add on ${format(d, 'd MMMM')}`} title={`Add on ${format(d, 'd MMM')}`}
                      onClick={(e) => { e.stopPropagation(); setMenuDay(menuDay === key ? null : key); }}
                      className={clsx('flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-surface text-slate-500 shadow-sm transition hover:border-slate-400 hover:text-slate-900',
                        menuDay === key ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100')}>
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {canAdd && menuDay === key && (
                  <div onClick={(e) => e.stopPropagation()} className={clsx('absolute right-1.5 z-20 w-44', nearBottom ? 'bottom-9' : 'top-9', ' rounded-xl border border-slate-200 bg-surface p-1 shadow-xl')}>
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{format(d, 'EEE d MMM')}</p>
                    {onAdd && KINDS.map((k) => {
                      const I = KIND[k].icon;
                      return (
                        <button key={k} type="button" onClick={() => { setMenuDay(null); onAdd(k, d); }}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100">
                          <span className={clsx('h-2 w-2 rounded-full', KIND[k].dot)} /><I className="h-4 w-4 text-slate-400" />{KIND[k].label}
                        </button>
                      );
                    })}
                    {onAddScript && (
                      <button type="button" onClick={() => { setMenuDay(null); onAddScript(d); }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100">
                        <span className={clsx('h-2 w-2 rounded-full', SCRIPT_CHIP.dot)} /><FileText className="h-4 w-4 text-slate-400" />{SCRIPT_CHIP.label}
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-1">
                  {list.slice(0, MAX_PER_DAY).map((e) => e.type === 'item' ? (
                    <button key={e.item.id} onClick={(ev) => { ev.stopPropagation(); onOpen(e.item); }}
                      title={[`${KIND[e.item.kind].label}: ${e.item.title}`, e.item.assignee ? `With ${e.item.assignee.fullName}` : null, e.item.notes].filter(Boolean).join('\n')}
                      className={clsx('block w-full truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4', KIND[e.item.kind].chip, !isOpen(e.item.status) && 'opacity-60', e.item.status === 'CANCELLED' && 'line-through')}>
                      <span className="font-semibold">{format(new Date(e.item.scheduledAt), 'h:mm')}</span> {e.item.title}
                      {e.item.assignee && <span className="opacity-70"> · {e.item.assignee.fullName.split(' ')[0]}</span>}
                    </button>
                  ) : (
                    <button key={e.script.id} onClick={(ev) => { ev.stopPropagation(); onOpenScript(e.script); }}
                      title={[`Script: ${e.script.title}`, e.script.client.name, SCRIPT_STATUS[e.script.status].label, `By ${e.script.writer.fullName}`].join('\n')}
                      className={clsx('flex w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4', SCRIPT_CHIP.chip)}>
                      {e.script.status === 'APPROVED' ? <CheckCircle2 className="h-3 w-3 shrink-0 text-green-600" aria-label="Approved by client" /> : <FileText className="h-3 w-3 shrink-0" aria-label="Written" />}
                      <span className="truncate">{e.script.title}<span className="opacity-70"> · {e.script.client.name}</span></span>
                    </button>
                  ))}
                  {list.length > MAX_PER_DAY && (
                    <button onClick={(ev) => { ev.stopPropagation(); setDayOpen(d); }}
                      className="w-full rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                      +{list.length - MAX_PER_DAY} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {dayOpen && (
        <DayAgenda date={dayOpen} entries={onDay(dayOpen)} onClose={() => setDayOpen(null)}
          onOpen={(e) => { setDayOpen(null); open(e); }}
          onAdd={onAdd ? (k) => { const d = dayOpen; setDayOpen(null); onAdd(k, d); } : undefined}
          onAddScript={onAddScript ? () => { const d = dayOpen; setDayOpen(null); onAddScript(d); } : undefined} />
      )}
    </Card>
  );
}

/** Everything on one day, in time order, with what each one is about. */
function DayAgenda({ date, entries, onClose, onOpen, onAdd, onAddScript }: {
  date: Date; entries: Entry[]; onClose: () => void; onOpen: (e: Entry) => void; onAdd?: (kind: Kind) => void; onAddScript?: () => void;
}) {
  const adds = (onAdd || onAddScript) ? (
    <div className="flex flex-wrap gap-2">
      {onAdd && KINDS.map((k) => { const I = KIND[k].icon; return <Button key={k} size="sm" variant="secondary" onClick={() => onAdd(k)}><I className="h-3.5 w-3.5" />Add {KIND[k].label.toLowerCase()}</Button>; })}
      {onAddScript && <Button size="sm" variant="secondary" onClick={onAddScript}><FileText className="h-3.5 w-3.5" />Add script</Button>}
    </div>
  ) : undefined;
  return (
    <Modal open wide onClose={onClose} title={format(date, 'EEEE d MMMM yyyy')} footer={adds}>
      {!entries.length ? <p className="text-sm text-slate-500">Nothing scheduled on this day.</p> : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {entries.map((e) => {
            const time = <div className="w-16 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-slate-700">{format(new Date(e.at), 'h:mm a')}</div>;
            if (e.type === 'script') {
              const s = e.script;
              return (
                <li key={`s-${s.id}`}>
                  <button type="button" onClick={() => onOpen(e)} className="flex w-full gap-3 px-3 py-2.5 text-left hover:bg-slate-50">
                    {time}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', SCRIPT_CHIP.chip)}><FileText className="h-3 w-3" />Script</span>
                        <span className="font-medium text-slate-900">{s.title}</span>
                        <Badge className={SCRIPT_STATUS[s.status].color}>{SCRIPT_STATUS[s.status].label}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-slate-600">{s.body}</p>
                      <p className="mt-1 text-xs text-slate-500">{s.client.name} · written by {s.writer.fullName}</p>
                    </div>
                  </button>
                </li>
              );
            }
            const i = e.item;
            const I = KIND[i.kind].icon;
            return (
              <li key={`i-${i.id}`}>
                <button type="button" onClick={() => onOpen(e)} className="flex w-full gap-3 px-3 py-2.5 text-left hover:bg-slate-50">
                  {time}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', KIND[i.kind].chip)}><I className="h-3 w-3" />{KIND[i.kind].label}</span>
                      <span className={clsx('font-medium text-slate-900', i.status === 'CANCELLED' && 'line-through')}>{i.title}</span>
                      <Badge className={MEDIA_STATUS[i.status].color}>{statusLabel(i.kind, i.status)}</Badge>
                    </div>
                    {i.notes && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{i.notes}</p>}
                    <p className="mt-1 text-xs text-slate-500">
                      {[i.assignee?.fullName ?? 'Not assigned', i.clients.map((c) => c.name).join(', '), i.kind === 'SHOOT' ? i.location : i.platform].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

// ───── Add / edit a schedule entry ─────

function ItemModal({ item, onClose, onSaved, onAddExpense, readOnly = false, costs = false }: {
  item: Partial<Item>; onClose: () => void; onSaved: () => void; onAddExpense?: (shoot: Item) => void;
  /** View only: nothing can be changed. */
  readOnly?: boolean;
  /** Show the shoot's expenses (Super Admins only). */
  costs?: boolean;
}) {
  const { can } = useAuth();
  const dir = useDirectory();
  const isNew = !item.id;
  const manage = can('media.manage');
  const full = !readOnly && (isNew || manage); // Assignees may only change status, link and notes.
  const locked = readOnly || (!isNew && !item.permissions?.canUpdate);
  const shootCosts = useQuery({
    queryKey: ['media-expenses', 'shoot', item.id],
    queryFn: () => api.get<Expenses>('/media-expenses', { shootId: item.id }),
    enabled: costs && !isNew && item.kind === 'SHOOT',
  });
  const [f, setF] = useState({
    kind: item.kind ?? 'SHOOT', title: item.title ?? '', when: item.scheduledAt ? toLocalInput(new Date(item.scheduledAt)) : '',
    status: item.status ?? 'PLANNED', assigneeId: item.assignee?.id ?? '', clientIds: (item.clients ?? []).map((c) => c.id), platform: item.platform ?? '',
    location: item.location ?? '', models: item.models ?? '', link: item.link ?? '', notes: item.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (c: Partial<typeof f>) => setF({ ...f, ...c });
  const shoot = f.kind === 'SHOOT';

  const save = async () => {
    setBusy(true);
    try {
      const body = full ? {
        kind: f.kind, title: f.title.trim(), scheduledAt: new Date(f.when).toISOString(), status: f.status,
        assigneeId: f.assigneeId || null, clientIds: f.clientIds, platform: shoot ? null : f.platform || null,
        location: shoot ? f.location || null : null, models: shoot ? f.models || null : null, link: f.link || null, notes: f.notes || null,
      } : { status: f.status, link: f.link || null, notes: f.notes || null };
      if (isNew) await api.post('/media', body); else await api.patch(`/media/${item.id}`, body);
      toast.success(isNew ? 'Added to the schedule' : 'Saved');
      onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm('Delete this schedule entry? Expenses recorded against it are kept.')) return;
    setBusy(true);
    try { await api.del(`/media/${item.id}`); toast.success('Deleted'); onSaved(); onClose(); }
    catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  const K = KIND[f.kind as Kind];

  return (
    <Modal open wide onClose={onClose} title={isNew ? 'Add to the media schedule' : `${K.label}: ${item.title}`}
      footer={<>
        {!isNew && manage && !readOnly && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" />Delete</Button>}
        <Button variant="secondary" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
        {!readOnly && <Button loading={busy} onClick={save} disabled={!item.permissions?.canUpdate && !isNew || (full && (f.title.trim().length < 2 || !f.when || !f.clientIds.length))}>{isNew ? 'Add' : 'Save'}</Button>}
      </>}>
      {full && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {KINDS.map((k) => {
            const I = KIND[k].icon;
            return (
              <button key={k} type="button" onClick={() => set({ kind: k })}
                className={clsx('flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-sm font-medium transition', f.kind === k ? KIND[k].chip + ' ring-2 ring-offset-1 ring-slate-300' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                <I className="h-4 w-4" />{KIND[k].label}
              </button>
            );
          })}
        </div>
      )}
      <Field label="Title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} disabled={!full} autoFocus={isNew}
        placeholder={shoot ? 'e.g. Diwali collection shoot' : f.kind === 'CONTENT' ? 'e.g. Blog: 5 interior trends' : 'e.g. Product launch reel'} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={shoot ? 'Shoot date and time' : f.kind === 'CONTENT' ? 'Due' : 'Post on'}><Input type="datetime-local" value={f.when} onChange={(e) => set({ when: e.target.value })} disabled={!full} /></Field>
        <Field label={shoot ? 'Who is in charge' : f.kind === 'CONTENT' ? 'Writer' : 'Who posts it'}>
          <Select value={f.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })} disabled={!full}>
            <option value="">Not assigned</option>
            {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            {item.assignee && !dir.data?.some((u) => u.id === item.assignee!.id) && <option value={item.assignee.id}>{item.assignee.fullName}</option>}
          </Select>
        </Field>
        {shoot ? <>
          <Field label="Location"><Input value={f.location} onChange={(e) => set({ location: e.target.value })} disabled={!full} placeholder="Studio, address or venue" /></Field>
          <Field label="Models"><Input value={f.models} onChange={(e) => set({ models: e.target.value })} disabled={!full} placeholder="Names, separated by commas" /></Field>
        </> : (
          <Field label="Platform">
            <Input list="media-platforms" value={f.platform} onChange={(e) => set({ platform: e.target.value })} disabled={!full} placeholder="Instagram, YouTube…" />
            <datalist id="media-platforms">{PLATFORMS.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
        )}
        <Field label="Status">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as Status })} disabled={locked}>
            {(Object.keys(MEDIA_STATUS) as Status[]).map((s) => <option key={s} value={s}>{statusLabel(f.kind as Kind, s)}</option>)}
          </Select>
        </Field>
        <Field label={shoot ? 'Link (drive folder, call sheet)' : f.kind === 'CONTENT' ? 'Link to the draft' : 'Link to the post'}>
          <Input value={f.link} onChange={(e) => set({ link: e.target.value })} disabled={locked} placeholder="https://…" />
        </Field>
      </div>
      <Field label="Clients *" hint={full ? 'Choose one or more. Add new clients on the Clients page.' : undefined}>
        {full ? <ClientPicker value={f.clientIds} onChange={(v) => set({ clientIds: v })} />
          : <p className="text-sm text-slate-700">{item.clients?.length ? item.clients.map((c) => c.name).join(', ') : <span className="text-slate-400">No client</span>}</p>}
      </Field>
      <Field label="What happens"><Textarea rows={4} value={f.notes} onChange={(e) => set({ notes: e.target.value })} disabled={locked}
        placeholder={shoot ? 'What is being shot, shot list, props, timings…' : f.kind === 'CONTENT' ? 'What the piece covers, brief, word count…' : 'What the post is about, caption, hashtags…'} /></Field>
      {readOnly && <p className="text-xs text-slate-500">View only. To change this, open it from the Calendar tab.</p>}
      {!full && !readOnly && <p className="text-xs text-slate-500">You can update the status, link and what happens. Ask a media manager to change the rest.</p>}

      {!isNew && shoot && shootCosts.data && (
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Shoot expenses · {inr(shootCosts.data.totals.total)}</span>
            {onAddExpense && <Button size="sm" variant="secondary" onClick={() => { onAddExpense(item as Item); onClose(); }}><Plus className="h-3.5 w-3.5" />Add expense</Button>}
          </div>
          {!shootCosts.data.items.length ? <p className="text-xs text-slate-500">Nothing recorded yet.</p> : (
            <ul className="space-y-1 text-sm">
              {shootCosts.data.items.map((e) => (
                <li key={e.id} className="flex justify-between gap-2"><span>{CATEGORY[e.category]} · {e.payee}</span>
                  <span className="tabular-nums">{inr(e.amount)} {e.paid ? <span className="text-xs text-emerald-600">paid</span> : <span className="text-xs text-amber-600">unpaid</span>}</span></li>
              ))}
            </ul>
          )}
          {shootCosts.data.totals.unpaid > 0 && <p className="mt-2 text-xs text-amber-700">{inr(shootCosts.data.totals.unpaid)} still to pay</p>}
        </div>
      )}
    </Modal>
  );
}

// ───── Scripts ─────

const SCRIPT_STATUS: Record<ScriptStatus, { label: string; hint: string; color: string }> = {
  WRITTEN: { label: 'Written', hint: 'Ready, waiting for the client', color: 'bg-sky-100 text-sky-800' },
  APPROVED: { label: 'Approved by client', hint: 'The client has signed it off', color: 'bg-green-100 text-green-800' },
};

function ScriptModal({ script, clients, onClose, onSaved, readOnly = false }: {
  script: Partial<Script>; clients: { id: string; name: string }[]; onClose: () => void; onSaved: () => void;
  /** View only: nothing can be changed. */
  readOnly?: boolean;
}) {
  const isNew = !script.id;
  const editable = !readOnly && (isNew || !!script.permissions?.canEdit);
  const [f, setF] = useState({
    title: script.title ?? '', body: script.body ?? '', clientId: script.client?.id ?? '', status: (script.status ?? 'WRITTEN') as ScriptStatus,
    when: script.scheduledAt ? toLocalInput(new Date(script.scheduledAt)) : '',
  });
  const [busy, setBusy] = useState(false);
  const set = (c: Partial<typeof f>) => setF({ ...f, ...c });
  const valid = f.title.trim().length >= 2 && f.body.trim().length > 0 && !!f.clientId && !!f.when;
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: f.title.trim(), body: f.body, clientId: f.clientId, scheduledAt: new Date(f.when).toISOString(), status: f.status };
      if (isNew) await api.post('/media-scripts', body); else await api.patch(`/media-scripts/${script.id}`, body);
      toast.success(isNew ? 'Script saved' : 'Script updated'); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm('Delete this script?')) return;
    setBusy(true);
    try { await api.del(`/media-scripts/${script.id}`); toast.success('Script deleted'); onSaved(); onClose(); }
    catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title={isNew ? 'New script' : script.title ?? 'Script'}
      footer={<>
        {!isNew && editable && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" />Delete</Button>}
        <Button variant="secondary" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
        {editable && <Button loading={busy} disabled={!valid} onClick={save}>{isNew ? 'Save script' : 'Save'}</Button>}
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} disabled={!editable} autoFocus={isNew} placeholder="e.g. Diwali offer reel, 30 sec" /></Field>
        <Field label="Client *" hint={editable && !clients.length ? 'No clients yet. Add one on the Clients page first.' : undefined}>
          <Select value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} disabled={!editable} required aria-required="true">
            <option value="" disabled>Choose a client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {script.client && !clients.some((c) => c.id === script.client!.id) && <option value={script.client.id}>{script.client.name}</option>}
          </Select>
        </Field>
      </div>
      <Field label="Due date *" className="sm:max-w-xs"><Input type="datetime-local" value={f.when} onChange={(e) => set({ when: e.target.value })} disabled={!editable} /></Field>
      <Field label="Script *">
        <Textarea rows={14} value={f.body} onChange={(e) => set({ body: e.target.value })} disabled={!editable} className="font-mono text-sm leading-relaxed"
          placeholder={'Scene 1: Opening shot of the store front…\nVoice-over: "This Diwali…"\n\nScene 2: …'} />
      </Field>
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">Status *</p>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Status">
          {(Object.keys(SCRIPT_STATUS) as ScriptStatus[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.status === k} disabled={!editable} onClick={() => set({ status: k })}
              className={clsx('flex items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed',
                f.status === k ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900' : 'border-slate-200 hover:bg-slate-50')}>
              {k === 'APPROVED' ? <CheckCircle2 className={clsx('mt-0.5 h-4 w-4 shrink-0', f.status === k ? 'text-green-600' : 'text-slate-400')} />
                : <PenLine className={clsx('mt-0.5 h-4 w-4 shrink-0', f.status === k ? 'text-sky-600' : 'text-slate-400')} />}
              <span><span className="block text-sm font-medium text-slate-900">{SCRIPT_STATUS[k].label}</span><span className="block text-xs text-slate-500">{SCRIPT_STATUS[k].hint}</span></span>
            </button>
          ))}
        </div>
      </div>
      {!isNew && (
        <p className="text-xs text-slate-500">
          Written by {script.writer?.fullName}{script.approvedAt ? ` · approved ${format(new Date(script.approvedAt), 'd MMM yyyy')}` : ''}
          {readOnly ? ' · View only. To change it, open it from the Calendar tab.' : !editable && ' · Only the writer or a media manager can change it.'}
        </p>
      )}
    </Modal>
  );
}

// ───── Expenses ─────

function ExpensesTab({ month, onEdit }: { month: Date; onEdit: (e: Expense) => void }) {
  const qc = useQueryClient();
  const [category, setCategory] = useState('');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const q = useQuery({
    queryKey: ['media-expenses', month.toISOString(), category],
    queryFn: () => api.get<Expenses>('/media-expenses', { from: format(month, 'yyyy-MM-dd'), to: format(addMonths(month, 1), 'yyyy-MM-dd'), category: category || undefined }),
  });
  const togglePaid = async (e: Expense) => {
    try { await api.patch(`/media-expenses/${e.id}`, { paid: !e.paid }); invalidate(qc); toast.success(e.paid ? 'Marked unpaid' : 'Marked paid'); }
    catch (err) { toast.error(errMsg(err)); }
  };
  const rows = useMemo(() => (q.data?.items ?? []).filter((e) => !unpaidOnly || !e.paid), [q.data, unpaidOnly]);
  if (q.isLoading) return <Spinner />;
  const t = q.data?.totals;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={`Spent in ${format(month, 'MMMM')}`} value={inr(t?.total ?? 0)} />
        <StatCard label="Model fees" value={inr(t?.byCategory.MODEL ?? 0)} />
        <StatCard label="Paid" value={inr(t?.paid ?? 0)} tone="good" />
        <StatCard label="Still to pay" value={inr(t?.unpaid ?? 0)} tone={t?.unpaid ? 'warn' : 'default'} onClick={() => setUnpaidOnly(!unpaidOnly)} sub={unpaidOnly ? 'Showing unpaid only' : 'Click to show unpaid only'} />
      </div>
      <Card title="Expenses" actions={
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-40 py-1 text-xs" aria-label="Category">
          <option value="">All categories</option>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      }>
        {!rows.length ? <Empty title="No expenses recorded for this month" icon={<IndianRupee className="h-8 w-8" />}>Add model fees, location hire and other shoot costs with Add expense.</Empty> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Category</Th><Th>Paid to</Th><Th>For shoot</Th><Th>Details</Th><Th className="text-right">Amount</Th><Th>Paid</Th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onEdit(e)}>
                  <Td className="whitespace-nowrap">{format(new Date(e.spentOn.slice(0, 10) + 'T00:00'), 'd MMM')}</Td>
                  <Td><Badge className={e.category === 'MODEL' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'}>{CATEGORY[e.category]}</Badge></Td>
                  <Td className="font-medium">{e.payee}</Td>
                  <Td className="text-slate-600">{e.shoot?.title ?? '—'}</Td>
                  <Td className="max-w-56 truncate text-slate-600">{e.description || '—'}</Td>
                  <Td className="text-right font-medium tabular-nums">{inr(e.amount)}</Td>
                  <Td><div onClick={(ev) => ev.stopPropagation()}>
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={e.paid} onChange={() => togglePaid(e)} />
                      {e.paid ? <span className="text-emerald-700">Paid{e.paidOn ? ` ${format(new Date(e.paidOn.slice(0, 10) + 'T00:00'), 'd MMM')}` : ''}</span> : <span className="text-amber-700">Unpaid</span>}
                    </label>
                  </div></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function ExpenseModal({ expense, onClose, onSaved }: { expense: Partial<Expense>; onClose: () => void; onSaved: () => void }) {
  const isNew = !expense.id;
  // Shoots from three months back to three ahead, to link the cost to.
  const shoots = useQuery({
    queryKey: ['media', 'shoots-pick'],
    queryFn: () => api.get<Item[]>('/media', { kind: 'SHOOT', from: addMonths(new Date(), -3).toISOString(), to: addMonths(new Date(), 3).toISOString() }),
  });
  const [f, setF] = useState({
    spentOn: expense.spentOn?.slice(0, 10) ?? format(new Date(), 'yyyy-MM-dd'), category: expense.category ?? 'MODEL', payee: expense.payee ?? '',
    description: expense.description ?? '', amount: expense.amount !== undefined ? String(expense.amount) : '', paid: expense.paid ?? false,
    shootId: expense.shoot?.id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (c: Partial<typeof f>) => setF({ ...f, ...c });
  const amount = Number(f.amount);
  const valid = f.payee.trim() && f.amount !== '' && Number.isFinite(amount) && amount >= 0 && f.spentOn;
  const save = async () => {
    setBusy(true);
    try {
      const body = { spentOn: f.spentOn, category: f.category, payee: f.payee.trim(), description: f.description || null, amount: Math.round(amount * 100) / 100, paid: f.paid, shootId: f.shootId || null };
      if (isNew) await api.post('/media-expenses', body); else await api.patch(`/media-expenses/${expense.id}`, body);
      toast.success(isNew ? 'Expense added' : 'Expense saved'); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm('Delete this expense?')) return;
    setBusy(true);
    try { await api.del(`/media-expenses/${expense.id}`); toast.success('Expense deleted'); onSaved(); onClose(); }
    catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  const shootList = shoots.data ?? [];
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add an expense' : 'Edit expense'} footer={<>
      {!isNew && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" />Delete</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!valid} onClick={save}>{isNew ? 'Add' : 'Save'}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category">
          <Select value={f.category} onChange={(e) => set({ category: e.target.value as Category })}>
            {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Date"><Input type="date" value={f.spentOn} onChange={(e) => set({ spentOn: e.target.value })} /></Field>
      </div>
      <Field label={f.category === 'MODEL' ? 'Model name' : 'Paid to'}><Input value={f.payee} onChange={(e) => set({ payee: e.target.value })} autoFocus={isNew} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)"><Input type="number" min="0" step="0.01" inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
        <Field label="For shoot (optional)">
          <Select value={f.shootId} onChange={(e) => set({ shootId: e.target.value })}>
            <option value="">Not tied to a shoot</option>
            {shootList.map((s) => <option key={s.id} value={s.id}>{format(new Date(s.scheduledAt), 'd MMM')} · {s.title}</option>)}
            {expense.shoot && !shootList.some((s) => s.id === expense.shoot!.id) && <option value={expense.shoot.id}>{expense.shoot.title}</option>}
          </Select>
        </Field>
      </div>
      <Field label="Details"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Half day, travel included, invoice number…" /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.paid} onChange={(e) => set({ paid: e.target.checked })} />Already paid</label>
    </Modal>
  );
}
