import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  addDays, addMonths, endOfMonth, format, isSameDay, isSameMonth, startOfMonth, startOfWeek,
} from 'date-fns';
import { Camera, ChevronLeft, ChevronRight, Clapperboard, ExternalLink, Flag, FlagOff, Image, IndianRupee, PenLine, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { ClientPostingTab } from '../components/PostingCalendar';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { toLocalInput } from '../lib/format';
import {
  Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Table, Tabs, Td, Textarea, Th,
} from '../components/ui';

type Kind = 'SHOOT' | 'REEL' | 'CONTENT' | 'IMAGE';
type Status = 'PLANNED' | 'IN_PROGRESS' | 'READY' | 'DONE' | 'CANCELLED';
type Category = 'MODEL' | 'LOCATION' | 'EQUIPMENT' | 'TRAVEL' | 'FOOD' | 'PROPS' | 'OTHER';
interface Person { id: string; fullName: string }
interface Item {
  id: string; kind: Kind; title: string; scheduledAt: string; status: Status;
  assignee: Person | null; createdBy: Person; client: { id: string; name: string } | null;
  platform: string | null; location: string | null; models: string | null; link: string | null; notes: string | null;
  _count: { expenses: number };
  permissions: { canManage: boolean; canUpdate: boolean };
}
interface Expense {
  id: string; spentOn: string; category: Category; payee: string; description: string | null; amount: number;
  paid: boolean; paidOn: string | null; shoot: { id: string; title: string; scheduledAt: string } | null; createdBy: Person;
}
interface Expenses { items: Expense[]; totals: { total: number; paid: number; unpaid: number; byCategory: Record<Category, number> } }
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

type Tab = 'calendar' | Kind | 'posting' | 'expenses';

/** An entry from a client's posting calendar, shown on the Media calendar. */
interface PostingEvent {
  date: string; type: 'LEAD_START' | 'LEAD_END' | 'SHOOT' | 'VIDEO' | 'POSTER';
  clientId: string; client: string; label: string | null; status: 'NONE' | 'NOT_YET' | 'DONE' | null; slotId?: string;
}
type PostingFeed = { today: string; canEdit?: boolean; events: PostingEvent[] };

/** Every client keeps one colour on the calendar. */
const CLIENT_COLORS = ['bg-teal-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-emerald-600', 'bg-indigo-500', 'bg-orange-500', 'bg-fuchsia-500', 'bg-cyan-600'];
const clientColor = (id: string) => CLIENT_COLORS[[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % CLIENT_COLORS.length];
type Mark = 'done' | 'todo' | 'late';
const markOf = (e: PostingEvent, today: string): Mark => (e.status === 'DONE' ? 'done' : e.date < today ? 'late' : 'todo');
const MARK: Record<Mark, { dot: string; label: string; pill: string }> = {
  done: { dot: 'bg-green-500', label: 'Done', pill: 'bg-green-100 text-green-800' },
  todo: { dot: 'bg-amber-400', label: 'To do', pill: 'bg-amber-100 text-amber-800' },
  late: { dot: 'bg-rose-500', label: 'Overdue', pill: 'bg-rose-100 text-rose-700' },
};
/** A day's posting events, one group per client. */
function byClient(events: PostingEvent[]) {
  const m = new Map<string, { clientId: string; client: string; events: PostingEvent[] }>();
  for (const e of events) {
    if (!m.has(e.clientId)) m.set(e.clientId, { clientId: e.clientId, client: e.client, events: [] });
    m.get(e.clientId)!.events.push(e);
  }
  return [...m.values()].sort((a, b) => a.client.localeCompare(b.client));
}
const POSTING_ORDER: Record<PostingEvent['type'], number> = { LEAD_START: 0, SHOOT: 1, VIDEO: 2, POSTER: 3, LEAD_END: 4 };

export default function Media() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'calendar';
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [assignee, setAssignee] = useState('');
  const [editing, setEditing] = useState<Partial<Item> | null>(null);
  const [expense, setExpense] = useState<Partial<Expense> | null>(null);
  const manage = can('media.manage');
  const seesAll = manage || can('media.view.all');
  const money = can('media.expenses');
  const dir = useDirectory();

  // The calendar shows whole weeks, so it reaches a few days into the months either side.
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const to = addDays(startOfWeek(endOfMonth(month), { weekStartsOn: 1 }), 7); // Midnight after the last Sunday shown
  const items = useQuery({
    queryKey: ['media', from.toISOString(), assignee],
    queryFn: () => api.get<Item[]>('/media', { from: from.toISOString(), to: to.toISOString(), assignee: assignee || undefined }),
  });
  const summary = useQuery({ queryKey: ['media-summary'], queryFn: () => api.get<Summary>('/media/summary') });
  const seesPosting = can('clients.posting', 'clients.manage', 'clients.view.all');
  const posting = useQuery({
    queryKey: ['posting-calendar', format(from, 'yyyy-MM-dd')],
    queryFn: () => api.get<PostingFeed>('/posting/calendar', { from: format(from, 'yyyy-MM-dd'), to: format(addDays(to, -1), 'yyyy-MM-dd') }),
    enabled: seesPosting,
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
  const inMonth = (items.data ?? []).filter((i) => isSameMonth(new Date(i.scheduledAt), month));
  const newItem = (kind: Kind, at?: Date) => {
    const d = at ? new Date(at) : new Date();
    if (at) d.setHours(10, 0, 0, 0);
    setEditing({ kind, scheduledAt: d.toISOString(), status: 'PLANNED' });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Media"
        subtitle={seesAll ? 'Shoots, reels, content and image posts: when they happen and who is on each' : 'Media work assigned to you'}
        actions={<>
          {money && tab === 'expenses' && <Button variant="secondary" onClick={() => setExpense({ category: 'MODEL', spentOn: format(new Date(), 'yyyy-MM-dd') })}><IndianRupee className="h-4 w-4" />Add expense</Button>}
          {manage && <Button onClick={() => newItem((KINDS as string[]).includes(tab) ? (tab as Kind) : 'SHOOT')}><Plus className="h-4 w-4" />Add to schedule</Button>}
        </>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {KINDS.map((k) => <StatCard key={k} label={`${KIND[k].plural} · next 7 days`} value={summary.data?.thisWeek[k] ?? '—'} onClick={() => setTab(k)} />)}
        <StatCard label="Past date, not done" value={summary.data?.overdue ?? '—'} tone={summary.data?.overdue ? 'bad' : 'default'} />
        <StatCard label="Open and assigned to me" value={summary.data?.mine ?? '—'} onClick={() => setAssignee(assignee === 'me' ? '' : 'me')} sub={assignee === 'me' ? 'Showing only mine' : undefined} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'calendar', label: 'Calendar' },
          ...KINDS.map((k) => ({ value: k as Tab, label: KIND[k].plural, count: !(KINDS as string[]).includes(tab) ? undefined : inMonth.filter((i) => i.kind === k).length })),
          ...(seesPosting ? [{ value: 'posting' as Tab, label: 'Client schedules' }] : []),
          ...(money ? [{ value: 'expenses' as Tab, label: 'Expenses' }] : []),
        ]} />
        {tab !== 'posting' && <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="w-32 text-center text-sm font-semibold">{format(month, 'MMMM yyyy')}</span>
            <Button size="sm" variant="secondary" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
          </div>
          {seesAll && tab !== 'expenses' && (
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-44" aria-label="Assigned to">
              <option value="">Everyone</option>
              <option value="me">Assigned to me</option>
              {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          )}
        </div>}
      </div>

      {tab === 'posting' ? (
        <ClientPostingTab clientId={params.get('client')} onPick={(c) => setParams(c ? { tab: 'posting', client: c } : { tab: 'posting' }, { replace: true })} />
      ) : tab === 'expenses' ? (
        <ExpensesTab month={month} onEdit={setExpense} />
      ) : items.isLoading ? <Spinner /> : items.error ? <ErrorBox error={items.error} /> : tab === 'calendar' ? (
        <Calendar month={month} from={from} to={to} items={items.data ?? []} onOpen={setEditing} onAdd={manage ? (kind, d) => newItem(kind, d) : undefined}
          posting={seesPosting ? posting.data : undefined}
          onPostingChanged={() => { posting.refetch(); qc.invalidateQueries({ queryKey: ['posting-overview'] }); qc.invalidateQueries({ queryKey: ['posting-due'] }); }} />
      ) : (
        <KindList kind={tab} items={inMonth.filter((i) => i.kind === tab)} onOpen={setEditing} manage={manage} onAdd={() => newItem(tab)} />
      )}

      {editing && <ItemModal item={editing} onClose={() => setEditing(null)} onAddExpense={money ? (shoot) => setExpense({ category: 'MODEL', spentOn: shoot.scheduledAt.slice(0, 10), shoot: { id: shoot.id, title: shoot.title, scheduledAt: shoot.scheduledAt } }) : undefined} onSaved={() => invalidate(qc)} />}
      {expense && <ExpenseModal expense={expense} onClose={() => setExpense(null)} onSaved={() => invalidate(qc)} />}
    </div>
  );
}

// ───── Calendar ─────

function Calendar({ month, from, to, items, onOpen, onAdd, posting, onPostingChanged }: {
  month: Date; from: Date; to: Date; items: Item[]; onOpen: (i: Item) => void; onAdd?: (kind: Kind, d: Date) => void;
  posting?: PostingFeed; onPostingChanged?: () => void;
}) {
  const [hidden, setHidden] = useState<Kind[]>([]);
  const [showPosting, setShowPosting] = useState(true);
  const [dayOpen, setDayOpen] = useState<string | null>(null); // yyyy-MM-dd whose full list is open
  const MAX_CLIENTS = 3;
  const [menuDay, setMenuDay] = useState<string | null>(null); // Day whose "add" menu is open
  useEffect(() => {
    if (!menuDay) return;
    const close = () => setMenuDay(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('click', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', esc); };
  }, [menuDay]);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const shown = items.filter((i) => !hidden.includes(i.kind));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        {KINDS.map((k) => (
          <button key={k} onClick={() => setHidden(hidden.includes(k) ? hidden.filter((h) => h !== k) : [...hidden, k])}
            className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', hidden.includes(k) ? 'border-slate-200 text-slate-400' : KIND[k].chip)}>
            <span className={clsx('h-2 w-2 rounded-full', hidden.includes(k) ? 'bg-slate-300' : KIND[k].dot)} />{KIND[k].plural}
          </button>
        ))}
        {posting && (
          <button onClick={() => setShowPosting(!showPosting)} aria-pressed={showPosting}
            title="Lead start and end, shoot dates, and each client's reels and AI posters from their posting calendar"
            className={clsx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', showPosting ? 'border-teal-200 bg-teal-50 text-teal-800' : 'border-slate-200 text-slate-400')}>
            <span className={clsx('h-2 w-2 rounded-full', showPosting ? 'bg-teal-500' : 'bg-slate-300')} />Client posting
          </button>
        )}
        {posting && showPosting && (
          <span className="flex items-center gap-2.5 text-[11px] text-slate-500">
            {(['done', 'todo', 'late'] as Mark[]).map((m) => <span key={m} className="flex items-center gap-1"><span className={clsx('h-2 w-2 rounded-full', MARK[m].dot)} />{MARK[m].label}</span>)}
            <span className="hidden items-center gap-1 sm:flex"><Clapperboard className="h-3 w-3" />Reel</span>
            <span className="hidden items-center gap-1 sm:flex"><Image className="h-3 w-3" />Poster</span>
          </span>
        )}
        {onAdd && <span className="ml-auto text-xs text-slate-400">Use + on a day to schedule a shoot, reel, content or image post</span>}
      </div>
      <div className="scroll-thin overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="border-b border-slate-100 px-2 py-1.5 text-xs font-semibold uppercase text-slate-500">{d}</div>)}
          {days.map((d, idx) => {
            const nearBottom = idx >= days.length - 14; // Last two weeks open the menu upwards so it isn't cut off.
            const today = isSameDay(d, new Date());
            const list = shown.filter((i) => isSameDay(new Date(i.scheduledAt), d)).sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
            const key = d.toISOString();
            const dayKey = format(d, 'yyyy-MM-dd');
            const clientEvents = showPosting && posting
              ? posting.events.filter((e) => e.date === dayKey).sort((a, b) => POSTING_ORDER[a.type] - POSTING_ORDER[b.type] || a.client.localeCompare(b.client))
              : [];
            return (
              <div key={key} className={clsx('group relative min-h-28 border-b border-r border-slate-100 p-1.5', !isSameMonth(d, month) && 'bg-slate-50/70', onAdd && 'hover:bg-indigo-50/30')}>
                <div className="mb-1 flex items-center justify-between">
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); if (clientEvents.length) setDayOpen(dayKey); }}
                    title={clientEvents.length ? 'See everything on this day' : undefined}
                    className={clsx('flex h-6 w-6 items-center justify-center rounded-full text-xs', today ? 'bg-slate-900 font-semibold text-white' : isSameMonth(d, month) ? 'text-slate-700' : 'text-slate-400', clientEvents.length && !today && 'hover:bg-slate-200')}>{format(d, 'd')}</button>
                  {onAdd && (
                    <button type="button" aria-label={`Add on ${format(d, 'd MMMM')}`} title={`Add on ${format(d, 'd MMM')}`}
                      onClick={(e) => { e.stopPropagation(); setMenuDay(menuDay === key ? null : key); }}
                      className={clsx('flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-surface text-slate-500 shadow-sm transition hover:border-slate-400 hover:text-slate-900',
                        menuDay === key ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100')}>
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {onAdd && menuDay === key && (
                  <div onClick={(e) => e.stopPropagation()} className={clsx('absolute right-1.5 z-20 w-44', nearBottom ? 'bottom-9' : 'top-9', ' rounded-xl border border-slate-200 bg-surface p-1 shadow-xl')}>
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{format(d, 'EEE d MMM')}</p>
                    {KINDS.map((k) => {
                      const I = KIND[k].icon;
                      return (
                        <button key={k} type="button" onClick={() => { setMenuDay(null); onAdd(k, d); }}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100">
                          <span className={clsx('h-2 w-2 rounded-full', KIND[k].dot)} /><I className="h-4 w-4 text-slate-400" />{KIND[k].label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="space-y-1">
                  {list.map((i) => (
                    <button key={i.id} onClick={(e) => { e.stopPropagation(); onOpen(i); }} title={`${KIND[i.kind].label}: ${i.title}${i.assignee ? ` · ${i.assignee.fullName}` : ''}`}
                      className={clsx('block w-full truncate rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-4', KIND[i.kind].chip, !isOpen(i.status) && 'opacity-60', i.status === 'CANCELLED' && 'line-through')}>
                      <span className="font-semibold">{format(new Date(i.scheduledAt), 'h:mm')}</span> {i.title}
                      {i.assignee && <span className="opacity-70"> · {i.assignee.fullName.split(' ')[0]}</span>}
                    </button>
                  ))}
                  {(() => {
                    if (!clientEvents.length) return null;
                    const groups = byClient(clientEvents);
                    const shownGroups = groups.slice(0, MAX_CLIENTS);
                    return <>
                      {shownGroups.map((g) => <ClientLine key={g.clientId} group={g} today={posting!.today} />)}
                      {groups.length > MAX_CLIENTS && (
                        <button onClick={(ev) => { ev.stopPropagation(); setDayOpen(dayKey); }}
                          className="w-full rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                          +{groups.length - MAX_CLIENTS} more
                        </button>
                      )}
                    </>;
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {dayOpen && posting && (
        <DayPosting date={dayOpen} today={posting.today} canEdit={!!posting.canEdit}
          events={posting.events.filter((e) => e.date === dayOpen)} onClose={() => setDayOpen(null)} onChanged={() => onPostingChanged?.()} />
      )}
    </Card>
  );
}

const SHORT: Record<PostingEvent['type'], string> = { LEAD_START: 'Lead start', LEAD_END: 'Lead end', SHOOT: 'Shoot', VIDEO: 'Reel / video', POSTER: 'AI poster' };

/** One client on one day: colour bar, name, period and shoot markers, and a status dot per reel and poster. */
function ClientLine({ group, today }: { group: { clientId: string; client: string; events: PostingEvent[] }; today: string }) {
  const has = (t: PostingEvent['type']) => group.events.some((e) => e.type === t);
  const work = group.events.filter((e) => e.type === 'VIDEO' || e.type === 'POSTER');
  const tip = [group.client, ...group.events.map((e) => `${e.label ?? SHORT[e.type]}${e.type === 'VIDEO' || e.type === 'POSTER' ? ` (${MARK[markOf(e, today)].label.toLowerCase()})` : ''}`)].join('\n');
  const allDone = work.length > 0 && work.every((e) => e.status === 'DONE') && !has('LEAD_START') && !has('LEAD_END') && !has('SHOOT');
  return (
    <Link to={`/media?tab=posting&client=${group.clientId}`} onClick={(ev) => ev.stopPropagation()} title={tip}
      className={clsx('flex w-full items-center gap-1.5 rounded-md bg-white py-0.5 pl-0.5 pr-1.5 text-[11px] leading-4 text-slate-700 shadow-[0_0_0_1px_rgb(226_232_240)] hover:shadow-[0_0_0_1px_rgb(148_163_184)]', allDone && 'opacity-60')}>
      <span className={clsx('h-4 w-1 shrink-0 rounded-full', clientColor(group.clientId))} />
      <span className="min-w-0 flex-1 truncate font-medium">{group.client}</span>
      {has('LEAD_START') && <span className="shrink-0 rounded bg-teal-600 px-1 text-[9px] font-bold uppercase text-white" title="Lead period starts">Start</span>}
      {has('LEAD_END') && <span className="shrink-0 rounded bg-slate-700 px-1 text-[9px] font-bold uppercase text-white" title="Lead period ends">End</span>}
      {has('SHOOT') && <Camera className="h-3 w-3 shrink-0 text-teal-700" aria-label="Shoot" />}
      {work.map((e, i) => {
        const Icon = e.type === 'VIDEO' ? Clapperboard : Image;
        return (
          <span key={i} className="relative shrink-0 text-slate-400">
            <Icon className="h-3 w-3" />
            <span className={clsx('absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-white', MARK[markOf(e, today)].dot)} />
          </span>
        );
      })}
    </Link>
  );
}

/** Everything from the posting calendars on one day, grouped by client, with Mark done. */
function DayPosting({ date, today, events, canEdit, onClose, onChanged }: {
  date: string; today: string; events: PostingEvent[]; canEdit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const done = async (e: PostingEvent) => {
    if (!e.slotId) return;
    setBusy(`${e.slotId}-${e.type}`);
    try {
      await api.patch(`/posting/rows/${e.slotId}`, e.type === 'VIDEO' ? { videoStatus: 'DONE' } : { posterStatus: 'DONE' });
      toast.success('Marked done'); onChanged();
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(null); }
  };
  return (
    <Modal open wide onClose={onClose} title={format(new Date(`${date}T12:00:00`), 'EEEE d MMMM yyyy')}>
      {!events.length ? <p className="text-sm text-slate-500">Nothing planned.</p> : (
        <div className="space-y-3">
          {byClient(events).map((g) => (
            <div key={g.clientId} className="rounded-xl border border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
                <span className={clsx('h-3 w-3 rounded-full', clientColor(g.clientId))} />
                <Link to={`/media?tab=posting&client=${g.clientId}`} onClick={onClose} className="font-semibold text-slate-900 hover:underline">{g.client}</Link>
              </div>
              <ul className="divide-y divide-slate-50">
                {g.events.sort((a, b) => POSTING_ORDER[a.type] - POSTING_ORDER[b.type]).map((e, i) => {
                  const work = e.type === 'VIDEO' || e.type === 'POSTER';
                  const m = markOf(e, today);
                  const Icon = e.type === 'LEAD_START' ? Flag : e.type === 'LEAD_END' ? FlagOff : e.type === 'SHOOT' ? Camera : e.type === 'VIDEO' ? Clapperboard : Image;
                  return (
                    <li key={i} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="text-slate-500">{SHORT[e.type]}</span>
                      {work && e.label && <span className="font-medium text-slate-800">{e.label}</span>}
                      {work && <span className={clsx('ml-auto rounded-full px-2 py-0.5 text-xs font-medium', MARK[m].pill)}>{MARK[m].label}</span>}
                      {work && canEdit && e.status !== 'DONE' && (
                        <Button size="sm" variant="secondary" loading={busy === `${e.slotId}-${e.type}`} onClick={() => done(e)}>Mark done</Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ───── One list per kind ─────

function KindList({ kind, items, onOpen, manage, onAdd }: { kind: Kind; items: Item[]; onOpen: (i: Item) => void; manage: boolean; onAdd: () => void }) {
  const qc = useQueryClient();
  const K = KIND[kind];
  const setStatus = async (i: Item, status: Status) => {
    try { await api.patch(`/media/${i.id}`, { status }); invalidate(qc); toast.success(`Marked ${statusLabel(i.kind, status).toLowerCase()}`); }
    catch (e) { toast.error(errMsg(e)); }
  };
  if (!items.length) {
    return <Card><Empty title={`No ${K.plural.toLowerCase()} this month`} icon={<K.icon className="h-8 w-8" />}>
      {manage ? <Button className="mt-3" onClick={onAdd}><Plus className="h-4 w-4" />Add {K.label.toLowerCase()}</Button> : 'When something is scheduled for you it shows up here.'}
    </Empty></Card>;
  }
  const now = new Date();
  return (
    <Card>
      <Table>
        <thead><tr>
          <Th>When</Th><Th>{kind === 'CONTENT' ? 'Piece' : 'Title'}</Th><Th>Assigned to</Th>
          {kind === 'SHOOT' ? <><Th>Location</Th><Th>Models</Th></> : <Th>Platform</Th>}
          <Th>Client</Th><Th>Status</Th>
        </tr></thead>
        <tbody>
          {items.map((i) => {
            const late = isOpen(i.status) && new Date(i.scheduledAt) < now;
            return (
              <tr key={i.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(i)}>
                <Td className="whitespace-nowrap">
                  <div className="font-medium">{format(new Date(i.scheduledAt), 'EEE d MMM')}</div>
                  <div className={clsx('text-xs', late ? 'font-medium text-rose-600' : 'text-slate-500')}>{format(new Date(i.scheduledAt), 'h:mm a')}{late && ' · past date'}</div>
                </Td>
                <Td>
                  <div className="font-medium text-slate-900">{i.title}</div>
                  {i.link && <a href={i.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs text-indigo-700 hover:underline"><ExternalLink className="h-3 w-3" />Open link</a>}
                </Td>
                <Td>{i.assignee ? <span className="flex items-center gap-2"><Avatar name={i.assignee.fullName} size="sm" />{i.assignee.fullName}</span> : <span className="text-slate-400">Not assigned</span>}</Td>
                {kind === 'SHOOT'
                  ? <><Td className="text-slate-600">{i.location || '—'}</Td><Td className="max-w-48 truncate text-slate-600">{i.models || '—'}</Td></>
                  : <Td className="text-slate-600">{i.platform || '—'}</Td>}
                <Td className="text-slate-600">{i.client?.name ?? '—'}</Td>
                <Td><div onClick={(e) => e.stopPropagation()}>
                  {i.permissions.canUpdate ? (
                    <Select value={i.status} onChange={(e) => setStatus(i, e.target.value as Status)} className="w-36 py-1 text-xs" aria-label="Status">
                      {(Object.keys(MEDIA_STATUS) as Status[]).map((s) => <option key={s} value={s}>{statusLabel(kind, s)}</option>)}
                    </Select>
                  ) : <Badge className={MEDIA_STATUS[i.status].color}>{statusLabel(kind, i.status)}</Badge>}
                </div></Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

// ───── Add / edit a schedule entry ─────

function ItemModal({ item, onClose, onSaved, onAddExpense }: {
  item: Partial<Item>; onClose: () => void; onSaved: () => void; onAddExpense?: (shoot: Item) => void;
}) {
  const { can } = useAuth();
  const dir = useDirectory();
  const isNew = !item.id;
  const manage = can('media.manage');
  const full = isNew || manage; // Assignees may only change status, link and notes.
  const clients = useQuery({ queryKey: ['clients', '', ''], queryFn: () => api.get<{ id: string; name: string }[]>('/clients', {}), enabled: full, staleTime: 60_000 });
  const shootCosts = useQuery({
    queryKey: ['media-expenses', 'shoot', item.id],
    queryFn: () => api.get<Expenses>('/media-expenses', { shootId: item.id }),
    enabled: !isNew && item.kind === 'SHOOT' && can('media.expenses'),
  });
  const [f, setF] = useState({
    kind: item.kind ?? 'SHOOT', title: item.title ?? '', when: item.scheduledAt ? toLocalInput(new Date(item.scheduledAt)) : '',
    status: item.status ?? 'PLANNED', assigneeId: item.assignee?.id ?? '', clientId: item.client?.id ?? '', platform: item.platform ?? '',
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
        assigneeId: f.assigneeId || null, clientId: f.clientId || null, platform: shoot ? null : f.platform || null,
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
        {!isNew && manage && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" />Delete</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} onClick={save} disabled={!item.permissions?.canUpdate && !isNew || (full && (f.title.trim().length < 2 || !f.when))}>{isNew ? 'Add' : 'Save'}</Button>
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
        <Field label="Client (optional)">
          <Select value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} disabled={!full}>
            <option value="">Prisim's own</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {item.client && !clients.data?.some((c) => c.id === item.client!.id) && <option value={item.client.id}>{item.client.name}</option>}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as Status })} disabled={!isNew && !item.permissions?.canUpdate}>
            {(Object.keys(MEDIA_STATUS) as Status[]).map((s) => <option key={s} value={s}>{statusLabel(f.kind as Kind, s)}</option>)}
          </Select>
        </Field>
        <Field label={shoot ? 'Link (drive folder, call sheet)' : f.kind === 'CONTENT' ? 'Link to the draft' : 'Link to the post'}>
          <Input value={f.link} onChange={(e) => set({ link: e.target.value })} disabled={!isNew && !item.permissions?.canUpdate} placeholder="https://…" />
        </Field>
      </div>
      <Field label="Notes"><Textarea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} disabled={!isNew && !item.permissions?.canUpdate}
        placeholder={shoot ? 'Shot list, props, timings…' : 'Caption, hashtags, brief…'} /></Field>
      {!full && <p className="text-xs text-slate-500">You can update the status, link and notes. Ask a media manager to change the rest.</p>}

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
