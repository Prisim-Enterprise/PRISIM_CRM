import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight, Download, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner, StatCard, Table, Tabs, Td, Th } from '../components/ui';
import { PRIORITY } from '../lib/format';

interface Counts {
  tasksAssigned: number; tasksCompleted: number; onTime: number; late: number; overdueOpen: number;
  callsMade: number; followUpsCompleted: number; leadsConverted: number; clientWorkDone: number; seoUpdates: number; mediaDone: number;
}
interface Person extends Counts { userId: string; name: string; teams: string[]; avgDaysToComplete: number | null }
interface Team extends Counts { name: string; members: string[] }
interface TaskRow { taskId: string; key: string; title: string; priority: string; people: string[]; teams: string[]; createdAt: string; dueAt: string | null; completedAt: string; onTime: boolean }
interface Report {
  month: string; scope: 'all' | 'team' | 'own'; final: boolean; generatedAt: string;
  summary: Omit<Counts, 'overdueOpen'> & { onTimeRate: number | null; people: number };
  people: Person[]; teams: Team[]; tasks: TaskRow[];
}

const thisMonth = () => format(new Date(), 'yyyy-MM');
const monthName = (m: string) => format(new Date(`${m}-15T12:00:00`), 'MMMM yyyy');
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const rate = (c: Counts) => (c.tasksCompleted ? c.onTime / c.tasksCompleted : null);

/** Columns shown for both people and teams. */
const COLS: { key: keyof Counts; label: string; tip?: string }[] = [
  { key: 'tasksAssigned', label: 'Assigned', tip: 'Tasks given to them this month' },
  { key: 'tasksCompleted', label: 'Completed' },
  { key: 'onTime', label: 'On time' },
  { key: 'late', label: 'Late' },
  { key: 'overdueOpen', label: 'Overdue', tip: 'Due by the end of the month and not finished by then' },
  { key: 'callsMade', label: 'Calls' },
  { key: 'followUpsCompleted', label: 'Follow-ups' },
  { key: 'leadsConverted', label: 'Converted' },
  { key: 'clientWorkDone', label: 'Client work' },
  { key: 'seoUpdates', label: 'SEO updates' },
  { key: 'mediaDone', label: 'Media' },
];

