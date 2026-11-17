import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Plus } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../lib/api';
import { Button, Card, ErrorBox, PageHeader, Select, Spinner, StatCard } from '../../components/ui';
import {
  AccountingGate, CHART_COLORS, isoDay, lastMonths, Ledger, monthKey, monthLabel, monthlyBudget, OTHER_COLOR, pctChange, Preset, PRESETS, presetRange,
  rupees, rupeesShort, useSettings,
} from './shared';

export default function AccountingDashboard() {
  return <AccountingGate><DashboardPage /></AccountingGate>;
}

function Delta({ cur, prev, vs, goodWhenUp = false }: { cur: number; prev: number; vs: string; goodWhenUp?: boolean }) {
  const p = pctChange(cur, prev);
  if (p === null) return <span>Nothing in {vs}</span>;
  const up = p >= 0;
  const good = goodWhenUp ? up : !up;
  return (
    <span className="inline-flex items-center gap-1" title={`${rupees(prev)} in ${vs}`}>
      <span className={clsx('inline-flex items-center font-medium', Math.abs(p) < 0.5 ? 'text-slate-500' : good ? 'text-emerald-600' : 'text-rose-600')}>
        {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{Math.abs(p).toFixed(0)}%
      </span>
      vs {vs}
    </span>
  );
}

function DashboardPage() {
  const settings = useSettings();
  const fy = settings.data?.fyStartMonth ?? 4;
  const [preset, setPreset] = useState<Preset>('this_month');
  const [categoryId, setCategoryId] = useState('');
  const [withPending, setWithPending] = useState(false);
  const nav = useNavigate();
  // Two years back covers every preset and its comparison period.
  const from = useMemo(() => { const d = new Date(); return isoDay(new Date(d.getFullYear() - 2, d.getMonth(), 1)); }, []);
  const to = isoDay(new Date());
  const q = useQuery({ queryKey: ['acct-ledger', from, to], queryFn: () => api.get<Ledger>('/accounting/ledger', { from, to }) });
  const { current, previous } = presetRange(preset, fy);
  const data = q.data;

  const view = useMemo(() => {
    if (!data) return null;
    const cats = data.categories;
    const byId = new Map(cats.map((c) => [c.id, c]));
    const statusOk = (s: string) => s === 'APPROVED' || s === 'PAID' || (withPending && s === 'PENDING');
    const txns = data.expenses.filter((e) => statusOk(e.status) && (!categoryId || e.topCategoryId === categoryId || e.categoryId === categoryId));
    const inR = (d: string, r: { from: string; to: string }) => d >= r.from && d <= r.to;
    const cur = txns.filter((e) => inR(e.date, current));
    const prev = txns.filter((e) => inR(e.date, previous));
    const sum = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);
    const incCur = data.income.filter((i) => inR(i.date, current));
    const incPrev = data.income.filter((i) => inR(i.date, previous));

    const months = lastMonths(12);
    const trend = months.map((m) => ({
      month: monthLabel(m),
      Spent: Math.round(sum(txns.filter((e) => monthKey(e.date) === m))),
      Received: Math.round(sum(data.income.filter((i) => monthKey(i.date) === m))),
    }));

    // Spend by category: top level, or the chosen category's subcategories.
    const groups = new Map<string, number>();
    for (const e of cur) {
      const k = (categoryId ? e.categoryId : e.topCategoryId) ?? '__none';
      groups.set(k, (groups.get(k) ?? 0) + e.amount);
    }
    const topOrder = cats.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((c) => c.id);
    const colorOf = (id: string) => { const i = categoryId ? cats.filter((c) => c.parentId === categoryId).findIndex((c) => c.id === id) : topOrder.indexOf(id); return i >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : OTHER_COLOR; };
    let slices = [...groups.entries()].map(([id, value]) => ({
      id, value, name: id === '__none' ? 'Uncategorized' : id === categoryId ? `${byId.get(id)?.name} (direct)` : byId.get(id)?.name ?? '—', color: id === '__none' || id === categoryId ? OTHER_COLOR : colorOf(id),
    })).sort((a, b) => b.value - a.value);
    if (slices.length > 7) slices = [...slices.slice(0, 6), { id: '__other', name: `Other (${slices.length - 6})`, value: sum(slices.slice(6).map((s) => ({ amount: s.value }))), color: OTHER_COLOR }];

    // Budget vs actual for this month.
    const thisMonth = isoDay(new Date()).slice(0, 7);
    const monthTx = txns.filter((e) => monthKey(e.date) === thisMonth);
    const budgetRows = (categoryId ? cats.filter((c) => c.parentId === categoryId) : cats.filter((c) => !c.parentId)).filter((c) => !c.archived).map((c) => ({
      name: c.name,
      Budget: Math.round(monthlyBudget(c.id, cats)),
      Actual: Math.round(sum(monthTx.filter((e) => (categoryId ? e.categoryId === c.id : e.topCategoryId === c.id)))),
    })).filter((r) => r.Budget || r.Actual).sort((a, b) => b.Budget - a.Budget || b.Actual - a.Actual);
    const budgetTotal = categoryId ? monthlyBudget(categoryId, cats) : cats.filter((c) => !c.parentId && !c.archived).reduce((a, c) => a + monthlyBudget(c.id, cats), 0);

    const vendors = new Map<string, { name: string; value: number }>();
    for (const e of cur) if (e.vendorId) vendors.set(e.vendorId, { name: e.vendorName ?? '—', value: (vendors.get(e.vendorId)?.value ?? 0) + e.amount });
    const topVendors = [...vendors.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.value - a.value).slice(0, 6);

    const pending = data.expenses.filter((e) => e.status === 'PENDING');
    return {
      curTotal: sum(cur), prevTotal: sum(prev), count: cur.length, incCur: sum(incCur), incPrev: sum(incPrev), trend, slices, budgetRows,
      budgetTotal, monthSpend: sum(monthTx), topVendors, pending: { count: pending.length, amount: sum(pending) },
    };
  }, [data, categoryId, withPending, current.from, current.to, previous.from, previous.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const drill = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ from: current.from, to: current.to, status: withPending ? 'PENDING,APPROVED,PAID' : 'APPROVED,PAID', ...extra });
    if (categoryId && !extra.categoryId) p.set('categoryId', categoryId);
    nav(`/accounting/expenses?${p}`);
  };
  const tops = (data?.categories ?? []).filter((c) => !c.parentId && !c.archived).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const usedPct = view && view.budgetTotal ? (view.monthSpend / view.budgetTotal) * 100 : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Accounting" subtitle="Where the money goes and what has come in."
        actions={<>
          <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="w-48" aria-label="Period">
            {(Object.keys(PRESETS) as Preset[]).map((p) => <option key={p} value={p}>{PRESETS[p]}</option>)}
          </Select>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-48" aria-label="Category">
            <option value="">All categories</option>
            {tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={withPending ? 'all' : 'settled'} onChange={(e) => setWithPending(e.target.value === 'all')} className="w-48" aria-label="Which expenses">
            <option value="settled">Approved & paid</option><option value="all">Include pending</option>
          </Select>
          <Link to="/accounting/expenses?new=1"><Button><Plus className="h-4 w-4" />Add expense</Button></Link>
        </>} />

      {q.isLoading || !view ? (q.error ? <ErrorBox error={q.error} /> : <Spinner />) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard label={`Spent · ${current.label}`} value={rupees(view.curTotal)} sub={<Delta cur={view.curTotal} prev={view.prevTotal} vs={previous.label} />} onClick={() => drill({})} />
            <StatCard label={`Received · ${current.label}`} value={rupees(view.incCur)} tone="good" sub={<Delta cur={view.incCur} prev={view.incPrev} vs={previous.label} goodWhenUp />} />
            <StatCard label="Net (received − spent)" value={rupees(view.incCur - view.curTotal)} tone={view.incCur - view.curTotal < 0 ? 'bad' : 'good'} sub={current.label} />
            <StatCard label="Transactions" value={view.count} sub={view.count ? `Average ${rupees(Math.round(view.curTotal / view.count))}` : current.label} onClick={() => drill({})} />
            <StatCard label={`Budget used · ${monthLabel(isoDay(new Date()).slice(0, 7), true)}`} value={usedPct === null ? 'No budget' : `${usedPct.toFixed(0)}%`}
              tone={usedPct === null ? 'default' : usedPct >= 100 ? 'bad' : usedPct >= 80 ? 'warn' : 'good'}
              sub={view.budgetTotal ? `${rupees(view.monthSpend)} of ${rupees(Math.round(view.budgetTotal))}` : <Link to="/accounting/categories" className="text-indigo-600 hover:underline">Set budgets</Link>} />
            <StatCard label="Waiting for approval" value={view.pending.count} tone={view.pending.count ? 'warn' : 'default'} sub={view.pending.count ? rupees(view.pending.amount) : 'All clear'} onClick={() => nav('/accounting/approvals')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard label="Invoices outstanding" value={rupees(data!.invoices.outstanding)} tone={data!.invoices.outstanding ? 'warn' : 'default'} sub={`Across ${data!.invoices.count} invoice${data!.invoices.count === 1 ? '' : 's'}`} onClick={() => nav('/accounting/invoices')} />
            <StatCard label="Overdue invoices" value={rupees(data!.invoices.overdue)} tone={data!.invoices.overdue ? 'bad' : 'default'} sub={`${data!.invoices.overdueCount} past the due date`} onClick={() => nav('/accounting/invoices')} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Spent vs received" className="lg:col-span-2">
              <p className="px-4 pt-2 text-xs text-slate-500">Last 12 months, by month</p>
              <div className="h-72 p-2">
                <ResponsiveContainer>
                  <BarChart data={view.trend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eaeaea" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={rupeesShort} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(v) => rupees(Number(v))} cursor={{ fill: '#f1f5f9' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Spent" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Received" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title={categoryId ? `${tops.find((c) => c.id === categoryId)?.name} breakdown` : 'Spend by category'}>
              <p className="px-4 pt-2 text-xs text-slate-500">{current.label} · click a slice to see the expenses</p>
              {!view.slices.length ? <p className="p-6 text-center text-sm text-slate-500">No spending in this period.</p> : (
                <>
                  <div className="h-48">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={view.slices} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={1}
                          onClick={(s) => { const id = ((s.payload ?? s) as { id?: string }).id; if (id && id !== '__other') drill({ categoryId: id === '__none' ? 'none' : id }); }} className="cursor-pointer">
                          {view.slices.map((s) => <Cell key={s.id} fill={s.color} />)}
                        </Pie>
                        <Tooltip formatter={(v) => `${rupees(Number(v))} · ${((Number(v) / view.curTotal) * 100).toFixed(1)}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="space-y-1 px-4 pb-4 text-sm">
                    {view.slices.map((s) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="flex-1 truncate text-slate-700">{s.name}</span>
                        <span className="tabular-nums text-slate-900">{rupees(Math.round(s.value))}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Budget vs actual" className="lg:col-span-2">
              <p className="px-4 pt-2 text-xs text-slate-500">{monthLabel(isoDay(new Date()).slice(0, 7), true)}{categoryId ? ' · subcategories' : ' · by category'}</p>
              {!view.budgetRows.length ? <p className="p-6 text-center text-sm text-slate-500">No budgets set and nothing spent this month. <Link to="/accounting/categories" className="text-indigo-600 hover:underline">Set budgets</Link></p> : (
                <div className="p-2" style={{ height: Math.max(180, view.budgetRows.length * 38 + 50) }}>
                  <ResponsiveContainer>
                    <BarChart data={view.budgetRows} layout="vertical" margin={{ left: 10, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eaeaea" horizontal={false} />
                      <XAxis type="number" tickFormatter={rupeesShort} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => rupees(Number(v))} cursor={{ fill: '#f1f5f9' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Budget" fill="#cbd5e1" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="Actual" radius={[0, 4, 4, 0]}>
                        {view.budgetRows.map((r) => <Cell key={r.name} fill={r.Budget && r.Actual > r.Budget ? '#e11d48' : r.Budget && r.Actual >= r.Budget * 0.8 ? '#f59e0b' : '#4f46e5'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
            <Card title="Top vendors">
              <p className="px-4 pt-2 text-xs text-slate-500">{current.label}</p>
              {!view.topVendors.length ? <p className="p-6 text-center text-sm text-slate-500">No vendor spending in this period.</p> : (
                <ul className="space-y-2.5 p-4">
                  {view.topVendors.map((v) => (
                    <li key={v.id}>
                      <button className="w-full text-left" onClick={() => drill({ vendorId: v.id })}>
                        <div className="flex justify-between text-sm"><span className="truncate text-slate-800">{v.name}</span><span className="tabular-nums text-slate-900">{rupees(Math.round(v.value))}</span></div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${(v.value / view.topVendors[0].value) * 100}%` }} /></div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
