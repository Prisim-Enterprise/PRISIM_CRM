import { ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import {
  ArrowLeft, Banknote, CheckCircle2, Download, FileText, Lock, Pencil, Plus, Printer, RefreshCw, RotateCcw, Save, Trash2, Undo2, UserPlus, Users, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Table, Tabs, Td, Textarea, Th } from '../../components/ui';
import { METHODS, PaymentMethod, rupees, todayIso } from './shared';
import { LineItem, PayCalc, PayslipPrint, PayslipSheet, PayslipSnapshot, PrintablePayslip, printPayslips } from './PayslipSheet';

// ───────────────────────── Types ─────────────────────────

type RunStatus = 'DRAFT' | 'FINALISED' | 'PAID';
interface Component { name: string; amount: number; pf?: boolean }
interface Employee {
  id: string; userId: string | null; code: string; fullName: string; email: string | null; phone: string | null; designation: string | null;
  department: string | null; location: string | null; dateOfJoining: string; dateOfLeaving: string | null; pan: string | null; uan: string | null;
  pfNumber: string | null; esiNumber: string | null; bankName: string | null; accountNumber: string | null; ifsc: string | null; paymentMethod: PaymentMethod;
  components: Component[]; pfEnabled: boolean; pfCapped: boolean; esiEnabled: boolean; ptEnabled: boolean; monthlyTds: number; notes: string | null;
  active: boolean; user: { id: string; fullName: string; email: string } | null; payslipCount: number;
  monthly: { gross: number; net: number; employerCost: number; annualCtc: number };
}
interface Totals {
  employees: number; gross: number; deductions: number; net: number; employerCost: number; pfEmployee: number; pfEmployer: number; eps: number; epf: number;
  edli: number; pfAdmin: number; esiEmployee: number; esiEmployer: number; pt: number; tds: number; other: number;
}
interface RunSummary { id: string; month: string; label: string; status: RunStatus; paidOn: string | null; expenseId: string | null; totals: Totals }
interface Payslip {
  id: string; employeeId: string; snapshot: PayslipSnapshot; lopDays: number; extraEarnings: LineItem[]; otherDeductions: LineItem[];
  tdsOverride: number | null; remarks: string | null; calc: PayCalc; gross: number; totalDeductions: number; netPay: number; employerCost: number;
}
interface RunDetail extends RunSummary { payslips: Payslip[]; missing: { id: string; code: string; fullName: string }[] }
interface PtSlab { from: number; amount: number; february?: number | null }
type StatKey = 'pf' | 'esi' | 'pt' | 'tds';
type Statutory = Record<StatKey, boolean>;
interface PayrollSettings {
  /** Company-wide switches. Off: not deducted, not charged to the employer, not shown. */
  statutory: Statutory;
  pf: { employeeRate: number; employerRate: number; epsRate: number; wageCeiling: number; edliRate: number; adminRate: number };
  esi: { employeeRate: number; employerRate: number; wageLimit: number };
  pt: { state: string; slabs: PtSlab[] };
  lopBasis: 'calendar' | 'fixed30'; payslipNote: string; defaultComponents: Component[];
}

const PERM = 'accounting.payroll.manage';
const ALL_OFF: Statutory = { pf: false, esi: false, pt: false, tds: false };
const STAT_LABELS: Record<StatKey, string> = { pf: 'Provident Fund (PF)', esi: 'ESI', pt: 'Professional Tax', tds: 'Income tax (TDS)' };
const usePayrollSettings = () => useQuery({ queryKey: ['payroll-settings'], queryFn: () => api.get<PayrollSettings>('/payroll/settings') });
/** Which statutory deductions are on; while loading, all off (nothing extra is shown). */
const useStatutory = () => usePayrollSettings().data?.statutory ?? ALL_OFF;
export const RUN_STATUS: Record<RunStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'bg-amber-100 text-amber-800' },
  FINALISED: { label: 'Finalised', color: 'bg-sky-100 text-sky-800' },
  PAID: { label: 'Paid', color: 'bg-green-100 text-green-800' },
};
const dmy = (s: string | null) => (s ? format(new Date(`${s}T12:00:00`), 'd MMM yyyy') : '—');
const thisMonth = () => todayIso().slice(0, 7);
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