export default function Reports() {
  const [month, setMonth] = useState(thisMonth());
  const [tab, setTab] = useState<'people' | 'teams' | 'tasks'>('people');
  const [open, setOpen] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const q = useQuery({ queryKey: ['monthly-report', month], queryFn: () => api.get<Report>('/reports/monthly', { month }) });
  const r = q.data;

  const download = async () => {
    setDownloading(true);
    try { await api.download('/reports/monthly/download', { month }, `prisim-monthly-report-${month}.csv`); toast.success('Report downloaded'); }
    catch (e) { toast.error(errMsg(e)); } finally { setDownloading(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        subtitle={r ? (r.scope === 'all' ? 'Monthly report for the whole company' : r.scope === 'team' ? 'Monthly report for your team' : 'Your monthly report') : 'Monthly report'}
        actions={<>
          <Input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" aria-label="Month" />
          <Button variant="secondary" onClick={() => window.print()} disabled={!r} className="print:hidden"><Printer className="h-4 w-4" />Print / PDF</Button>
          <Button onClick={download} loading={downloading} disabled={!r} className="print:hidden"><Download className="h-4 w-4" />Download report</Button>
        </>}
      />

      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : r && <>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <h2 className="text-lg font-semibold text-slate-900">{monthName(r.month)}</h2>
          {r.final
            ? <Badge className="bg-green-100 text-green-800">Final · month ended</Badge>
            : <Badge className="bg-amber-100 text-amber-800">In progress · final at the end of the month</Badge>}
          <span className="text-xs text-slate-500">Generated {format(new Date(r.generatedAt), 'd MMM yyyy, h:mm a')}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Tasks assigned" value={r.summary.tasksAssigned} />
          <StatCard label="Tasks completed" value={r.summary.tasksCompleted} tone="good" />
          <StatCard label="On time" value={pct(r.summary.onTimeRate)} sub={`${r.summary.onTime} on time · ${r.summary.late} late`} tone={r.summary.late ? 'warn' : 'default'} />
          <StatCard label="Calls made" value={r.summary.callsMade} />
          <StatCard label="Leads converted" value={r.summary.leadsConverted} />
          <StatCard label="Client work done" value={r.summary.clientWorkDone} sub={`${r.summary.seoUpdates} SEO updates · ${r.summary.mediaDone} media`} />
        </div>

        <div className="print:hidden">
          <Tabs value={tab} onChange={(v) => { setTab(v); setOpen(null); }} tabs={[
            { value: 'people', label: 'By person', count: r.people.length },
            { value: 'teams', label: 'By team', count: r.teams.length },
            { value: 'tasks', label: 'Tasks completed', count: r.tasks.length },
          ]} />
        </div>

        {/* On paper every section prints, one after another. */}
        <section className={clsx(tab !== 'people' && 'hidden print:block')}>
          <h3 className="mb-2 hidden text-base font-semibold print:block">By person</h3>
          <Card>
            {!r.people.length ? <Empty title="No one to report on" /> : (
              <Table>
                <thead><tr><Th>Person</Th>{COLS.map((c) => <Th key={c.key} className="text-right"><span title={c.tip}>{c.label}</span></Th>)}<Th className="text-right">On-time rate</Th></tr></thead>
                <tbody>
                  {r.people.map((p) => {
                    const mine = r.tasks.filter((t) => t.people.includes(p.name));
                    const isOpen = open === p.userId;
                    return (
                      <Fragment key={p.userId}>
                        <tr className={clsx('cursor-pointer hover:bg-slate-50', isOpen && 'bg-slate-50')} onClick={() => setOpen(isOpen ? null : p.userId)} aria-expanded={isOpen}>
                          <Td>
                            <span className="flex items-center gap-1.5">
                              {isOpen ? <ChevronDown className="h-4 w-4 text-slate-400 print:hidden" /> : <ChevronRight className="h-4 w-4 text-slate-400 print:hidden" />}
                              <span><p className="font-medium text-slate-900">{p.name}</p><p className="text-xs text-slate-500">{p.teams.join(', ') || 'No team'}</p></span>
                            </span>
                          </Td>
                          {COLS.map((c) => <Td key={c.key} className={clsx('text-right tabular-nums', !p[c.key] && 'text-slate-300', c.key === 'late' && p.late > 0 && 'font-medium text-amber-700', c.key === 'overdueOpen' && p.overdueOpen > 0 && 'font-medium text-rose-600')}>{p[c.key]}</Td>)}
                          <Td className="text-right tabular-nums">{pct(rate(p))}</Td>
                        </tr>
                        {isOpen && (
                          <tr><td colSpan={COLS.length + 2} className="border-b border-slate-100 bg-slate-50 px-6 py-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks {p.name.split(' ')[0]} completed in {monthName(r.month)}{p.avgDaysToComplete !== null && ` · ${p.avgDaysToComplete} days on average`}</p>
                            {!mine.length ? <p className="text-sm text-slate-500">None this month.</p> : <TaskList tasks={mine} />}
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </section>

        <section className={clsx(tab !== 'teams' && 'hidden print:block')}>
          <h3 className="mb-2 hidden text-base font-semibold print:block">By team</h3>
          <Card>
            {!r.teams.length ? <Empty title="No teams to report on" /> : (
              <Table>
                <thead><tr><Th>Team</Th>{COLS.map((c) => <Th key={c.key} className="text-right"><span title={c.tip}>{c.label}</span></Th>)}<Th className="text-right">On-time rate</Th></tr></thead>
                <tbody>
                  {r.teams.map((t) => (
                    <tr key={t.name}>
                      <Td><p className="font-medium text-slate-900">{t.name}</p><p className="max-w-64 text-xs text-slate-500">{t.members.length} {t.members.length === 1 ? 'person' : 'people'}: {t.members.join(', ')}</p></Td>
                      {COLS.map((c) => <Td key={c.key} className={clsx('text-right tabular-nums', !t[c.key] && 'text-slate-300')}>{t[c.key]}</Td>)}
                      <Td className="text-right tabular-nums">{pct(rate(t))}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <p className="mt-2 text-xs text-slate-500">A task shared by two people in the same team counts once for the team.</p>
        </section>

        <section className={clsx(tab !== 'tasks' && 'hidden print:block')}>
          <h3 className="mb-2 hidden text-base font-semibold print:block">Tasks completed</h3>
          <Card>
            {!r.tasks.length ? <Empty title={`No tasks completed in ${monthName(r.month)}`} /> : <div className="p-2"><TaskList tasks={r.tasks} showPeople /></div>}
          </Card>
        </section>
      </>}
    </div>
  );
}

function TaskList({ tasks, showPeople }: { tasks: TaskRow[]; showPeople?: boolean }) {
  return (
    <Table>
      <thead><tr><Th>Task</Th>{showPeople && <Th>Done by</Th>}<Th>Priority</Th><Th>Due</Th><Th>Completed</Th><Th>On time</Th></tr></thead>
      <tbody>
        {tasks.map((t) => (
          <tr key={t.taskId}>
            <Td><span className="font-mono text-xs text-slate-400">{t.key}</span> <span className="[overflow-wrap:anywhere]">{t.title}</span></Td>
            {showPeople && <Td className="text-sm">{t.people.join(', ')}{t.teams.length > 0 && <p className="text-xs text-slate-500">{t.teams.join(', ')}</p>}</Td>}
            <Td><Badge className={PRIORITY[t.priority]?.color}>{PRIORITY[t.priority]?.label ?? t.priority}</Badge></Td>
            <Td className="whitespace-nowrap">{t.dueAt ? format(new Date(t.dueAt), 'd MMM') : '—'}</Td>
            <Td className="whitespace-nowrap">{format(new Date(t.completedAt), 'd MMM, h:mm a')}</Td>
            <Td>{t.onTime ? <Badge className="bg-green-100 text-green-800">On time</Badge> : <Badge className="bg-amber-100 text-amber-800">Late</Badge>}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
