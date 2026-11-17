import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, ArchiveRestore, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td, Th } from '../../components/ui';
import { AccountingGate, dayLabel, monthLabel, rupees, todayIso } from './shared';

interface Cat {
  id: string; name: string; parentId: string | null; sortOrder: number; archived: boolean; monthlyBudget: number | null; annualBudget: number | null;
  spentMonth: number; spentYear: number; expenseCount: number;
}
interface Data { month: string; fiscalYear: { from: string; to: string }; uncategorized: { month: number; year: number }; categories: Cat[] }

export default function Categories() {
  return <AccountingGate><CategoriesPage /></AccountingGate>;
}

/** A parent's budget falls back to the sum of its subcategories' budgets. */
const budgetOf = (c: Cat, all: Cat[], kind: 'monthlyBudget' | 'annualBudget'): number | null => {
  if (c[kind] != null) return c[kind];
  const kids = all.filter((k) => k.parentId === c.id && !k.archived && k[kind] != null);
  return kids.length ? kids.reduce((s, k) => s + (k[kind] ?? 0), 0) : null;
};

const monthEnd = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };

function Usage({ spent, budget }: { spent: number; budget: number | null }) {
  if (!budget) return <span className="text-slate-400">No budget</span>;
  const pct = (spent / budget) * 100;
  return (
    <div className="min-w-[9rem]">
      <div className="flex justify-between text-xs"><span className="tabular-nums text-slate-700">{rupees(spent)}</span><span className={clsx('font-medium tabular-nums', pct >= 100 ? 'text-rose-600' : pct >= 80 ? 'text-amber-600' : 'text-slate-500')}>{pct.toFixed(0)}%</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={clsx('h-full rounded-full', pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <p className="mt-0.5 text-[11px] text-slate-500">of {rupees(budget)}</p>
    </div>
  );
}

function CategoriesPage() {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ cat?: Cat; parentId?: string | null } | null>(null);
  const q = useQuery({ queryKey: ['acct-categories', month], queryFn: () => api.get<Data>('/accounting/categories', { month }) });
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-categories'] }); qc.invalidateQueries({ queryKey: ['acct-lookups'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); };
  const all = q.data?.categories ?? [];
  const visible = all.filter((c) => showArchived || !c.archived);
  const top = visible.filter((c) => !c.parentId);
  // A parent's spend includes its subcategories.
  const spent = (c: Cat, k: 'spentMonth' | 'spentYear') => c[k] + all.filter((x) => x.parentId === c.id).reduce((s, x) => s + x[k], 0);
  const totals = top.filter((c) => !c.archived).reduce((a, c) => ({
    m: a.m + spent(c, 'spentMonth'), y: a.y + spent(c, 'spentYear'), mb: a.mb + (budgetOf(c, all, 'monthlyBudget') ?? 0), yb: a.yb + (budgetOf(c, all, 'annualBudget') ?? 0),
  }), { m: q.data?.uncategorized.month ?? 0, y: q.data?.uncategorized.year ?? 0, mb: 0, yb: 0 });

  const toggleArchive = async (c: Cat) => {
    try { await api.patch(`/accounting/categories/${c.id}`, { archived: !c.archived }); toast.success(c.archived ? 'Restored' : 'Archived. It no longer shows when adding expenses.'); refresh(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (c: Cat) => {
    if (!confirm(`Delete "${c.name}"?`)) return;
    try { await api.del(`/accounting/categories/${c.id}`); toast.success('Deleted'); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };

  const row = (c: Cat, child: boolean) => (
    <tr key={c.id} className={clsx('hover:bg-slate-50', c.archived && 'opacity-60')}>
      <Td className={clsx(child && 'pl-10')}>
        <span className={clsx(child ? 'text-slate-700' : 'font-semibold text-slate-900')}>{c.name}</span>
        {c.archived && <span className="ml-2 rounded bg-slate-100 px-1.5 text-[11px] text-slate-500">Archived</span>}
        <Link to={`/accounting/expenses?categoryId=${c.id}&from=${month}-01&to=${monthEnd(month)}&status=APPROVED,PAID`} className="ml-2 text-[11px] text-indigo-600 hover:underline">expenses</Link>
      </Td>
      <Td><Usage spent={child ? c.spentMonth : spent(c, 'spentMonth')} budget={child ? c.monthlyBudget ?? (c.annualBudget != null ? c.annualBudget / 12 : null) : budgetOf(c, all, 'monthlyBudget') ?? (c.annualBudget != null ? c.annualBudget / 12 : null)} /></Td>
      <Td><Usage spent={child ? c.spentYear : spent(c, 'spentYear')} budget={child ? c.annualBudget ?? (c.monthlyBudget != null ? c.monthlyBudget * 12 : null) : budgetOf(c, all, 'annualBudget') ?? (c.monthlyBudget != null ? c.monthlyBudget * 12 : null)} /></Td>
      <Td className="whitespace-nowrap text-right">
        {!child && !c.archived && <Button size="sm" variant="ghost" onClick={() => setEditing({ parentId: c.id })}><Plus className="h-3.5 w-3.5" />Sub</Button>}
        <Button size="sm" variant="ghost" onClick={() => setEditing({ cat: c })} aria-label={`Edit ${c.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant="ghost" onClick={() => toggleArchive(c)} aria-label={c.archived ? `Restore ${c.name}` : `Archive ${c.name}`} title={c.archived ? 'Restore' : 'Archive'}>{c.archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}</Button>
        {c.expenseCount === 0 && !all.some((x) => x.parentId === c.id) && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}><Trash2 className="h-3.5 w-3.5" /></Button>}
      </Td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Categories & Budgets" subtitle="Group expenses, set monthly or yearly budgets, and see how much of each is used. Counts approved and paid expenses."
        actions={<Button onClick={() => setEditing({ parentId: null })}><Plus className="h-4 w-4" />New category</Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Field label="Month" className="w-44"><Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <label className="mt-5 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show archived</label>
        {q.data && <p className="ml-auto mt-5 text-sm text-slate-500">Financial year {dayLabel(q.data.fiscalYear.from)} – {dayLabel(q.data.fiscalYear.to)}</p>}
      </div>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !top.length ? (
          <Empty title="No categories yet" icon={<Tags className="h-9 w-9" />}><Button className="mt-3" onClick={() => setEditing({ parentId: null })}><Plus className="h-4 w-4" />New category</Button></Empty>
        ) : (
          <Table>
            <thead><tr><Th>Category</Th><Th>{monthLabel(month, true)}</Th><Th>This financial year</Th><Th /></tr></thead>
            <tbody>
              {top.map((c) => <Fragment key={c.id}>{row(c, false)}{visible.filter((k) => k.parentId === c.id).map((k) => row(k, true))}</Fragment>)}
              {!!(q.data!.uncategorized.month || q.data!.uncategorized.year) && (
                <tr><Td className="italic text-slate-500">Uncategorized</Td><Td className="tabular-nums">{rupees(q.data!.uncategorized.month)}</Td><Td className="tabular-nums">{rupees(q.data!.uncategorized.year)}</Td><Td /></tr>
              )}
              <tr className="bg-slate-50 font-semibold">
                <Td>Total</Td><Td><Usage spent={totals.m} budget={totals.mb || null} /></Td><Td><Usage spent={totals.y} budget={totals.yb || null} /></Td><Td />
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <CategoryModal {...editing} parents={all.filter((c) => !c.parentId)} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function CategoryModal({ cat, parentId, parents, onClose, onSaved }: { cat?: Cat; parentId?: string | null; parents: Cat[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(cat?.name ?? '');
  const [monthly, setMonthly] = useState(cat?.monthlyBudget != null ? String(cat.monthlyBudget) : '');
  const [annual, setAnnual] = useState(cat?.annualBudget != null ? String(cat.annualBudget) : '');
  const [order, setOrder] = useState(String(cat?.sortOrder ?? 0));
  const [saving, setSaving] = useState(false);
  const parent = parents.find((p) => p.id === (cat?.parentId ?? parentId));
  const money = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100) / 100);
  const save = async () => {
    if (!name.trim()) { toast.error('Give it a name'); return; }
    const m = money(monthly), a = money(annual);
    if ((m != null && !(m >= 0)) || (a != null && !(a >= 0))) { toast.error('Budgets must be zero or more'); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), monthlyBudget: m, annualBudget: a, sortOrder: Number(order) || 0 };
      if (cat) await api.patch(`/accounting/categories/${cat.id}`, body);
      else await api.post('/accounting/categories', { ...body, parentId: parentId ?? null });
      toast.success(cat ? 'Saved' : 'Category added'); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={cat ? `Edit ${cat.name}` : parent ? `New subcategory of ${parent.name}` : 'New category'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}>Save</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Monthly budget (₹)" hint="Optional"><Input type="number" min={0} step="1" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
        <Field label="Yearly budget (₹)" hint="Optional"><Input type="number" min={0} step="1" value={annual} onChange={(e) => setAnnual(e.target.value)} /></Field>
      </div>
      <Field label="Order in lists" hint="Lower numbers come first."><Input type="number" min={0} value={order} onChange={(e) => setOrder(e.target.value)} className="w-28" /></Field>
      {!parent && <p className="text-xs text-slate-500">Without its own budget, a category uses the total of its subcategories' budgets. With only a yearly budget, the monthly figure is a twelfth of it.</p>}
    </Modal>
  );
}
