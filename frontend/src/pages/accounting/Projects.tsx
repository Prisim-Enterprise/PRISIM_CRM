import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, BarChart3, Briefcase, FilePlus2, Pencil, Plus, Receipt, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Table, Td, Textarea, Th } from '../../components/ui';
import {
  AccountingGate, dayLabel, Expense, INVOICE_STATUS, METHODS, PaymentMethod, Project, ProjectDetail, PROJECT_STATUS, ProjectStatus, rupees, todayIso,
} from './shared';
import { ExpenseModal, ExpenseTable } from './Expenses';

type Stage = 'lead' | 'meeting_scheduled' | 'met' | 'shoot_scheduled' | 'shooting' | 'shot' | 'completed' | 'cancelled';
const STAGES: Record<Stage, { label: string; color: string }> = {
  lead: { label: 'New', color: 'bg-slate-100 text-slate-700' },
  meeting_scheduled: { label: 'Meeting scheduled', color: 'bg-violet-100 text-violet-800' },
  met: { label: 'Meeting done', color: 'bg-violet-100 text-violet-800' },
  shoot_scheduled: { label: 'Shoot scheduled', color: 'bg-amber-100 text-amber-800' },
  shooting: { label: 'Shooting', color: 'bg-orange-100 text-orange-800' },
  shot: { label: 'Shoot done', color: 'bg-sky-100 text-sky-800' },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelled', color: 'bg-slate-100 text-slate-500' },
};
/** How far along the work is, from its dates. */
function stage(p: Project, today = todayIso()): Stage {
  if (p.status === 'CANCELLED') return 'cancelled';
  if (p.status === 'COMPLETED') return 'completed';
  if (p.shootStart) {
    if (p.shootStart > today) return 'shoot_scheduled';
    return (p.shootEnd ?? p.shootStart) >= today ? 'shooting' : 'shot';
  }
  if (p.meetingDate) return p.meetingDate > today ? 'meeting_scheduled' : 'met';
  return 'lead';
}
const billed = (p: Project) => Math.max(p.quotedAmount ?? 0, p.invoiced);
function PayState({ p }: { p: Project }) {
  const b = billed(p);
  if (!b && !p.received) return <span className="text-slate-400">—</span>;
  if (!p.received) return <Badge className="bg-amber-100 text-amber-800">Unpaid</Badge>;
  if (b && p.received < b) return <Badge className="bg-sky-100 text-sky-800">Part paid</Badge>;
  return <Badge className="bg-green-100 text-green-800">Paid</Badge>;
}

export default function Projects() {
  return <AccountingGate><ProjectsPage /></AccountingGate>;
}

