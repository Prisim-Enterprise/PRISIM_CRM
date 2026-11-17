import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Download, Receipt, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Select, Spinner, StatCard, Table, Td, Th } from '../../components/ui';
import {
  AccountingGate, ClientAnalysis, ClientDetailAnalysis, ClientRow, dayLabel, downloadCsv, Expense, INVOICE_STATUS, isoDay, monthLabel, MonthRow, pct,
  Preset, PRESETS, presetRange, PROJECT_STATUS, rupees, rupeesShort, useSettings,
} from './shared';
import { ExpenseModal, ExpenseTable } from './Expenses';

// Colours validated with the dataviz palette checker (CVD-safe; a table backs every chart).
const RECEIVED = '#4f46e5';
const SPENT = '#f97316';
const PROFIT = '#0ea5e9';
const GRID = '#e2e8f0';
const AXIS = { fontSize: 12, fill: '#64748b' };

type Period = Preset | 'all';
const PERIODS: Record<Period, string> = { ...PRESETS, all: 'All time' };

/** The period from ?period=, shared by the overview and the client pages. */
function usePeriod() {
  const [params, setParams] = useSearchParams();
  const fy = useSettings().data?.fyStartMonth ?? 4;
  const period = (params.get('period') as Period) in PERIODS ? (params.get('period') as Period) : 'fytd';
  const range = period === 'all'
    ? { from: '2015-01-01', to: isoDay(new Date()), label: 'All time' }
    : presetRange(period, fy).current;
  const setPeriod = (p: Period) => { const next = new URLSearchParams(params); next.set('period', p); setParams(next, { replace: true }); };
  return { period, range, setPeriod, qs: `?period=${period}` };
}

function PeriodSelect({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Period)} className="w-48" aria-label="Period">
      {(Object.keys(PERIODS) as Period[]).map((p) => <option key={p} value={p}>{PERIODS[p]}</option>)}
    </Select>
  );
}

const money = (v: unknown) => rupees(Number(v));

