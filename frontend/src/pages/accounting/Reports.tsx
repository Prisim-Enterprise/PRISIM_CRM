import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Download } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatCard, Table, Td, Th } from '../../components/ui';
import {
  AccountingGate, dayLabel, downloadCsv, isoDay, Ledger, METHODS, monthKey, monthLabel, pctChange, Preset, PRESETS, presetRange, rupees, useSettings,
} from './shared';

type GroupBy = 'category' | 'subcategory' | 'vendor' | 'method' | 'person' | 'project' | 'month';
const GROUPS: Record<GroupBy, string> = {
  category: 'Category', subcategory: 'Subcategory', vendor: 'Vendor / payee', method: 'Payment method', person: 'Submitted by', project: 'Client project', month: 'Month',
};
type Compare = 'previous' | 'last_year' | 'none';
type IncomeBy = 'client' | 'month' | 'method';

export default function AccountingReports() {
  return <AccountingGate><ReportsPage /></AccountingGate>;
}

const shiftYear = (s: string, n: number) => { const [y, m, d] = s.split('-').map(Number); return isoDay(new Date(y + n, m - 1, Math.min(d, new Date(y + n, m, 0).getDate()))); };
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86400000);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return isoDay(d); };

function ReportsPage() {
  const settings = useSettings();
  const fy = settings.data?.fyStartMonth ?? 4;
  const initial = presetRange('fytd', fy).current;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [groupBy, setGroupBy] = useState<GroupBy>('category');
  const [compare, setCompare] = useState<Compare>('previous');
  const [withPending, setWithPending] = useState(false);
  const [incomeBy, setIncomeBy] = useState<IncomeBy>('client');
  const valid = !!from && !!to && from <= to;

  const prevRange = useMemo(() => {
    if (!valid || compare === 'none') return null;
    if (compare === 'last_year') return { from: shiftYear(from, -1), to: shiftYear(to, -1), label: 'same period last year' };
    const len = daysBetween(from, to);
    const pTo = addDays(from, -1);
    return { from: addDays(pTo, -len), to: pTo, label: 'the period before' };
  }, [from, to, compare, valid]);
  const qFrom = prevRange && prevRange.from < from ? prevRange.from : from;
  const q = useQuery({ queryKey: ['acct-ledger', qFrom, to], queryFn: () => api.get<Ledger>('/accounting/ledger', { from: qFrom, to }), enabled: valid });

  const report = useMemo(() => {
    const data = q.data;
    if (!data) return null;
    const cats = new Map(data.categories.map((c) => [c.id, c]));
    const ok = (s: string) => s === 'APPROVED' || s === 'PAID' || (withPending && s === 'PENDING');
    const inR = (d: string, a: string, b: string) => d >= a && d <= b;
    const keyOf = (e: Ledger['expenses'][number]): [string, string] => {
      switch (groupBy) {
        case 'category': return [e.topCategoryId ?? '-', e.topCategoryId ? cats.get(e.topCategoryId)?.name ?? '—' : 'Uncategorized'];
        case 'subcategory': {
          if (!e.categoryId) return ['-', 'Uncategorized'];
          const c = cats.get(e.categoryId);
          const p = c?.parentId ? cats.get(c.parentId) : null;
          return [e.categoryId, p ? `${p.name} › ${c!.name}` : `${c?.name ?? '—'} (general)`];
        }
        case 'vendor': return [e.vendorId ?? '-', e.vendorName ?? 'No vendor'];
        case 'method': return [e.method, METHODS[e.method]];
        case 'person': return [e.submitterId, e.submitterName];
        case 'project': return [e.projectId ?? '-', e.projectLabel ?? 'Not linked to a project'];
        case 'month': return [monthKey(e.date), monthLabel(monthKey(e.date), true)];
      }
    };
    const rows = new Map<string, { label: string; amount: number; count: number; prev: number }>();
    const exp = data.expenses.filter((e) => ok(e.status));
    for (const e of exp) {
      const cur = inR(e.date, from, to);
      const prev = !!prevRange && inR(e.date, prevRange.from, prevRange.to);
      if (!cur && !prev) continue;
      // Months are compared by position, so "Month" only lists months in the chosen range.
      if (groupBy === 'month' && !cur) continue;
      const [k, label] = keyOf(e);
      const r = rows.get(k) ?? { label, amount: 0, count: 0, prev: 0 };
      if (cur) { r.amount += e.amount; r.count += 1; }
      if (prev) r.prev += e.amount;
      rows.set(k, r);
    }
    const list = [...rows.entries()].map(([key, r]) => ({ key, ...r })).sort((a, b) => (groupBy === 'month' ? a.key.localeCompare(b.key) : b.amount - a.amount || b.prev - a.prev));
    const total = list.reduce((a, r) => a + r.amount, 0);
    const prevTotal = prevRange ? exp.filter((e) => inR(e.date, prevRange.from, prevRange.to)).reduce((a, e) => a + e.amount, 0) : 0;

    const inc = data.income.filter((i) => inR(i.date, from, to));
    const incRows = new Map<string, { label: string; amount: number; count: number }>();
    for (const i of inc) {
      const [k, label] = incomeBy === 'client' ? [i.clientId ?? i.clientName, i.clientName] : incomeBy === 'month' ? [monthKey(i.date), monthLabel(monthKey(i.date), true)] : [i.method, METHODS[i.method]];
      const r = incRows.get(k) ?? { label, amount: 0, count: 0 };
      r.amount += i.amount; r.count += 1;
      incRows.set(k, r);
    }
    const incList = [...incRows.entries()].map(([key, r]) => ({ key, ...r })).sort((a, b) => (incomeBy === 'month' ? a.key.localeCompare(b.key) : b.amount - a.amount));
    const incTotal = inc.reduce((a, i) => a + i.amount, 0);
    const incPrev = prevRange ? data.income.filter((i) => inR(i.date, prevRange.from, prevRange.to)).reduce((a, i) => a + i.amount, 0) : 0;
    return { list, total, prevTotal, count: list.reduce((a, r) => a + r.count, 0), incList, incTotal, incPrev };
  }, [q.data, from, to, groupBy, withPending, prevRange, incomeBy]);

  const setPreset = (p: Preset) => { const r = presetRange(p, fy).current; setFrom(r.from); setTo(r.to); };
  const exportCsv = () => {
    if (!report) return;
    downloadCsv(`prisim-spend-by-${groupBy}-${from}-to-${to}.csv`, [
      [GROUPS[groupBy], 'Amount (INR)', 'Expenses', 'Share %', ...(prevRange ? [`Amount ${prevRange.from} to ${prevRange.to}`, 'Change %'] : [])],
      ...report.list.map((r) => [r.label, r.amount.toFixed(2), r.count, report.total ? ((r.amount / report.total) * 100).toFixed(1) : '0',
        ...(prevRange ? [r.prev.toFixed(2), pctChange(r.amount, r.prev)?.toFixed(1) ?? ''] : [])]),
      ['Total', report.total.toFixed(2), report.count, '100', ...(prevRange ? [report.prevTotal.toFixed(2), pctChange(report.total, report.prevTotal)?.toFixed(1) ?? ''] : [])],
      [],
      ['Money received', 'Amount (INR)', 'Payments'],
      ...report.incList.map((r) => [r.label, r.amount.toFixed(2), r.count]),
      ['Total received', report.incTotal.toFixed(2), report.incList.reduce((a, r) => a + r.count, 0)],
    ]);
  };
  const change = (cur: number, prev: number) => {
    const p = pctChange(cur, prev);
    if (p === null) return <span className="text-slate-400">—</span>;
    return <span className={clsx('tabular-nums', p > 0.5 ? 'text-rose-600' : p < -0.5 ? 'text-emerald-600' : 'text-slate-500')}>{p > 0 ? '+' : ''}{p.toFixed(0)}%</span>;
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Accounting reports" subtitle="Spending and money received for any dates, broken down and compared."
        actions={<Button variant="secondary" onClick={exportCsv} disabled={!report}><Download className="h-4 w-4" />Export CSV</Button>} />
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Quick pick" className="w-48">
            <Select defaultValue="fytd" onChange={(e) => setPreset(e.target.value as Preset)}>
              {(Object.keys(PRESETS) as Preset[]).map((p) => <option key={p} value={p}>{PRESETS[p]}</option>)}
            </Select>
          </Field>
          <Field label="From" className="w-40"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To" className="w-40"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Break down by" className="w-44">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>{(Object.keys(GROUPS) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUPS[g]}</option>)}</Select>
          </Field>
          <Field label="Compare with" className="w-48">
            <Select value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
              <option value="previous">The period before</option><option value="last_year">Same period last year</option><option value="none">No comparison</option>
            </Select>
          </Field>
          <Field label="Expenses" className="w-44">
            <Select value={withPending ? 'all' : 'settled'} onChange={(e) => setWithPending(e.target.value === 'all')}>
              <option value="settled">Approved & paid</option><option value="all">Include pending</option>
            </Select>
          </Field>
        </div>
      </Card>

      {!valid ? <ErrorBox error={new Error('Pick a start date on or before the end date.')} /> : q.isLoading || !report ? (q.error ? <ErrorBox error={q.error} /> : <Spinner />) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Spent" value={rupees(report.total)} sub={prevRange ? <>{change(report.total, report.prevTotal)} vs {prevRange.label}</> : `${dayLabel(from)} – ${dayLabel(to)}`} />
            <StatCard label="Received" value={rupees(report.incTotal)} tone="good" sub={prevRange ? `${rupees(report.incPrev)} in ${prevRange.label}` : undefined} />
            <StatCard label="Net" value={rupees(report.incTotal - report.total)} tone={report.incTotal - report.total < 0 ? 'bad' : 'good'} />
            <StatCard label="Expenses counted" value={report.count} />
          </div>

          <Card title={`Spending by ${GROUPS[groupBy].toLowerCase()}`}>
            {!report.list.length ? <p className="p-6 text-center text-sm text-slate-500">No expenses in these dates.</p> : (
              <Table>
                <thead><tr>
                  <Th>{GROUPS[groupBy]}</Th><Th className="text-right">Amount</Th><Th className="text-right">Expenses</Th><Th className="w-48">Share</Th>
                  {prevRange && <><Th className="text-right">{prevRange.label}</Th><Th className="text-right">Change</Th></>}
                </tr></thead>
                <tbody>
                  {report.list.map((r) => {
                    const share = report.total ? (r.amount / report.total) * 100 : 0;
                    return (
                      <tr key={r.key} className="hover:bg-slate-50">
                        <Td className="font-medium text-slate-900">{r.label}</Td>
                        <Td className="text-right tabular-nums">{rupees(Math.round(r.amount * 100) / 100)}</Td>
                        <Td className="text-right tabular-nums text-slate-600">{r.count}</Td>
                        <Td><div className="flex items-center gap-2"><div className="h-1.5 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${share}%` }} /></div><span className="w-11 text-right text-xs tabular-nums text-slate-500">{share.toFixed(1)}%</span></div></Td>
                        {prevRange && <><Td className="text-right tabular-nums text-slate-600">{rupees(Math.round(r.prev * 100) / 100)}</Td><Td className="text-right">{change(r.amount, r.prev)}</Td></>}
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-50 font-semibold">
                    <Td>Total</Td><Td className="text-right tabular-nums">{rupees(Math.round(report.total * 100) / 100)}</Td><Td className="text-right tabular-nums">{report.count}</Td><Td />
                    {prevRange && <><Td className="text-right tabular-nums">{rupees(Math.round(report.prevTotal * 100) / 100)}</Td><Td className="text-right">{change(report.total, report.prevTotal)}</Td></>}
                  </tr>
                </tbody>
              </Table>
            )}
          </Card>

          <Card title="Money received" actions={
            <Select value={incomeBy} onChange={(e) => setIncomeBy(e.target.value as IncomeBy)} className="w-40" aria-label="Group money received by">
              <option value="client">By client</option><option value="month">By month</option><option value="method">By method</option>
            </Select>}>
            {!report.incList.length ? <p className="p-6 text-center text-sm text-slate-500">No payments recorded in these dates.</p> : (
              <Table>
                <thead><tr><Th>{incomeBy === 'client' ? 'Client' : incomeBy === 'month' ? 'Month' : 'Method'}</Th><Th className="text-right">Amount</Th><Th className="text-right">Payments</Th></tr></thead>
                <tbody>
                  {report.incList.map((r) => <tr key={r.key}><Td className="font-medium text-slate-900">{r.label}</Td><Td className="text-right tabular-nums">{rupees(r.amount)}</Td><Td className="text-right tabular-nums text-slate-600">{r.count}</Td></tr>)}
                  <tr className="bg-slate-50 font-semibold"><Td>Total</Td><Td className="text-right tabular-nums">{rupees(report.incTotal)}</Td><Td className="text-right tabular-nums">{report.incList.reduce((a, r) => a + r.count, 0)}</Td></tr>
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