function ProjectsPage() {
  const [status, setStatus] = useState<ProjectStatus | ''>('ACTIVE');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['acct-projects', status, search], queryFn: () => api.get<Project[]>('/accounting/projects', { status, search }) });
  const list = q.data ?? [];
  const t = useMemo(() => list.reduce((a, p) => ({ quoted: a.quoted + billed(p), received: a.received + p.received, balance: a.balance + p.balance, spent: a.spent + p.spent }), { quoted: 0, received: 0, balance: 0, spent: 0 }), [list]);
  return (
    <div className="space-y-4">
      <PageHeader title="Clients & Projects" subtitle="Every job from the first meeting to the final payment, for clients in the CRM."
        actions={<>
          <Link to="/accounting/client-analysis"><Button variant="secondary"><BarChart3 className="h-4 w-4" />Client analysis</Button></Link>
          <Button variant="secondary" onClick={() => setAddingExpense(true)}><Receipt className="h-4 w-4" />Add expense</Button>
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New project</Button>
        </>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Quoted / invoiced" value={rupees(t.quoted)} />
        <StatCard label="Received" value={rupees(t.received)} tone="good" />
        <StatCard label="Balance due" value={rupees(t.balance)} tone={t.balance ? 'warn' : 'default'} />
        <StatCard label="Spent on projects" value={rupees(t.spent)} sub={`Profit so far ${rupees(t.received - t.spent)}`} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search project or client…" className="w-64" aria-label="Search" />
        <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus | '')} className="w-40" aria-label="Status">
          <option value="">All projects</option>
          {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>)}
        </Select>
      </div>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !list.length ? (
          <Empty title={search || status ? 'No projects match' : 'No projects yet'} icon={<Briefcase className="h-9 w-9" />}>
            <Button className="mt-3" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />New project</Button>
          </Empty>
        ) : (
          <Table>
            <thead><tr><Th>Client · project</Th><Th>Stage</Th><Th>Shoot</Th><Th className="text-right">Quoted</Th><Th className="text-right">Received</Th><Th className="text-right">Balance</Th><Th>Payment</Th><Th className="text-right">Spent</Th><Th className="text-right">Profit</Th></tr></thead>
            <tbody>
              {list.map((p) => {
                const s = stage(p);
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/accounting/projects/${p.id}`)}>
                    <Td><p className="font-medium text-slate-900">{p.client.name}</p><p className="text-xs text-slate-500">{p.title}</p></Td>
                    <Td><Badge className={STAGES[s].color}>{STAGES[s].label}</Badge></Td>
                    <Td className="whitespace-nowrap text-slate-600">{p.shootStart ? `${dayLabel(p.shootStart)}${p.shootEnd && p.shootEnd !== p.shootStart ? ` – ${dayLabel(p.shootEnd)}` : ''}` : '—'}</Td>
                    <Td className="text-right tabular-nums">{billed(p) ? rupees(billed(p)) : '—'}</Td>
                    <Td className="text-right tabular-nums">{rupees(p.received)}</Td>
                    <Td className={clsx('text-right tabular-nums', p.balance > 0 && 'font-medium text-amber-700')}>{rupees(p.balance)}</Td>
                    <Td><PayState p={p} /></Td>
                    <Td className="text-right tabular-nums text-slate-600">{rupees(p.spent)}</Td>
                    <Td className={clsx('text-right font-medium tabular-nums', p.profit < 0 ? 'text-rose-600' : 'text-emerald-700')}>{rupees(p.profit)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {adding && <ProjectModal onClose={() => setAdding(false)} onSaved={(p) => nav(`/accounting/projects/${p.id}`)} />}
      {addingExpense && <ExpenseModal expense={null} onClose={() => setAddingExpense(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ['acct-projects'] }); qc.invalidateQueries({ queryKey: ['acct-expenses'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); qc.invalidateQueries({ queryKey: ['acct-analysis'] }); }} />}
    </div>
  );
}

function ProjectModal({ project, onClose, onSaved }: { project?: ProjectDetail; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const clients = useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<{ id: string; name: string }[]>('/clients/directory'), staleTime: 60_000 });
  const [f, setF] = useState({
    clientId: project?.client.id ?? '', title: project?.title ?? '', meetingDate: project?.meetingDate ?? '', shootStart: project?.shootStart ?? '',
    shootEnd: project?.shootEnd ?? '', quotedAmount: project?.quotedAmount != null ? String(project.quotedAmount) : '', status: project?.status ?? 'ACTIVE' as ProjectStatus,
    notes: project?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (c: Partial<typeof f>) => setF({ ...f, ...c });
  const qc = useQueryClient();
  const save = async () => {
    if (!f.clientId) { toast.error('Pick the client'); return; }
    if (f.title.trim().length < 2) { toast.error('Give the project a name'); return; }
    if (f.shootStart && f.shootEnd && f.shootEnd < f.shootStart) { toast.error('The shoot cannot end before it starts'); return; }
    setSaving(true);
    try {
      const body = {
        clientId: f.clientId, title: f.title.trim(), meetingDate: f.meetingDate || null, shootStart: f.shootStart || null, shootEnd: f.shootEnd || null,
        quotedAmount: f.quotedAmount.trim() ? Math.round(Number(f.quotedAmount) * 100) / 100 : null, status: f.status, notes: f.notes.trim() || null,
      };
      const saved = project ? await api.patch<ProjectDetail>(`/accounting/projects/${project.id}`, body) : await api.post<ProjectDetail>('/accounting/projects', body);
      qc.invalidateQueries({ queryKey: ['acct-projects'] }); qc.invalidateQueries({ queryKey: ['acct-lookups'] }); qc.setQueryData(['acct-project', saved.id], saved);
      toast.success(project ? 'Saved' : 'Project created'); onSaved(saved); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  return (
    <Modal open wide onClose={onClose} title={project ? 'Edit project' : 'New project'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}>{project ? 'Save' : 'Create project'}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client" hint={<>Clients come from the <Link to="/clients" className="text-indigo-600 hover:underline">Clients tab</Link>.</>}>
          <Select value={f.clientId} onChange={(e) => set({ clientId: e.target.value })}>
            <option value="">Pick a client…</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Project"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Diwali campaign shoot" /></Field>
        <Field label="Meeting with client"><Input type="date" value={f.meetingDate} onChange={(e) => set({ meetingDate: e.target.value })} /></Field>
        <Field label="Quoted amount (₹)"><Input type="number" min={0} step="1" value={f.quotedAmount} onChange={(e) => set({ quotedAmount: e.target.value })} /></Field>
        <Field label="Shoot starts"><Input type="date" value={f.shootStart} onChange={(e) => set({ shootStart: e.target.value, shootEnd: f.shootEnd && f.shootEnd < e.target.value ? e.target.value : f.shootEnd })} /></Field>
        <Field label="Shoot ends" hint="Leave empty for a one-day shoot."><Input type="date" value={f.shootEnd} min={f.shootStart || undefined} onChange={(e) => set({ shootEnd: e.target.value })} /></Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => set({ status: e.target.value as ProjectStatus })}>
            {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>)}
          </Select>
        </Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export function PaymentModal({ title, max, onClose, onSave }: { title: string; max?: number; onClose: () => void; onSave: (b: { amount: number; paidOn: string; method: PaymentMethod; note: string | null }) => Promise<void> }) {
  const [amount, setAmount] = useState(max ? String(max) : '');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const a = Math.round(Number(amount) * 100) / 100;
    if (!(a > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (max !== undefined && a > max + 0.005) { toast.error(`That is more than the balance due (${rupees(max)})`); return; }
    setSaving(true);
    try { await onSave({ amount: a, paidOn, method, note: note.trim() || null }); onClose(); }
    catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}>Record payment</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (₹)" hint={max !== undefined ? `Balance due ${rupees(max)}` : undefined}><Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <Field label="Received on"><Input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{(Object.keys(METHODS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select>
        </Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Advance" /></Field>
      </div>
    </Modal>
  );
}

export function ProjectPage() {
  return <AccountingGate><ProjectDetailPage /></AccountingGate>;
}

function ProjectDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['acct-project', id], queryFn: () => api.get<ProjectDetail>(`/accounting/projects/${id}`) });
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [expense, setExpense] = useState<Expense | null>(null);
  const [addingExpense, setAddingExpense] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-analysis'] }); qc.invalidateQueries({ queryKey: ['acct-project', id] }); qc.invalidateQueries({ queryKey: ['acct-projects'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); qc.invalidateQueries({ queryKey: ['acct-expenses'] }); };
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Project not found')} />;
  const p = q.data;
  const s = stage(p);

  const remove = async () => {
    if (!confirm(`Delete the project "${p.title}"? Its payments are deleted too; its expenses stay but are unlinked.`)) return;
    try { await api.del(`/accounting/projects/${p.id}`); qc.invalidateQueries({ queryKey: ['acct-projects'] }); toast.success('Project deleted'); nav('/accounting/projects'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const removePayment = async (pid: string) => {
    if (!confirm('Remove this payment?')) return;
    try { await api.del(`/accounting/project-payments/${pid}`); refresh(); toast.success('Payment removed'); } catch (e) { toast.error(errMsg(e)); }
  };
  const newInvoice = () => nav(`/accounting/invoices/new?projectId=${p.id}&clientId=${p.client.id}`);

  return (
    <div className="space-y-4">
      <Link to="/accounting/projects" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Clients & Projects</Link>
      <PageHeader title={p.title} subtitle={<><Link to={`/clients/${p.client.id}`} className="font-medium text-indigo-700 hover:underline">{p.client.name}</Link> · <Link to={`/accounting/client-analysis/${p.client.id}`} className="text-indigo-600 hover:underline">client analysis</Link> · <Badge className={STAGES[s].color}>{STAGES[s].label}</Badge></>}
        actions={<>
          <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={remove}><Trash2 className="h-4 w-4" />Delete</Button>
          <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" />Edit</Button>
          <Button variant="secondary" onClick={newInvoice}><FilePlus2 className="h-4 w-4" />New invoice</Button>
          <Button variant="secondary" onClick={() => setAddingExpense(true)}><Receipt className="h-4 w-4" />Add expense</Button>
          <Button onClick={() => setPaying(true)}><Plus className="h-4 w-4" />Record payment</Button>
        </>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Quoted" value={p.quotedAmount != null ? rupees(p.quotedAmount) : '—'} sub={p.invoiced ? `Invoiced ${rupees(p.invoiced)}` : undefined} />
        <StatCard label="Received" value={rupees(p.received)} tone="good" sub={p.lastPayment ? `Last on ${dayLabel(p.lastPayment)}` : 'Nothing received yet'} />
        <StatCard label="Balance due" value={rupees(p.balance)} tone={p.balance ? 'warn' : 'default'} />
        <StatCard label="Spent" value={rupees(p.spent)} sub="Approved & paid expenses" />
        <StatCard label="Profit" value={rupees(p.profit)} tone={p.profit < 0 ? 'bad' : 'good'} sub="Received − spent" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details">
          <dl className="space-y-2 p-4 text-sm">
            {[
              ['Meeting with client', dayLabel(p.meetingDate)],
              ['Shoot', p.shootStart ? `${dayLabel(p.shootStart)}${p.shootEnd && p.shootEnd !== p.shootStart ? ` – ${dayLabel(p.shootEnd)}` : ''}` : '—'],
              ['Status', PROJECT_STATUS[p.status].label],
              ['Contact', [p.client.contactName, p.client.phone, p.client.email].filter(Boolean).join(' · ') || '—'],
              ['Added by', `${p.createdBy.fullName} on ${dayLabel(p.createdAt)}`],
            ].map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-right text-slate-900">{v}</dd></div>)}
            {p.notes && <p className="whitespace-pre-line border-t border-slate-100 pt-2 text-slate-700">{p.notes}</p>}
          </dl>
        </Card>
        <Card title="Payments received" className="lg:col-span-2">
          {!p.payments.length && !p.invoices.some((i) => i.payments.length) ? <p className="p-4 text-sm text-slate-500">No payments received yet.</p> : (
            <Table>
              <thead><tr><Th>Date</Th><Th>From</Th><Th>Method</Th><Th>Note</Th><Th className="text-right">Amount</Th><Th /></tr></thead>
              <tbody>
                {[
                  ...p.payments.map((x) => ({ ...x, from: 'Direct', invoice: null as null | { id: string; number: string } })),
                  ...p.invoices.filter((i) => !i.cancelled).flatMap((i) => i.payments.map((x) => ({ ...x, from: `Invoice ${i.number}`, invoice: { id: i.id, number: i.number } }))),
                ].sort((a, b) => a.paidOn.localeCompare(b.paidOn)).map((x) => (
                  <tr key={x.id}>
                    <Td className="whitespace-nowrap">{dayLabel(x.paidOn)}</Td>
                    <Td>{x.invoice ? <Link to={`/accounting/invoices/${x.invoice.id}`} className="text-indigo-700 hover:underline">{x.from}</Link> : x.from}</Td>
                    <Td>{METHODS[x.method]}</Td><Td className="text-slate-600">{x.note ?? ''}</Td>
                    <Td className="text-right font-medium tabular-nums">{rupees(x.amount)}</Td>
                    <Td className="text-right">{!x.invoice && <button onClick={() => removePayment(x.id)} className="rounded p-1 text-slate-400 hover:text-rose-600" aria-label="Remove payment"><Trash2 className="h-4 w-4" /></button>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Card title={`Invoices (${p.invoices.length})`} actions={<Button size="sm" variant="secondary" onClick={newInvoice}><Plus className="h-3.5 w-3.5" />New invoice</Button>}>
        {!p.invoices.length ? <p className="p-4 text-sm text-slate-500">No invoices for this project yet.</p> : (
          <Table>
            <thead><tr><Th>Number</Th><Th>Date</Th><Th className="text-right">Total</Th><Th className="text-right">Balance</Th><Th>Status</Th></tr></thead>
            <tbody>{p.invoices.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <Td><Link to={`/accounting/invoices/${i.id}`} className="font-mono font-medium text-indigo-700 hover:underline">{i.number}</Link></Td>
                <Td>{dayLabel(i.date)}</Td><Td className="text-right tabular-nums">{rupees(i.total)}</Td><Td className="text-right tabular-nums">{rupees(i.balance)}</Td>
                <Td><Badge className={INVOICE_STATUS[i.status].color}>{INVOICE_STATUS[i.status].label}</Badge></Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card title={`Expenses (${p.expenses.length})`} actions={<div className="flex items-center gap-3">
          <Link to={`/accounting/expenses?projectId=${p.id}`} className="text-sm text-indigo-600 hover:underline">Open in Expenses</Link>
          <Button size="sm" variant="secondary" onClick={() => setAddingExpense(true)}><Plus className="h-3.5 w-3.5" />Add expense</Button>
        </div>}>
        {!p.expenses.length ? <p className="p-4 text-sm text-slate-500">No expenses for this project yet.</p>
          : <ExpenseTable items={p.expenses} manager onOpen={setExpense} />}
      </Card>

      {editing && <ProjectModal project={p} onClose={() => setEditing(false)} onSaved={() => refresh()} />}
      {paying && <PaymentModal title="Record payment received" onClose={() => setPaying(false)}
        onSave={async (b) => { await api.post(`/accounting/projects/${p.id}/payments`, b); refresh(); toast.success('Payment recorded'); }} />}
      {expense && <ExpenseModal expense={expense} onClose={() => setExpense(null)} onSaved={refresh} />}
      {addingExpense && <ExpenseModal expense={null} defaults={{ projectId: p.id, clientId: p.client.id }} onClose={() => setAddingExpense(false)} onSaved={refresh} />}
    </div>
  );
}