/** Received and spent per month as bars, profit as a line: all in rupees, so one axis. */
function MonthlyChart({ months }: { months: MonthRow[] }) {
  const data = months.map((m) => ({ month: monthLabel(m.month), Received: m.received, Spent: m.spent, Profit: m.profit }));
  if (!data.some((d) => d.Received || d.Spent)) return <p className="p-6 text-sm text-slate-500">Nothing received or spent in this period.</p>;
  return (
    <div className="h-72 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} barGap={2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => rupeesShort(Number(v))} width={64} />
          <Tooltip formatter={money} cursor={{ fill: '#f1f5f9' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Received" fill={RECEIVED} radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="Spent" fill={SPENT} radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Line dataKey="Profit" stroke={PROFIT} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 5 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ───────────────────────── Overview ─────────────────────────

export default function ClientAnalysisPage() {
  return <AccountingGate><Overview /></AccountingGate>;
}

type SortKey = 'name' | 'received' | 'invoiced' | 'spent' | 'profit' | 'margin' | 'outstanding' | 'overdue' | 'projects';
const COLS: [SortKey, string][] = [
  ['projects', 'Projects'], ['received', 'Received'], ['invoiced', 'Invoiced'], ['spent', 'Spent'], ['profit', 'Profit'], ['margin', 'Margin'],
  ['outstanding', 'Outstanding'], ['overdue', 'Overdue'],
];

function Overview() {
  const { period, range, setPeriod, qs } = usePeriod();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'received', desc: true });
  const q = useQuery({
    queryKey: ['acct-analysis', 'clients', range.from, range.to],
    queryFn: () => api.get<ClientAnalysis>('/accounting/analysis/clients', { from: range.from, to: range.to }),
  });
  const a = q.data;
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (a?.clients ?? []).filter((c) => !s || c.name.toLowerCase().includes(s));
    const val = (c: ClientRow) => (sort.key === 'name' ? c.name.toLowerCase() : sort.key === 'margin' ? c.margin ?? -Infinity : c[sort.key]);
    return [...list].sort((x, y) => { const p = val(x), r = val(y); const c = p < r ? -1 : p > r ? 1 : 0; return sort.desc ? -c : c; });
  }, [a, search, sort]);
  const top = useMemo(() => (a?.clients ?? []).filter((c) => c.received || c.spent).slice(0, 8)
    .map((c) => ({ name: c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name, Received: c.received, Spent: c.spent })), [a]);

  const exportCsv = () => a && downloadCsv(`prisim-client-analysis-${range.from}-to-${range.to}.csv`, [
    ['Client', 'Projects', 'Active projects', 'Received', 'Invoiced', 'Spent', 'Profit', 'Margin %', 'Outstanding', 'Overdue', 'Last payment'],
    ...rows.map((c) => [c.name, c.projects, c.activeProjects, c.received, c.invoiced, c.spent, c.profit, c.margin === null ? '' : Math.round(c.margin * 100), c.outstanding, c.overdue, c.lastPayment ?? '']),
    ['Overhead (not tied to a client)', '', '', '', '', a.totals.overhead, -a.totals.overhead, '', '', '', ''],
  ]);
  const head = (key: SortKey, label: string, right = true) => (
    <Th className={right ? 'text-right' : undefined}>
      <button className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
        {label}{sort.key === key && <span aria-hidden>{sort.desc ? '↓' : '↑'}</span>}
      </button>
    </Th>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Client analysis" subtitle={`Money in and out for each client, and for the business overall · ${range.label}`}
        actions={<>
          <PeriodSelect value={period} onChange={setPeriod} />
          <Button variant="secondary" onClick={exportCsv} disabled={!a}><Download className="h-4 w-4" />Export CSV</Button>
        </>} />
      {q.isLoading ? <Spinner /> : q.error || !a ? <ErrorBox error={q.error ?? new Error('Could not load the analysis')} /> : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Received" value={rupees(a.totals.received)} tone="good" sub={`Invoiced ${rupees(a.totals.invoiced)}`} />
          <StatCard label="Spent" value={rupees(a.totals.spent)} sub={`${rupees(a.totals.clientSpent)} on clients · ${rupees(a.totals.overhead)} overhead`} />
          <StatCard label="Net profit" value={rupees(a.totals.netProfit)} tone={a.totals.netProfit < 0 ? 'bad' : 'good'}
            sub={`Gross ${rupees(a.totals.grossProfit)} · margin ${pct(a.totals.grossMargin)}`} />
          <StatCard label="Outstanding now" value={rupees(a.totals.outstanding)} tone={a.totals.overdue ? 'bad' : a.totals.outstanding ? 'warn' : 'default'}
            sub={a.totals.overdue ? `${rupees(a.totals.overdue)} overdue` : 'Nothing overdue'} onClick={() => nav('/accounting/invoices')} />
          <StatCard label="Paying clients" value={a.totals.payingClients} sub={`${a.totals.clientsWithWork} with projects or money`} />
          <StatCard label="Biggest client" value={a.totals.topClient?.name ?? '—'} sub={a.totals.topClient ? `${pct(a.totals.topClient.share)} of money received` : 'Nothing received'} />
          <StatCard label="Average per paying client" value={a.totals.payingClients ? rupees(Math.round(a.totals.received / a.totals.payingClients)) : '—'} />
          <StatCard label="Overhead" value={rupees(a.totals.overhead)} sub="Costs not tied to a client" onClick={() => nav('/accounting/expenses?clientId=none')} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Month by month (all clients + overhead)"><MonthlyChart months={a.months} /></Card>
          <Card title="Top clients: received vs spent">
            {!top.length ? <p className="p-6 text-sm text-slate-500">No client money in this period.</p> : (
              <div className="p-3" style={{ height: Math.max(220, top.length * 44 + 60) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={top} layout="vertical" barGap={2} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => rupeesShort(Number(v))} />
                    <YAxis type="category" dataKey="name" tick={AXIS} axisLine={false} tickLine={false} width={140} />
                    <Tooltip formatter={money} cursor={{ fill: '#f1f5f9' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Received" fill={RECEIVED} radius={[0, 4, 4, 0]} maxBarSize={14} />
                    <Bar dataKey="Spent" fill={SPENT} radius={[0, 4, 4, 0]} maxBarSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>

        <Card title={`Clients (${rows.length})`} actions={<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" className="w-56" aria-label="Search clients" />}>
          {!rows.length ? <Empty title={search ? 'No clients match' : 'No client activity in this period'} icon={<Users className="h-9 w-9" />} /> : (
            <Table>
              <thead><tr>{head('name', 'Client', false)}{COLS.map(([k, l]) => head(k, l))}<Th>Last payment</Th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.clientId ?? 'unlinked'} className={clsx(c.clientId && 'cursor-pointer hover:bg-slate-50')} onClick={() => c.clientId && nav(`/accounting/client-analysis/${c.clientId}${qs}`)}>
                    <Td><span className={clsx('font-medium', c.clientId ? 'text-slate-900' : 'italic text-slate-500')}>{c.name}</span>
                      {c.status && c.status !== 'ACTIVE' && <Badge className="ml-2 bg-slate-100 text-slate-600">{c.status.toLowerCase()}</Badge>}</Td>
                    <Td className="text-right tabular-nums text-slate-600">{c.projects ? `${c.activeProjects}/${c.projects}` : '—'}</Td>
                    <Td className="text-right font-medium tabular-nums">{rupees(c.received)}</Td>
                    <Td className="text-right tabular-nums text-slate-600">{rupees(c.invoiced)}</Td>
                    <Td className="text-right tabular-nums text-slate-600">{rupees(c.spent)}</Td>
                    <Td className={clsx('text-right font-medium tabular-nums', c.profit < 0 ? 'text-rose-600' : 'text-emerald-700')}>{rupees(c.profit)}</Td>
                    <Td className="text-right tabular-nums text-slate-600">{pct(c.margin)}</Td>
                    <Td className={clsx('text-right tabular-nums', c.outstanding > 0 && 'text-amber-700')}>{rupees(c.outstanding)}</Td>
                    <Td className={clsx('text-right tabular-nums', c.overdue > 0 && 'font-medium text-rose-600')}>{rupees(c.overdue)}</Td>
                    <Td className="whitespace-nowrap text-slate-600">{c.lastPayment ? dayLabel(c.lastPayment) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            Received, invoiced and spent are for {range.label.toLowerCase()}; outstanding and overdue are as of today. Projects shows active / total.
            Profit = received − approved and paid expenses for that client. Overhead ({rupees(a.totals.overhead)}) is counted once, in net profit.
          </p>
        </Card>
      </>}
    </div>
  );
}

// ───────────────────────── One client ─────────────────────────

export function ClientAnalysisDetailPage() {
  return <AccountingGate><Detail /></AccountingGate>;
}

function Detail() {
  const { id } = useParams();
  const { period, range, setPeriod, qs } = usePeriod();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [expense, setExpense] = useState<Expense | null>(null);
  const q = useQuery({
    queryKey: ['acct-analysis', 'client', id, range.from, range.to],
    queryFn: () => api.get<ClientDetailAnalysis>(`/accounting/analysis/clients/${id}`, { from: range.from, to: range.to }),
  });
  const refresh = () => { ['acct-analysis', 'acct-expenses', 'acct-projects', 'acct-ledger'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Client not found')} />;
  const d = q.data;
  const s = d.summary;
  const catMax = Math.max(1, ...d.categories.map((c) => c.amount));

  return (
    <div className="space-y-4">
      <Link to={`/accounting/client-analysis${qs}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Client analysis</Link>
      <PageHeader title={d.client.name}
        subtitle={<>{[d.client.contactName, d.client.phone, d.client.email].filter(Boolean).join(' · ') || 'No contact details'} · <Link to={`/clients/${d.client.id}`} className="text-indigo-600 hover:underline">Open in Clients</Link></>}
        actions={<>
          <PeriodSelect value={period} onChange={setPeriod} />
          <Button onClick={() => setAdding(true)}><Receipt className="h-4 w-4" />Add expense</Button>
        </>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label={`Received · ${range.label}`} value={rupees(s?.received ?? 0)} tone="good" sub={s?.lastPayment ? `Last on ${dayLabel(s.lastPayment)}` : 'No payments in this period'} />
        <StatCard label="Invoiced" value={rupees(s?.invoiced ?? 0)} sub={`${s?.invoices ?? 0} invoice${s?.invoices === 1 ? '' : 's'}`} />
        <StatCard label="Spent" value={rupees(s?.spent ?? 0)} sub="Approved & paid expenses" />
        <StatCard label="Profit" value={rupees(s?.profit ?? 0)} tone={(s?.profit ?? 0) < 0 ? 'bad' : 'good'} sub={`Margin ${pct(s?.margin ?? null)}`} />
        <StatCard label="Outstanding now" value={rupees(s?.outstanding ?? 0)} tone={s?.overdue ? 'bad' : s?.outstanding ? 'warn' : 'default'} sub={s?.overdue ? `${rupees(s.overdue)} overdue` : 'Nothing overdue'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Month by month" className="lg:col-span-2"><MonthlyChart months={d.months} /></Card>
        <Card title="Spent by category">
          {!d.categories.length ? <p className="p-4 text-sm text-slate-500">No expenses for this client in this period.</p> : (
            <ul className="space-y-2.5 p-4">
              {d.categories.map((c) => (
                <li key={c.name} className="text-sm">
                  <div className="flex justify-between gap-2"><span className="truncate text-slate-700">{c.name}</span><span className="tabular-nums text-slate-900">{rupees(c.amount)}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full" style={{ width: `${(c.amount / catMax) * 100}%`, background: SPENT }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`Projects (${d.projects.length})`} actions={<Link to="/accounting/projects" className="text-sm text-indigo-600 hover:underline">All projects</Link>}>
        {!d.projects.length ? <p className="p-4 text-sm text-slate-500">No projects for this client.</p> : (
          <Table>
            <thead><tr><Th>Project</Th><Th>Status</Th><Th className="text-right">Quoted</Th><Th className="text-right">Received</Th><Th className="text-right">Balance</Th><Th className="text-right">Spent</Th><Th className="text-right">Profit</Th></tr></thead>
            <tbody>{d.projects.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <Td><Link to={`/accounting/projects/${p.id}`} className="font-medium text-indigo-700 hover:underline">{p.title}</Link></Td>
                <Td><Badge className={PROJECT_STATUS[p.status].color}>{PROJECT_STATUS[p.status].label}</Badge></Td>
                <Td className="text-right tabular-nums">{p.quotedAmount != null ? rupees(p.quotedAmount) : '—'}</Td>
                <Td className="text-right tabular-nums">{rupees(p.received)}</Td>
                <Td className={clsx('text-right tabular-nums', p.balance > 0 && 'text-amber-700')}>{rupees(p.balance)}</Td>
                <Td className="text-right tabular-nums text-slate-600">{rupees(p.spent)}</Td>
                <Td className={clsx('text-right font-medium tabular-nums', p.profit < 0 ? 'text-rose-600' : 'text-emerald-700')}>{rupees(p.profit)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Project figures are for the whole project, not just this period.</p>
      </Card>

      <Card title={`Invoices (${d.invoices.length})`}>
        {!d.invoices.length ? <p className="p-4 text-sm text-slate-500">No invoices for this client.</p> : (
          <Table>
            <thead><tr><Th>Number</Th><Th>Date</Th><Th>Due</Th><Th className="text-right">Total</Th><Th className="text-right">Balance</Th><Th>Status</Th></tr></thead>
            <tbody>{d.invoices.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <Td><Link to={`/accounting/invoices/${i.id}`} className="font-mono font-medium text-indigo-700 hover:underline">{i.number}</Link></Td>
                <Td>{dayLabel(i.date)}</Td><Td>{dayLabel(i.dueDate)}</Td>
                <Td className="text-right tabular-nums">{rupees(i.total)}</Td><Td className="text-right tabular-nums">{rupees(i.balance)}</Td>
                <Td><Badge className={INVOICE_STATUS[i.status].color}>{INVOICE_STATUS[i.status].label}</Badge></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card title={`Expenses · ${range.label} (${d.expenses.length})`} actions={<div className="flex items-center gap-3">
        <Link to={`/accounting/expenses?clientId=${d.client.id}`} className="text-sm text-indigo-600 hover:underline">Open in Expenses</Link>
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Add expense</Button>
      </div>}>
        {!d.expenses.length ? <p className="p-4 text-sm text-slate-500">No expenses for this client in this period.</p>
          : <ExpenseTable items={d.expenses} manager onOpen={setExpense} />}
      </Card>

      {adding && <ExpenseModal expense={null} defaults={{ clientId: d.client.id }} onClose={() => setAdding(false)} onSaved={refresh} />}
      {expense && <ExpenseModal expense={expense} onClose={() => setExpense(null)} onSaved={refresh} />}
    </div>
  );
}