export function PayrollGate({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  return can(PERM) ? <>{children}</> : <Navigate to="/" replace />;
}

// ───────────────────────── Main page ─────────────────────────

type Tab = 'runs' | 'employees' | 'settings';

export default function Payroll() {
  return <PayrollGate><PayrollPage /></PayrollGate>;
}

function PayrollPage() {
  const [params, setParams] = useSearchParams();
  const tab = (['runs', 'employees', 'settings'] as Tab[]).find((t) => t === params.get('tab')) ?? 'runs';
  const employees = useQuery({ queryKey: ['payroll-employees'], queryFn: () => api.get<Employee[]>('/payroll/employees') });
  const runs = useQuery({ queryKey: ['payroll-runs'], queryFn: () => api.get<RunSummary[]>('/payroll/runs') });
  const active = (employees.data ?? []).filter((e) => e.active);
  const on = useStatutory();
  return (
    <div className="space-y-4">
      <PageHeader title="Payroll" subtitle="Employees and salaries, the monthly payroll with PF, ESI, Professional Tax and TDS, and payslips." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Employees" value={String(active.length)} sub={`${(employees.data ?? []).length - active.length} former`} />
        <StatCard label="Monthly gross" value={rupees(active.reduce((a, e) => a + e.monthly.gross, 0))} sub="full month, before loss of pay" />
        <StatCard label="Monthly cost to company" value={rupees(active.reduce((a, e) => a + e.monthly.employerCost, 0))} sub={on.pf || on.esi ? 'gross + employer PF/ESI' : 'salaries paid in full'} />
        <StatCard label="Last payroll" value={runs.data?.[0]?.label ?? '—'} sub={runs.data?.[0] ? `${RUN_STATUS[runs.data[0].status].label} · net ${rupees(runs.data[0].totals.net)}` : 'none yet'} />
      </div>
      <Tabs value={tab} onChange={(t) => setParams(t === 'runs' ? {} : { tab: t }, { replace: true })} tabs={[
        { value: 'runs', label: 'Payroll runs', count: runs.data?.length },
        { value: 'employees', label: 'Employees', count: active.length },
        { value: 'settings', label: 'Settings' },
      ]} />
      {tab === 'runs' && <RunsTab runs={runs} hasEmployees={active.length > 0} onAddEmployees={() => setParams({ tab: 'employees' }, { replace: true })} />}
      {tab === 'employees' && <EmployeesTab employees={employees} />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

// ───────────────────────── Runs ─────────────────────────

function RunsTab({ runs, hasEmployees, onAddEmployees }: { runs: UseQueryResult<RunSummary[]>; hasEmployees: boolean; onAddEmployees: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const latest = runs.data?.[0]?.month;
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<RunDetail>('/payroll/runs', { month });
      qc.invalidateQueries({ queryKey: ['payroll-runs'] });
      toast.success(`Payroll for ${r.label} started with ${r.payslips.length} payslip${r.payslips.length === 1 ? '' : 's'}`);
      nav(`/accounting/payroll/runs/${r.id}`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const openNew = () => { setMonth(latest ? nextMonth(latest) : thisMonth()); setOpen(true); };

  if (runs.isLoading) return <Card><Spinner /></Card>;
  if (runs.error) return <Card><div className="p-4"><ErrorBox error={runs.error} /></div></Card>;
  return (
    <>
      <div className="flex justify-end"><Button onClick={openNew} disabled={!hasEmployees} title={hasEmployees ? undefined : 'Add employees first'}><Plus className="h-4 w-4" />Run payroll</Button></div>
      <Card>
        {!runs.data?.length ? (
          <Empty title="No payroll runs yet" icon={<Banknote className="h-9 w-9" />}>
            {hasEmployees ? 'Run payroll for a month to work out everyone\'s pay and payslips.' : 'Add your employees and their salaries first.'}
            <div className="mt-3">{hasEmployees ? <Button onClick={openNew}><Plus className="h-4 w-4" />Run payroll</Button> : <Button onClick={onAddEmployees}><UserPlus className="h-4 w-4" />Add employees</Button>}</div>
          </Empty>
        ) : (
          <Table>
            <thead><tr><Th>Month</Th><Th>Status</Th><Th className="text-right">Employees</Th><Th className="text-right">Gross</Th><Th className="text-right">Deductions</Th><Th className="text-right">Net pay</Th><Th className="text-right">Cost to company</Th><Th>Paid on</Th></tr></thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/accounting/payroll/runs/${r.id}`)}>
                  <Td><Link to={`/accounting/payroll/runs/${r.id}`} className="font-medium text-indigo-700 hover:underline">{r.label}</Link></Td>
                  <Td><Badge className={RUN_STATUS[r.status].color}>{RUN_STATUS[r.status].label}</Badge></Td>
                  <Td className="text-right tabular-nums">{r.totals.employees}</Td>
                  <Td className="text-right tabular-nums">{rupees(r.totals.gross)}</Td>
                  <Td className="text-right tabular-nums">{rupees(r.totals.deductions)}</Td>
                  <Td className="text-right font-medium tabular-nums">{rupees(r.totals.net)}</Td>
                  <Td className="text-right tabular-nums">{rupees(r.totals.employerCost)}</Td>
                  <Td className="whitespace-nowrap">{dmy(r.paidOn)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Modal open={open} onClose={() => !busy && setOpen(false)} title="Run payroll" footer={<>
        <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
        <Button onClick={start} loading={busy} disabled={!/^\d{4}-\d{2}$/.test(month)}>Start payroll</Button>
      </>}>
        <Field label="Month" hint="A payslip is made for everyone employed in the month, from their current salary. You can then enter loss-of-pay days and one-off amounts before finalising.">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

export function PayrollRunPage() {
  return <PayrollGate><RunPage /></PayrollGate>;
}

function RunPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-run', id], queryFn: () => api.get<RunDetail>(`/payroll/runs/${id}`) });
  const [editing, setEditing] = useState<Payslip | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState('');
  const run = q.data;
  const on = useStatutory();
  const set = (r: RunDetail) => { qc.setQueryData(['payroll-run', id], r); qc.invalidateQueries({ queryKey: ['payroll-runs'] }); };
  const act = async (key: string, fn: () => Promise<RunDetail | void>, done?: string) => {
    setBusy(key);
    try { const r = await fn(); if (r) set(r); if (done) toast.success(done); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(''); }
  };
  if (q.isLoading) return <Spinner />;
  if (q.error || !run) return <ErrorBox error={q.error} />;
  const draft = run.status === 'DRAFT';
  const t = run.totals;
  // A statutory column shows when it is switched on, or when this month's payslips have it.
  const amounts: Record<StatKey, number> = { pf: t.pfEmployee, esi: t.esiEmployee, pt: t.pt, tds: t.tds };
  const cols = (['pf', 'esi', 'pt', 'tds'] as StatKey[]).filter((k) => on[k] || amounts[k] > 0);
  const COL: Record<StatKey, string> = { pf: 'PF', esi: 'ESI', pt: 'PT', tds: 'TDS' };
  const employerExtra = t.employerCost > t.gross;
  const saveLop = async (p: Payslip, lop: number) => {
    if (lop === p.lopDays) return;
    try { await api.patch(`/payroll/payslips/${p.id}`, { lopDays: lop }); await q.refetch(); qc.invalidateQueries({ queryKey: ['payroll-runs'] }); } catch (e) { toast.error(errMsg(e)); }
  };
  const removeSlip = async (p: Payslip) => {
    if (!confirm(`Leave ${p.snapshot.fullName} out of ${run.label}? "Update from employees" adds them back.`)) return;
    try { await api.del(`/payroll/payslips/${p.id}`); await q.refetch(); toast.success('Removed from this payroll'); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/accounting/payroll" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Payroll</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">Payroll · {run.label}</h1>
        <Badge className={RUN_STATUS[run.status].color}>{RUN_STATUS[run.status].label}</Badge>
        {run.paidOn && <span className="text-sm text-slate-500">paid {dmy(run.paidOn)}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {draft && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" loading={busy === 'delete'}
            onClick={() => confirm(`Delete the ${run.label} payroll and its payslips?`) && act('delete', async () => { await api.del(`/payroll/runs/${run.id}`); qc.invalidateQueries({ queryKey: ['payroll-runs'] }); nav('/accounting/payroll'); }, 'Payroll deleted')}>
            <Trash2 className="h-4 w-4" />Delete</Button>}
          {draft && <Button variant="secondary" loading={busy === 'refresh'} title="Pick up changes to employees' salaries and details, and add anyone missing"
            onClick={() => act('refresh', () => api.post<RunDetail>(`/payroll/runs/${run.id}/refresh`), 'Updated from employees')}><RefreshCw className="h-4 w-4" />Update from employees</Button>}
          {draft && <Button loading={busy === 'finalise'} onClick={() => confirm(`Finalise ${run.label}? Payslips are locked and shown to the employees linked to a CRM user.`) && act('finalise', () => api.post<RunDetail>(`/payroll/runs/${run.id}/finalise`), 'Payroll finalised')}>
            <Lock className="h-4 w-4" />Finalise</Button>}
          {run.status === 'FINALISED' && <Button variant="secondary" loading={busy === 'reopen'} onClick={() => act('reopen', () => api.post<RunDetail>(`/payroll/runs/${run.id}/reopen`), 'Back to draft')}><RotateCcw className="h-4 w-4" />Reopen</Button>}
          {run.status === 'FINALISED' && <Button onClick={() => setPaying(true)}><CheckCircle2 className="h-4 w-4" />Mark paid</Button>}
          {run.status === 'PAID' && <Button variant="secondary" loading={busy === 'unpay'}
            onClick={() => confirm('Mark this payroll unpaid? The salary expense recorded in Accounting is removed.') && act('unpay', () => api.post<RunDetail>(`/payroll/runs/${run.id}/unpay`), 'Marked unpaid')}><Undo2 className="h-4 w-4" />Mark unpaid</Button>}
        </div>
      </div>

      <div className={clsx('grid grid-cols-2 gap-3', employerExtra ? 'lg:grid-cols-5' : 'lg:grid-cols-4')}>
        <StatCard label="Employees" value={String(t.employees)} />
        <StatCard label="Gross" value={rupees(t.gross)} />
        <StatCard label="Deductions" value={rupees(t.deductions)} tone="warn" />
        <StatCard label="Net pay" value={rupees(t.net)} tone="good" sub="to transfer" />
        {employerExtra && <StatCard label="Cost to company" value={rupees(t.employerCost)} sub="gross + employer contributions" />}
      </div>

      {draft && run.missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Users className="h-4 w-4" />Not in this payroll yet: {run.missing.map((m) => `${m.fullName} (${m.code})`).join(', ')}.
          <Button size="sm" variant="secondary" className="ml-auto" loading={busy === 'refresh'} onClick={() => act('refresh', () => api.post<RunDetail>(`/payroll/runs/${run.id}/refresh`), 'Updated from employees')}>Add them</Button>
        </div>
      )}

      <Card title="Payslips" actions={<div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => nav(`/accounting/payroll/runs/${run.id}/payslips`)}><Printer className="h-4 w-4" />Print all payslips</Button>
        <Button size="sm" variant="secondary" onClick={() => api.download(`/payroll/runs/${run.id}/register.csv`).catch((e) => toast.error(errMsg(e)))}><Download className="h-4 w-4" />Salary register</Button>
        <Button size="sm" variant="secondary" onClick={() => api.download(`/payroll/runs/${run.id}/bank.csv`).catch((e) => toast.error(errMsg(e)))}><Download className="h-4 w-4" />Bank transfer sheet</Button>
      </div>}>
        {!run.payslips.length ? <Empty title="No payslips in this payroll" /> : (
          <Table>
            <thead><tr>
              <Th>Employee</Th><Th className="text-right">Paid days</Th><Th className="text-right">LOP days</Th><Th className="text-right">Gross</Th>
              {cols.map((k) => <Th key={k} className="text-right">{COL[k]}</Th>)}<Th className="text-right">{cols.length ? 'Other' : 'Deductions'}</Th>
              <Th className="text-right">Net pay</Th><Th className="text-right"><span className="sr-only">Actions</span></Th>
            </tr></thead>
            <tbody>
              {run.payslips.map((p) => {
                const d = (k: string) => p.calc.deductions.filter((x) => x.key === k).reduce((a, x) => a + x.amount, 0);
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <Td>
                      <p className="font-medium text-slate-900">{p.snapshot.fullName}</p>
                      <p className="text-xs text-slate-500">{p.snapshot.code}{p.snapshot.designation ? ` · ${p.snapshot.designation}` : ''}{p.extraEarnings.length ? ` · +${p.extraEarnings.map((x) => x.name).join(', ')}` : ''}</p>
                    </Td>
                    <Td className="text-right tabular-nums">{p.calc.paidDays}/{p.calc.basisDays}</Td>
                    <Td className="text-right">
                      {draft ? <LopInput value={p.lopDays} max={p.calc.basisDays} onSave={(v) => saveLop(p, v)} /> : <span className="tabular-nums">{p.lopDays}</span>}
                    </Td>
                    <Td className="text-right tabular-nums">{rupees(p.gross)}</Td>
                    {cols.map((k) => <Td key={k} className="text-right tabular-nums">{rupees(d(k))}</Td>)}
                    <Td className="text-right tabular-nums">{rupees(d('other'))}</Td>
                    <Td className={clsx('text-right font-semibold tabular-nums', p.netPay < 0 && 'text-rose-600')}>{rupees(p.netPay)}</Td>
                    <Td className="whitespace-nowrap text-right">
                      {draft && <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Bonus, deductions, TDS, remarks" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></button>}
                      <Link to={`/accounting/payroll/payslips/${p.id}`} className="inline-flex rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Payslip"><FileText className="h-4 w-4" /></Link>
                      {draft && <button className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Leave out of this payroll" onClick={() => void removeSlip(p)}><X className="h-4 w-4" /></button>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {cols.length > 0 && (
        <Card title="Statutory dues for the month" actions={<span className="text-xs text-slate-500">For the returns and deposits of what is deducted</span>}>
          <div className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {cols.includes('pf') && <Dues title="Provident Fund" rows={[['Employee share', t.pfEmployee], ['Employer EPF', t.epf], ['Employer pension (EPS)', t.eps], ['EDLI', t.edli], ['PF admin charges', t.pfAdmin]]} />}
            {cols.includes('esi') && <Dues title="ESI" rows={[['Employee share', t.esiEmployee], ['Employer share', t.esiEmployer]]} />}
            {cols.includes('pt') && <Dues title="Professional Tax" rows={[['Deducted from salaries', t.pt]]} />}
            {cols.includes('tds') && <Dues title="Income tax (TDS)" rows={[['Deducted from salaries', t.tds]]} />}
          </div>
        </Card>
      )}

      {editing && <PayslipEditModal tdsOn={on.tds || editing.calc.deductions.some((x) => x.key === 'tds')} p={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await q.refetch(); qc.invalidateQueries({ queryKey: ['payroll-runs'] }); }} />}
      {paying && <PayModal run={run} onClose={() => setPaying(false)} onPaid={(r) => { set(r); setPaying(false); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); toast.success(`${run.label} marked paid`); }} />}
    </div>
  );
}

function Dues({ title, rows }: { title: string; rows: [string, number][] }) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <p className="font-semibold text-slate-900">{title}</p>
      {rows.map(([k, v]) => <p key={k} className="flex justify-between text-slate-600"><span>{k}</span><span className="tabular-nums">{rupees(v)}</span></p>)}
      {rows.length > 1 && <p className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-semibold"><span>To pay</span><span className="tabular-nums">{rupees(total)}</span></p>}
    </div>
  );
}

function LopInput({ value, max, onSave }: { value: number; max: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Math.min(max, Math.max(0, Number(v) || 0)) * 2) / 2;
    setV(String(n));
    onSave(n);
  };
  return <Input type="number" min={0} max={max} step={0.5} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="w-20 text-right" aria-label="Loss of pay days" />;
}

function ItemsEditor({ label, items, onChange, placeholder }: { label: string; items: LineItem[]; onChange: (v: LineItem[]) => void; placeholder: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-slate-700">{label}</p>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex gap-2">
            <Input value={it.name} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={placeholder} aria-label={`${label} name`} />
            <Input type="number" min={0} value={it.amount || ''} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} className="w-32 text-right" placeholder="₹" aria-label={`${label} amount`} />
            <button className="rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => onChange([...items, { name: '', amount: 0 }])}><Plus className="h-4 w-4" />Add</Button>
      </div>
    </div>
  );
}

function PayslipEditModal({ p, tdsOn, onClose, onSaved }: { p: Payslip; tdsOn: boolean; onClose: () => void; onSaved: () => void }) {
  const [lop, setLop] = useState(String(p.lopDays));
  const [extra, setExtra] = useState<LineItem[]>(p.extraEarnings);
  const [other, setOther] = useState<LineItem[]>(p.otherDeductions);
  const [tds, setTds] = useState(p.tdsOverride == null ? '' : String(p.tdsOverride));
  const [remarks, setRemarks] = useState(p.remarks ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const bad = [...extra, ...other].find((x) => (x.name.trim() && !(x.amount > 0)) || (!x.name.trim() && x.amount > 0));
    if (bad) { toast.error('Give every line a name and an amount'); return; }
    setBusy(true);
    try {
      await api.patch(`/payroll/payslips/${p.id}`, {
        lopDays: Math.max(0, Number(lop) || 0), extraEarnings: extra.filter((x) => x.name.trim()), otherDeductions: other.filter((x) => x.name.trim()),
        ...(tdsOn ? { tdsOverride: tds.trim() === '' ? null : Math.max(0, Number(tds) || 0) } : {}), remarks: remarks.trim() || null,
      });
      toast.success('Payslip updated');
      onSaved();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} wide title={`${p.snapshot.fullName} · this month`} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Loss of pay days" hint={`Out of ${p.calc.basisDays}. Half days allowed.`}><Input type="number" min={0} step={0.5} value={lop} onChange={(e) => setLop(e.target.value)} /></Field>
        {tdsOn && <Field label="Income tax (TDS) this month" hint={`Leave empty for the usual ${rupees(p.snapshot.monthlyTds)}.`}><Input type="number" min={0} value={tds} onChange={(e) => setTds(e.target.value)} placeholder={String(p.snapshot.monthlyTds)} /></Field>}
      </div>
      <ItemsEditor label={p.calc.pfWages > 0 ? 'One-off earnings (not counted for PF)' : 'One-off earnings'} items={extra} onChange={setExtra} placeholder="Bonus, incentive, arrears…" />
      <ItemsEditor label="Other deductions" items={other} onChange={setOther} placeholder="Salary advance, loan recovery…" />
      <Field label="Remarks on the payslip (optional)"><Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
    </Modal>
  );
}

function PayModal({ run, onClose, onPaid }: { run: RunDetail; onClose: () => void; onPaid: (r: RunDetail) => void }) {
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [record, setRecord] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { onPaid(await api.post<RunDetail>(`/payroll/runs/${run.id}/pay`, { paidOn, method, recordExpense: record })); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title={`Mark ${run.label} paid`} footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={save} loading={busy}><CheckCircle2 className="h-4 w-4" />Mark paid</Button>
    </>}>
      <p className="text-sm text-slate-600">Net pay of {rupees(run.totals.net)} to {run.totals.employees} employee{run.totals.employees === 1 ? '' : 's'}.</p>
      <Field label="Paid on"><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      <Field label="Paid by"><Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{(Object.keys(METHODS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select></Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={record} onChange={(e) => setRecord(e.target.checked)} />
        <span>Record the salary cost ({rupees(run.totals.employerCost)}{run.totals.employerCost > run.totals.gross ? ': gross plus employer contributions' : ''}) as a paid expense under “Salaries &amp; Wages” in Accounting</span>
      </label>
    </Modal>
  );
}

// ───────────────────────── Payslips (print) ─────────────────────────

export function PayrollPayslipPage() {
  return <PayrollGate><SinglePayslip /></PayrollGate>;
}

function SinglePayslip() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['payslip', id], queryFn: () => api.get<PrintablePayslip & { runId: string }>(`/payroll/payslips/${id}`) });
  const [employer, setEmployer] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const p = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to={`/accounting/payroll/runs/${p.runId}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />{p.monthLabel} payroll</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">Payslip · {p.snapshot.fullName}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {!!p.calc.employer?.total && <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={employer} onChange={(e) => setEmployer(e.target.checked)} />Show employer contributions</label>}
          <Button variant="secondary" onClick={() => printPayslips(`Payslip ${p.snapshot.code} ${p.snapshot.fullName} ${p.monthLabel}`)}><Printer className="h-4 w-4" />Print / Save PDF</Button>
        </div>
      </div>
      <div className="overflow-x-auto print:overflow-visible"><PayslipPrint slips={[p]} employerDetails={employer} /></div>
    </div>
  );
}

export function PayrollRunPayslipsPage() {
  return <PayrollGate><RunPayslips /></PayrollGate>;
}

function RunPayslips() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['payroll-run-payslips', id], queryFn: () => api.get<PrintablePayslip[]>(`/payroll/runs/${id}/payslips`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const label = q.data[0]?.monthLabel ?? '';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to={`/accounting/payroll/runs/${id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />{label} payroll</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">All payslips · {label}</h1>
        <Button className="ml-auto" variant="secondary" onClick={() => printPayslips(`Payslips ${label}`)} disabled={!q.data.length}><Printer className="h-4 w-4" />Print / Save PDF ({q.data.length})</Button>
      </div>
      {!q.data.length ? <Card><Empty title="No payslips in this payroll" /></Card> : <div className="overflow-x-auto print:overflow-visible"><PayslipPrint slips={q.data} /></div>}
    </div>
  );
}

// ───────────────────────── Employees ─────────────────────────

function EmployeesTab({ employees }: { employees: UseQueryResult<Employee[]> }) {
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  const [search, setSearch] = useState('');
  if (employees.isLoading) return <Card><Spinner /></Card>;
  if (employees.error) return <Card><div className="p-4"><ErrorBox error={employees.error} /></div></Card>;
  const all = employees.data ?? [];
  const term = search.trim().toLowerCase();
  const list = all.filter((e) => (showFormer || e.active) && (!term || [e.fullName, e.code, e.designation, e.department].some((x) => x?.toLowerCase().includes(term))));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, ID, designation…" className="w-64" aria-label="Search employees" />
        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} />Show former employees</label>
        <Button className="ml-auto" onClick={() => setEditing('new')}><UserPlus className="h-4 w-4" />Add employee</Button>
      </div>
      <Card>
        {!list.length ? (
          <Empty title={all.length ? 'No employees match' : 'No employees yet'} icon={<Users className="h-9 w-9" />}>
            {!all.length && <>Add each person with their salary structure, PAN, UAN and bank details.<div className="mt-3"><Button onClick={() => setEditing('new')}><UserPlus className="h-4 w-4" />Add employee</Button></div></>}
          </Empty>
        ) : (
          <Table>
            <thead><tr><Th>Employee</Th><Th>Department</Th><Th>Joined</Th><Th className="text-right">Monthly gross</Th><Th className="text-right">Take-home</Th><Th className="text-right">CTC / year</Th><Th>CRM login</Th><Th /></tr></thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={clsx('cursor-pointer hover:bg-slate-50', !e.active && 'opacity-60')} onClick={() => setEditing(e)}>
                  <Td><p className="font-medium text-slate-900">{e.fullName}</p><p className="text-xs text-slate-500">{e.code}{e.designation ? ` · ${e.designation}` : ''}</p></Td>
                  <Td>{e.department ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{dmy(e.dateOfJoining)}{e.dateOfLeaving && <p className="text-xs text-slate-500">left {dmy(e.dateOfLeaving)}</p>}</Td>
                  <Td className="text-right tabular-nums">{rupees(e.monthly.gross)}</Td>
                  <Td className="text-right tabular-nums" >{rupees(e.monthly.net)}</Td>
                  <Td className="text-right tabular-nums">{rupees(e.monthly.annualCtc)}</Td>
                  <Td className="text-sm">{e.user ? e.user.fullName : <span className="text-slate-400">not linked</span>}</Td>
                  <Td className="text-right"><Pencil className="inline h-4 w-4 text-slate-400" /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="text-xs text-slate-500">Take-home and CTC are for a full month with the current settings, before loss of pay and one-off amounts.</p>
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

interface EmployeeForm {
  userId: string; code: string; fullName: string; email: string; phone: string; designation: string; department: string; location: string;
  dateOfJoining: string; dateOfLeaving: string; pan: string; uan: string; pfNumber: string; esiNumber: string; bankName: string; accountNumber: string; ifsc: string;
  paymentMethod: PaymentMethod; components: { name: string; amount: string; pf: boolean }[]; pfEnabled: boolean; pfCapped: boolean; esiEnabled: boolean; ptEnabled: boolean;
  monthlyTds: string; notes: string;
}

function EmployeeModal({ employee, onClose }: { employee: Employee | null; onClose: () => void }) {
  const qc = useQueryClient();
  const settings = usePayrollSettings();
  const on = settings.data?.statutory ?? ALL_OFF;
  const users = useQuery({ queryKey: ['payroll-users'], queryFn: () => api.get<{ id: string; fullName: string; email: string; employeeId: string | null }[]>('/payroll/users') });
  const next = useQuery({ queryKey: ['payroll-next-code'], queryFn: () => api.get<{ code: string }>('/payroll/employees/next-code'), enabled: !employee });
  const [f, setF] = useState<EmployeeForm | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (f) return;
    if (employee) {
      setF({
        userId: employee.userId ?? '', code: employee.code, fullName: employee.fullName, email: employee.email ?? '', phone: employee.phone ?? '',
        designation: employee.designation ?? '', department: employee.department ?? '', location: employee.location ?? '',
        dateOfJoining: employee.dateOfJoining, dateOfLeaving: employee.dateOfLeaving ?? '', pan: employee.pan ?? '', uan: employee.uan ?? '',
        pfNumber: employee.pfNumber ?? '', esiNumber: employee.esiNumber ?? '', bankName: employee.bankName ?? '', accountNumber: employee.accountNumber ?? '',
        ifsc: employee.ifsc ?? '', paymentMethod: employee.paymentMethod, components: employee.components.map((c) => ({ name: c.name, amount: String(c.amount), pf: !!c.pf })),
        pfEnabled: employee.pfEnabled, pfCapped: employee.pfCapped, esiEnabled: employee.esiEnabled, ptEnabled: employee.ptEnabled,
        monthlyTds: employee.monthlyTds ? String(employee.monthlyTds) : '', notes: employee.notes ?? '',
      });
    } else if (settings.data && next.data) {
      setF({
        userId: '', code: next.data.code, fullName: '', email: '', phone: '', designation: '', department: '', location: '', dateOfJoining: todayIso(), dateOfLeaving: '',
        pan: '', uan: '', pfNumber: '', esiNumber: '', bankName: '', accountNumber: '', ifsc: '', paymentMethod: 'BANK_TRANSFER',
        components: settings.data.defaultComponents.map((c) => ({ name: c.name, amount: c.amount ? String(c.amount) : '', pf: !!c.pf })),
        pfEnabled: true, pfCapped: true, esiEnabled: true, ptEnabled: true, monthlyTds: '', notes: '',
      });
    }
  }, [employee, settings.data, next.data, f]);

  const set = (c: Partial<EmployeeForm>) => f && setF({ ...f, ...c });
  const setComp = (i: number, c: Partial<EmployeeForm['components'][number]>) => f && set({ components: f.components.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const gross = f ? f.components.reduce((a, c) => a + (Number(c.amount) || 0), 0) : 0;
  const pickUser = (id: string) => {
    if (!f) return;
    const u = users.data?.find((x) => x.id === id);
    set({ userId: id, ...(u && !f.fullName ? { fullName: u.fullName } : {}), ...(u && !f.email ? { email: u.email } : {}) });
  };

  const save = async () => {
    if (!f) return;
    if (f.fullName.trim().length < 2) { toast.error('Add the employee\'s name'); return; }
    if (!f.components.some((c) => Number(c.amount) > 0)) { toast.error('Add the salary: at least one part with an amount'); return; }
    setBusy(true);
    try {
      const body = {
        ...f, userId: f.userId || null, dateOfLeaving: f.dateOfLeaving || null, email: f.email.trim() || null,
        pan: f.pan.trim().toUpperCase(), ifsc: f.ifsc.trim().toUpperCase(), uan: f.uan.trim(), esiNumber: f.esiNumber.trim(), accountNumber: f.accountNumber.replace(/\s/g, ''),
        components: f.components.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), amount: Math.max(0, Number(c.amount) || 0), pf: c.pf })),
        monthlyTds: Math.max(0, Number(f.monthlyTds) || 0), notes: f.notes.trim() || null,
      };
      if (employee) await api.put(`/payroll/employees/${employee.id}`, body); else await api.post('/payroll/employees', body);
      qc.invalidateQueries({ queryKey: ['payroll-employees'] }); qc.invalidateQueries({ queryKey: ['payroll-users'] }); qc.invalidateQueries({ queryKey: ['payroll-next-code'] });
      toast.success(employee ? 'Employee updated' : 'Employee added');
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!employee || !confirm(`Delete ${employee.fullName}?`)) return;
    try { await api.del(`/payroll/employees/${employee.id}`); qc.invalidateQueries({ queryKey: ['payroll-employees'] }); toast.success('Employee deleted'); onClose(); }
    catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <Modal open wide onClose={() => !busy && onClose()} title={employee ? `Edit ${employee.fullName}` : 'Add employee'} footer={<>
      {employee && !employee.payslipCount && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove}><Trash2 className="h-4 w-4" />Delete</Button>}
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button onClick={save} loading={busy} disabled={!f}><Save className="h-4 w-4" />Save</Button>
    </>}>
      {!f ? <Spinner /> : <>
        <Section title="Employee">
          <Field label="CRM user (optional)" hint="Linked people see their own payslips under My payslips once a payroll is finalised.">
            <Select value={f.userId} onChange={(e) => pickUser(e.target.value)}>
              <option value="">Not linked</option>
              {(users.data ?? []).filter((u) => !u.employeeId || u.employeeId === employee?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.email}</option>)}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name"><Input value={f.fullName} onChange={(e) => set({ fullName: e.target.value })} /></Field>
            <Field label="Employee ID"><Input value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Designation"><Input value={f.designation} onChange={(e) => set({ designation: e.target.value })} placeholder="Graphic Designer" /></Field>
            <Field label="Department"><Input value={f.department} onChange={(e) => set({ department: e.target.value })} placeholder="Creative" /></Field>
            <Field label="Date of joining"><Input type="date" value={f.dateOfJoining} onChange={(e) => set({ dateOfJoining: e.target.value })} /></Field>
            <Field label="Last working day" hint="Only when the person has left."><Input type="date" value={f.dateOfLeaving} onChange={(e) => set({ dateOfLeaving: e.target.value })} /></Field>
            <Field label="Work location"><Input value={f.location} onChange={(e) => set({ location: e.target.value })} placeholder="Bangalore" /></Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          </div>
        </Section>

        <Section title="Monthly salary" aside={<span className="text-sm font-semibold tabular-nums">{rupees(gross)} / month · {rupees(gross * 12)} / year</span>}>
          <div className="space-y-2">
            {f.components.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={c.name} onChange={(e) => setComp(i, { name: e.target.value })} placeholder="Component" aria-label="Component name" />
                <Input type="number" min={0} value={c.amount} onChange={(e) => setComp(i, { amount: e.target.value })} className="w-32 text-right" placeholder="₹" aria-label="Monthly amount" />
                {on.pf && <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600" title="Counts as PF wages (Basic, DA)"><input type="checkbox" checked={c.pf} onChange={(e) => setComp(i, { pf: e.target.checked })} />PF wage</label>}
                <button className="rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => set({ components: f.components.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => set({ components: [...f.components, { name: '', amount: '', pf: false }] })}><Plus className="h-4 w-4" />Add component</Button>
          </div>
        </Section>

        {(on.pf || on.esi || on.pt || on.tds) && (
          <Section title="Statutory deductions">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              {on.pf && <Check label="Provident Fund (PF)" checked={f.pfEnabled} onChange={(v) => set({ pfEnabled: v })} />}
              {on.pf && <Check label={`PF on wages up to ₹${(settings.data?.pf.wageCeiling ?? 15000).toLocaleString('en-IN')} only`} checked={f.pfCapped} disabled={!f.pfEnabled} onChange={(v) => set({ pfCapped: v })} />}
              {on.esi && <Check label={`ESI (when gross is ₹${(settings.data?.esi.wageLimit ?? 21000).toLocaleString('en-IN')} or less)`} checked={f.esiEnabled} onChange={(v) => set({ esiEnabled: v })} />}
              {on.pt && <Check label={`Professional Tax (${settings.data?.pt.state || 'state'})`} checked={f.ptEnabled} onChange={(v) => set({ ptEnabled: v })} />}
            </div>
            {on.tds && <Field label="Income tax (TDS) per month" hint="From the employee's tax declaration and regime. Can be changed on any month's payslip."><Input type="number" min={0} value={f.monthlyTds} onChange={(e) => set({ monthlyTds: e.target.value })} placeholder="0" /></Field>}
          </Section>
        )}

        <Section title={on.pf || on.esi ? 'Statutory IDs and bank' : 'PAN and bank'}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="PAN"><Input value={f.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} placeholder="ABCDE1234F" maxLength={10} /></Field>
            {on.pf && <Field label="UAN (PF)"><Input value={f.uan} onChange={(e) => set({ uan: e.target.value.replace(/\D/g, '') })} placeholder="12 digits" maxLength={12} /></Field>}
            {on.pf && <Field label="PF member ID"><Input value={f.pfNumber} onChange={(e) => set({ pfNumber: e.target.value })} placeholder="KABNG00123450000012345" /></Field>}
            {on.esi && <Field label="ESI number"><Input value={f.esiNumber} onChange={(e) => set({ esiNumber: e.target.value.replace(/\D/g, '') })} /></Field>}
            <Field label="Bank"><Input value={f.bankName} onChange={(e) => set({ bankName: e.target.value })} placeholder="HDFC Bank" /></Field>
            <Field label="Account number"><Input value={f.accountNumber} onChange={(e) => set({ accountNumber: e.target.value.replace(/[^\d]/g, '') })} /></Field>
            <Field label="IFSC"><Input value={f.ifsc} onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} placeholder="HDFC0001234" maxLength={11} /></Field>
            <Field label="Paid by"><Select value={f.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value as PaymentMethod })}>{(Object.keys(METHODS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select></Field>
          </div>
          <Field label="Notes (not printed)"><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        </Section>
      </>}
    </Modal>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-900">{title}</h3>{aside}</div>
      {children}
    </section>
  );
}

function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className={clsx('flex items-center gap-2', disabled && 'opacity-50')}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}

// ───────────────────────── Settings ─────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const q = usePayrollSettings();
  const [s, setS] = useState<PayrollSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !s) setS(q.data); }, [q.data, s]);
  if (q.isLoading || !s) return <Card>{q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : <Spinner />}</Card>;
  const n = (v: string) => Number(v) || 0;
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.put<PayrollSettings>('/payroll/settings', {
        ...s, pt: { ...s.pt, slabs: s.pt.slabs.filter((x) => x.amount > 0 || x.from > 0) },
        defaultComponents: s.defaultComponents.filter((c) => c.name.trim()),
      });
      setS(saved); qc.setQueryData(['payroll-settings'], saved); qc.invalidateQueries({ queryKey: ['payroll-employees'] });
      toast.success('Payroll settings saved. They apply to new payrolls; on a draft payroll use “Update from employees”.');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const num = (label: string, value: number, onChange: (v: number) => void, hint?: string) => (
    <Field label={label} hint={hint}><Input type="number" min={0} step="any" value={value} onChange={(e) => onChange(n(e.target.value))} /></Field>
  );
  return (
    <div className="space-y-4">
      <Card title="Deductions from salary">
        <div className="space-y-3 p-4">
          <p className="text-sm text-slate-600">Switch on only what the company deducts. A deduction that is off is not taken from anyone's salary, not charged to the company, and not shown on payslips, payroll screens or exports. With all four off, salaries are paid in full.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['pf', 'esi', 'pt', 'tds'] as StatKey[]).map((k) => (
              <label key={k} className={clsx('flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm', s.statutory[k] ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200')}>
                <span className="font-medium text-slate-900">{STAT_LABELS[k]}</span>
                <span className="flex items-center gap-2 text-xs text-slate-600">{s.statutory[k] ? 'On' : 'Off'}
                  <input type="checkbox" role="switch" aria-label={STAT_LABELS[k]} checked={s.statutory[k]} onChange={(e) => setS({ ...s, statutory: { ...s.statutory, [k]: e.target.checked } })} className="h-4 w-4" />
                </span>
              </label>
            ))}
          </div>
        </div>
      </Card>
      {s.statutory.pf && <Card title="Provident Fund (EPF)">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {num('Employee share (%)', s.pf.employeeRate, (v) => setS({ ...s, pf: { ...s.pf, employeeRate: v } }))}
          {num('Employer share (%)', s.pf.employerRate, (v) => setS({ ...s, pf: { ...s.pf, employerRate: v } }))}
          {num('Of which pension, EPS (%)', s.pf.epsRate, (v) => setS({ ...s, pf: { ...s.pf, epsRate: v } }), 'Always on wages up to the ceiling')}
          {num('PF wage ceiling (₹)', s.pf.wageCeiling, (v) => setS({ ...s, pf: { ...s.pf, wageCeiling: v } }))}
          {num('EDLI (%)', s.pf.edliRate, (v) => setS({ ...s, pf: { ...s.pf, edliRate: v } }))}
          {num('PF admin charges (%)', s.pf.adminRate, (v) => setS({ ...s, pf: { ...s.pf, adminRate: v } }))}
        </div>
      </Card>}
      {s.statutory.esi && <Card title="ESI">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {num('Employee share (%)', s.esi.employeeRate, (v) => setS({ ...s, esi: { ...s.esi, employeeRate: v } }))}
          {num('Employer share (%)', s.esi.employerRate, (v) => setS({ ...s, esi: { ...s.esi, employerRate: v } }))}
          {num('Applies up to gross of (₹ / month)', s.esi.wageLimit, (v) => setS({ ...s, esi: { ...s.esi, wageLimit: v } }))}
        </div>
      </Card>}
      {s.statutory.pt && <Card title="Professional Tax">
        <div className="space-y-3 p-4">
          <Field label="State" className="max-w-xs"><Input value={s.pt.state} onChange={(e) => setS({ ...s, pt: { ...s.pt, state: e.target.value } })} /></Field>
          <p className="text-sm text-slate-600">Monthly tax by the month's gross salary. The highest slab reached applies.</p>
          {s.pt.slabs.map((sl, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              {num('Gross from (₹)', sl.from, (v) => setS({ ...s, pt: { ...s.pt, slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, from: v } : x)) } }))}
              {num('Tax per month (₹)', sl.amount, (v) => setS({ ...s, pt: { ...s.pt, slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, amount: v } : x)) } }))}
              <Field label="In February (₹)"><Input type="number" min={0} value={sl.february ?? ''} placeholder="same"
                onChange={(e) => setS({ ...s, pt: { ...s.pt, slabs: s.pt.slabs.map((x, j) => (j === i ? { ...x, february: e.target.value === '' ? null : n(e.target.value) } : x)) } })} /></Field>
              <button className="mb-1 rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => setS({ ...s, pt: { ...s.pt, slabs: s.pt.slabs.filter((_, j) => j !== i) } })} aria-label="Remove slab"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setS({ ...s, pt: { ...s.pt, slabs: [...s.pt.slabs, { from: 0, amount: 0, february: null }] } })}><Plus className="h-4 w-4" />Add slab</Button>
        </div>
      </Card>}
      <Card title="Payslips and loss of pay">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Pay per day is worked out on">
            <Select value={s.lopBasis} onChange={(e) => setS({ ...s, lopBasis: e.target.value as PayrollSettings['lopBasis'] })}>
              <option value="calendar">Days in the month (28 to 31)</option>
              <option value="fixed30">A fixed 30 days</option>
            </Select>
          </Field>
          <Field label="Note at the foot of each payslip"><Input value={s.payslipNote} onChange={(e) => setS({ ...s, payslipNote: e.target.value })} /></Field>
        </div>
        <div className="space-y-2 px-4 pb-4">
          <p className="text-sm font-medium text-slate-700">Salary components for a new employee</p>
          {s.defaultComponents.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={c.name} onChange={(e) => setS({ ...s, defaultComponents: s.defaultComponents.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Component name" />
              {s.statutory.pf && <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={!!c.pf} onChange={(e) => setS({ ...s, defaultComponents: s.defaultComponents.map((x, j) => (j === i ? { ...x, pf: e.target.checked } : x)) })} />PF wage</label>}
              <button className="rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => setS({ ...s, defaultComponents: s.defaultComponents.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setS({ ...s, defaultComponents: [...s.defaultComponents, { name: '', amount: 0, pf: false }] })}><Plus className="h-4 w-4" />Add component</Button>
        </div>
      </Card>
      <div className="flex justify-end"><Button onClick={save} loading={busy}><Save className="h-4 w-4" />Save settings</Button></div>
    </div>
  );
}

// ───────────────────────── My payslips (any signed-in employee) ─────────────────────────

interface MySlip { id: string; month: string; monthLabel: string; status: RunStatus; paidOn: string | null; gross: number; totalDeductions: number; netPay: number }

export function MyPayslips() {
  const q = useQuery({ queryKey: ['my-payslips'], queryFn: () => api.get<MySlip[]>('/payroll/me/payslips') });
  return (
    <div className="space-y-4">
      <PageHeader title="My payslips" subtitle="Your payslips, once each month's payroll is finalised. Open one to print or save it as a PDF." />
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !q.data?.length ? <Empty title="No payslips yet" icon={<FileText className="h-9 w-9" />} /> : (
          <Table>
            <thead><tr><Th>Month</Th><Th className="text-right">Gross</Th><Th className="text-right">Deductions</Th><Th className="text-right">Net pay</Th><Th>Paid on</Th></tr></thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td><Link to={`/payslips/${p.id}`} className="font-medium text-indigo-700 hover:underline">{p.monthLabel}</Link></Td>
                  <Td className="text-right tabular-nums">{rupees(p.gross)}</Td>
                  <Td className="text-right tabular-nums">{rupees(p.totalDeductions)}</Td>
                  <Td className="text-right font-semibold tabular-nums">{rupees(p.netPay)}</Td>
                  <Td>{dmy(p.paidOn)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

export function MyPayslip() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['my-payslip', id], queryFn: () => api.get<PrintablePayslip>(`/payroll/me/payslips/${id}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const p = q.data;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to="/payslips" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />My payslips</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">Payslip · {p.monthLabel}</h1>
        <Button className="ml-auto" variant="secondary" onClick={() => printPayslips(`Payslip ${p.snapshot.code} ${p.monthLabel}`)}><Printer className="h-4 w-4" />Print / Save PDF</Button>
      </div>
      <div className="overflow-x-auto print:overflow-visible"><PayslipSheetOnly p={p} /></div>
    </div>
  );
}

const PayslipSheetOnly = ({ p }: { p: PrintablePayslip }) => <div id="payslip-sheet"><PayslipSheet p={p} /></div>;
