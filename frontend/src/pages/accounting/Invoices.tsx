import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import { ArrowLeft, Ban, FileText, Plus, Printer, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { amountInWords } from '../../lib/money';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, StatCard, Table, Td, Textarea, Th } from '../../components/ui';
import {
  AccountingGate, ClientDetails, dayLabel, Invoice, INVOICE_STATUS, InvoiceItem, InvoiceStatus, METHODS, rupees, Settings, todayIso, useLookups, useSettings,
} from './shared';
import { PaymentModal } from './Projects';

const GST_RATES = [0, 5, 12, 18, 28];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const inr2 = (n: number) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Same maths as the server: CGST + SGST inside the company's state, IGST for a client GSTIN from another state. */
function totals(items: InvoiceItem[], discount: number, gstRate: number, gstin: string, stateCode: string, paid: number) {
  const subtotal = r2(items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0));
  const disc = Math.min(subtotal, Math.max(0, r2(discount || 0)));
  const taxable = r2(subtotal - disc);
  const st = gstin.trim().slice(0, 2);
  const igst = /^\d{2}$/.test(st) && st !== stateCode;
  const half = igst ? 0 : r2((taxable * gstRate) / 200);
  const igstAmt = igst ? r2((taxable * gstRate) / 100) : 0;
  const total = r2(taxable + half * 2 + igstAmt);
  return { subtotal, discount: disc, taxable, split: igst ? 'igst' as const : 'cgst_sgst' as const, cgst: half, sgst: half, igst: igstAmt, gst: r2(half * 2 + igstAmt), total, paid, balance: r2(Math.max(0, total - paid)) };
}

export default function Invoices() {
  return <AccountingGate><InvoicesPage /></AccountingGate>;
}

function InvoicesPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const q = useQuery({ queryKey: ['acct-invoices', search, status], queryFn: () => api.get<Invoice[]>('/accounting/invoices', { search, status }) });
  const all = useQuery({ queryKey: ['acct-invoices', '', ''], queryFn: () => api.get<Invoice[]>('/accounting/invoices'), enabled: !!(search || status) });
  const base = (search || status ? all.data : q.data) ?? [];
  const live = base.filter((i) => !i.cancelled);
  const list = q.data ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Invoices" subtitle="Bill clients with GST and track payments. Make one from a quotation with “Create invoice” on the quotation."
        actions={<Link to="/accounting/invoices/new"><Button><Plus className="h-4 w-4" />New invoice</Button></Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Invoiced" value={rupees(live.reduce((a, i) => a + i.total, 0))} sub={`${live.length} invoice${live.length === 1 ? '' : 's'}`} />
        <StatCard label="Received" value={rupees(live.reduce((a, i) => a + i.paid, 0))} tone="good" />
        <StatCard label="Outstanding" value={rupees(live.reduce((a, i) => a + i.balance, 0))} tone="warn" onClick={() => setStatus('unpaid')} />
        <StatCard label="Overdue" value={rupees(live.filter((i) => i.status === 'overdue').reduce((a, i) => a + i.balance, 0))} tone="bad" sub={`${live.filter((i) => i.status === 'overdue').length} past the due date`} onClick={() => setStatus('overdue')} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number or client…" className="w-64" aria-label="Search" />
        <Select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className="w-40" aria-label="Status">
          <option value="">All invoices</option>
          {(Object.keys(INVOICE_STATUS) as InvoiceStatus[]).map((s) => <option key={s} value={s}>{INVOICE_STATUS[s].label}</option>)}
        </Select>
      </div>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !list.length ? (
          <Empty title={search || status ? 'No invoices match' : 'No invoices yet'} icon={<FileText className="h-9 w-9" />}>
            <Link to="/accounting/invoices/new"><Button className="mt-3"><Plus className="h-4 w-4" />New invoice</Button></Link>
          </Empty>
        ) : (
          <Table>
            <thead><tr><Th>Number</Th><Th>Client</Th><Th>Date</Th><Th>Due</Th><Th className="text-right">Total</Th><Th className="text-right">Received</Th><Th className="text-right">Balance</Th><Th>Status</Th></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className={clsx('hover:bg-slate-50', i.cancelled && 'opacity-60')}>
                  <Td><Link to={`/accounting/invoices/${i.id}`} className="font-mono font-medium text-indigo-700 hover:underline">{i.number}</Link></Td>
                  <Td><Link to={`/accounting/invoices/${i.id}`} className="font-medium text-slate-900 hover:underline">{i.clientName}</Link>{i.project && <p className="text-xs text-slate-500">{i.project.title}</p>}</Td>
                  <Td className="whitespace-nowrap">{dayLabel(i.date)}</Td>
                  <Td className="whitespace-nowrap">{dayLabel(i.dueDate)}</Td>
                  <Td className="text-right tabular-nums">{rupees(i.total)}</Td>
                  <Td className="text-right tabular-nums">{rupees(i.paid)}</Td>
                  <Td className="text-right font-medium tabular-nums">{rupees(i.balance)}</Td>
                  <Td><Badge className={INVOICE_STATUS[i.status].color}>{INVOICE_STATUS[i.status].label}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ───────────────────────── Editor ─────────────────────────

interface Form {
  number: string; date: string; dueDate: string; clientId: string; clientName: string; details: ClientDetails;
  items: { description: string; qty: string; rate: string }[]; discount: string; gstRate: number; notes: string; terms: string; preparedBy: string; projectId: string;
}
const NO_DETAILS: ClientDetails = { contactPerson: '', phone: '', email: '', gstin: '', address: '' };
const toForm = (i: Invoice): Form => ({
  number: i.number, date: i.date, dueDate: i.dueDate ?? '', clientId: i.clientId ?? '', clientName: i.clientName,
  details: { ...NO_DETAILS, ...i.clientDetails },
  items: i.items.map((x) => ({ description: x.description, qty: String(x.qty), rate: String(x.rate) })), discount: i.discount ? String(i.discount) : '',
  gstRate: i.gstRate, notes: i.notes ?? '', terms: i.terms.join('\n'), preparedBy: i.preparedBy ?? '', projectId: i.projectId ?? '',
});
const toBody = (f: Form) => ({
  number: f.number.trim() || undefined, date: f.date, dueDate: f.dueDate || null, clientId: f.clientId || null, clientName: f.clientName.trim(),
  clientDetails: { ...f.details, gstin: f.details.gstin.trim().toUpperCase() },
  items: f.items.filter((i) => i.description.trim() || Number(i.rate)).map((i) => ({ description: i.description.trim() || 'Service', qty: Number(i.qty) || 0, rate: r2(Number(i.rate) || 0) })),
  discount: r2(Number(f.discount) || 0), gstRate: Number(f.gstRate), notes: f.notes.trim() || null,
  terms: f.terms.split('\n').map((t) => t.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean), preparedBy: f.preparedBy.trim() || null, projectId: f.projectId || null,
});
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return format(d, 'yyyy-MM-dd'); };

export function InvoicePage() {
  return <AccountingGate><InvoiceEditor /></AccountingGate>;
}

function InvoiceEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const settings = useSettings();
  const lookups = useLookups();
  const existing = useQuery({ queryKey: ['acct-invoice', id], queryFn: () => api.get<Invoice>(`/accounting/invoices/${id}`), enabled: !isNew });
  const next = useQuery({ queryKey: ['acct-invoice-next'], queryFn: () => api.get<{ number: string }>('/accounting/invoices/next-number'), enabled: isNew });
  const clients = useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<{ id: string; name: string }[]>('/clients/directory'), staleTime: 60_000 });
  const [f, setF] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [paying, setPaying] = useState(false);

  const fillClient = async (clientId: string, base: Form): Promise<Form> => {
    const name = clients.data?.find((c) => c.id === clientId)?.name ?? base.clientName;
    try {
      const c = await api.get<{ name: string; contactName: string | null; phone: string | null; email: string | null }>(`/clients/${clientId}`);
      return { ...base, clientId, clientName: c.name, details: { ...base.details, contactPerson: c.contactName ?? '', phone: c.phone ?? '', email: c.email ?? '' } };
    } catch { return { ...base, clientId, clientName: name }; }
  };

  useEffect(() => {
    if (!isNew && existing.data && !f) setF(toForm(existing.data));
    if (isNew && next.data && settings.data && !f) {
      const date = todayIso();
      const blank: Form = {
        number: next.data.number, date, dueDate: addDays(date, settings.data.invoiceDueDays), clientId: '', clientName: '',
        details: { contactPerson: '', phone: '', email: '', gstin: '', address: '' }, items: [{ description: '', qty: '1', rate: '' }],
        discount: '', gstRate: 18, notes: '', terms: settings.data.invoiceTerms.join('\n'), preparedBy: me?.fullName ?? '', projectId: params.get('projectId') ?? '',
      };
      const cid = params.get('clientId');
      if (cid) fillClient(cid, blank).then(setF); else setF(blank);
    }
  }, [existing.data, next.data, settings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => (f ? toBody(f) : null), [f]);
  if ((!isNew && existing.isLoading) || !f || !body || !settings.data) return existing.error ? <ErrorBox error={existing.error} /> : <Spinner />;
  const inv = existing.data;
  const paid = inv?.paid ?? 0;
  const t = totals(body.items, body.discount, body.gstRate, body.clientDetails.gstin, settings.data.stateCode, paid);
  const set = (c: Partial<Form>) => setF({ ...f, ...c });
  const setItem = (i: number, c: Partial<Form['items'][number]>) => set({ items: f.items.map((it, j) => (j === i ? { ...it, ...c } : it)) });
  const projects = (lookups.data?.projects ?? []).filter((p) => !f.clientId || p.clientName === f.clientName || p.id === f.projectId);
  const dirty = !inv || JSON.stringify(toBody(toForm(inv))) !== JSON.stringify(body);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-invoices'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); qc.invalidateQueries({ queryKey: ['acct-projects'] }); qc.invalidateQueries({ queryKey: ['acct-project'] }); };

  const save = async (): Promise<Invoice | null> => {
    if (body.clientName.length < 2) { toast.error('Add the client / business name'); return null; }
    if (!body.items.length) { toast.error('Add at least one item'); return null; }
    if (body.clientDetails.gstin && !/^[0-9A-Z]{15}$/.test(body.clientDetails.gstin)) { toast.error('Client GSTIN is 15 letters and numbers'); return null; }
    setSaving(true);
    try {
      const saved = isNew ? await api.post<Invoice>('/accounting/invoices', body) : await api.patch<Invoice>(`/accounting/invoices/${id}`, body);
      refresh(); qc.invalidateQueries({ queryKey: ['acct-invoice-next'] }); qc.setQueryData(['acct-invoice', saved.id], saved);
      toast.success(isNew ? `Invoice ${saved.number} saved` : 'Saved');
      if (isNew) nav(`/accounting/invoices/${saved.id}`, { replace: true }); else setF(toForm(saved));
      return saved;
    } catch (e) { toast.error(errMsg(e)); return null; } finally { setSaving(false); }
  };
  const print = async () => { if (dirty && !(await save())) return; setTimeout(() => window.print(), 150); };
  const setCancelled = async (cancelled: boolean) => {
    if (cancelled && !confirm(`Cancel invoice ${f.number}? It stays on record but no longer counts as due.`)) return;
    try { const s = await api.patch<Invoice>(`/accounting/invoices/${id}`, { cancelled }); qc.setQueryData(['acct-invoice', id], s); refresh(); toast.success(cancelled ? 'Invoice cancelled' : 'Invoice restored'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => {
    if (!confirm(`Delete invoice ${f.number}? This cannot be undone.`)) return;
    try { await api.del(`/accounting/invoices/${id}`); refresh(); toast.success('Deleted'); nav('/accounting/invoices'); } catch (e) { toast.error(errMsg(e)); }
  };
  const removePayment = async (pid: string) => {
    if (!confirm('Remove this payment?')) return;
    try { const s = await api.del<Invoice>(`/accounting/invoice-payments/${pid}`); qc.setQueryData(['acct-invoice', id], s); refresh(); toast.success('Payment removed'); }
    catch (e) { toast.error(errMsg(e)); }
  };

  const sheet: SheetInvoice = { ...body, number: f.number, date: f.date, dueDate: f.dueDate || null, payments: inv?.payments ?? [], cancelled: !!inv?.cancelled, ...t };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to="/accounting/invoices" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Invoices</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">{isNew ? 'New invoice' : f.number}</h1>
        {inv && <Badge className={INVOICE_STATUS[inv.status].color}>{INVOICE_STATUS[inv.status].label}</Badge>}
        {inv?.quotation && <span className="text-xs text-slate-500">from quotation <Link to={`/quotations/${inv.quotation.id}`} className="text-indigo-600 hover:underline">{inv.quotation.number}</Link></span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {inv && !inv.payments.length && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={remove}><Trash2 className="h-4 w-4" />Delete</Button>}
          {inv && (inv.cancelled
            ? <Button variant="secondary" onClick={() => setCancelled(false)}><RotateCcw className="h-4 w-4" />Restore</Button>
            : <Button variant="secondary" onClick={() => setCancelled(true)}><Ban className="h-4 w-4" />Cancel invoice</Button>)}
          <Button variant="secondary" onClick={print}><Printer className="h-4 w-4" />Print / Save PDF</Button>
          <Button loading={saving} onClick={save}><Save className="h-4 w-4" />Save</Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <div className="space-y-4 print:hidden">
          <Card>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Invoice No."><Input value={f.number} onChange={(e) => set({ number: e.target.value })} /></Field>
                <Field label="Invoice date"><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
                <Field label="Due date"><Input type="date" value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field>
                <Field label="GST rate">
                  <Select value={f.gstRate} onChange={(e) => set({ gstRate: Number(e.target.value) })}>
                    {[...new Set([...GST_RATES, f.gstRate])].sort((a, b) => a - b).map((r) => <option key={r} value={r}>{r ? `${r}%` : 'No GST'}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="CRM client" hint="Fills in the name and contact details.">
                <Select value={f.clientId} onChange={async (e) => setF(e.target.value ? await fillClient(e.target.value, f) : { ...f, clientId: '' })}>
                  <option value="">Not linked</option>
                  {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Client / business name"><Input value={f.clientName} onChange={(e) => set({ clientName: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Contact person"><Input value={f.details.contactPerson} onChange={(e) => set({ details: { ...f.details, contactPerson: e.target.value } })} /></Field>
                <Field label="Phone"><Input value={f.details.phone} onChange={(e) => set({ details: { ...f.details, phone: e.target.value } })} /></Field>
                <Field label="Email"><Input type="email" value={f.details.email} onChange={(e) => set({ details: { ...f.details, email: e.target.value } })} /></Field>
                <Field label="Client GSTIN" hint={t.split === 'igst' ? 'Other state: IGST applies.' : undefined}><Input value={f.details.gstin} maxLength={15} onChange={(e) => set({ details: { ...f.details, gstin: e.target.value.toUpperCase() } })} /></Field>
              </div>
              <Field label="Billing address"><Textarea rows={2} value={f.details.address} onChange={(e) => set({ details: { ...f.details, address: e.target.value } })} /></Field>
              <Field label="Client project (optional)">
                <Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}>
                  <option value="">Not linked</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.clientName} · {p.title}</option>)}
                  {inv?.project && !projects.some((p) => p.id === inv.project!.id) && <option value={inv.project.id}>{inv.project.title}</option>}
                </Select>
              </Field>

              <div>
                <p className="mb-1 text-sm font-semibold text-slate-800">Items</p>
                <div className="space-y-2">
                  {f.items.map((it, i) => (
                    <div key={i} className="space-y-2 rounded-xl border border-slate-200 p-2.5">
                      <div className="flex items-start gap-2">
                        <span className="pt-2 text-xs font-semibold text-slate-400">{i + 1}</span>
                        <Textarea rows={2} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="Service / description" aria-label={`Item ${i + 1} description`} />
                        {f.items.length > 1 && <button onClick={() => set({ items: f.items.filter((_, j) => j !== i) })} className="mt-1.5 rounded p-1 text-slate-400 hover:text-rose-600" aria-label={`Remove item ${i + 1}`}><X className="h-4 w-4" /></button>}
                      </div>
                      <div className="grid grid-cols-3 gap-2 pl-4">
                        <Input type="number" min={0} step="1" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} placeholder="Qty" aria-label={`Item ${i + 1} quantity`} />
                        <Input type="number" min={0} step="0.01" value={it.rate} onChange={(e) => setItem(i, { rate: e.target.value })} placeholder="Rate ₹" aria-label={`Item ${i + 1} rate`} />
                        <p className="self-center text-right text-sm tabular-nums text-slate-600">{inr2((Number(it.qty) || 0) * (Number(it.rate) || 0))}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => set({ items: [...f.items, { description: '', qty: '1', rate: '' }] })}><Plus className="h-3.5 w-3.5" />Add item</Button>
              </div>
              <Field label="Discount (₹)"><Input type="number" min={0} step="0.01" value={f.discount} onChange={(e) => set({ discount: e.target.value })} className="w-40" /></Field>
              <Field label="Payment terms / notes" hint="Printed above the terms, e.g. 50% advance, balance on delivery."><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
              <Field label="Terms & conditions" hint="One per line. Defaults are set in Accounting → Settings."><Textarea rows={6} value={f.terms} onChange={(e) => set({ terms: e.target.value })} /></Field>
              <Field label="Prepared by"><Input value={f.preparedBy} onChange={(e) => set({ preparedBy: e.target.value })} /></Field>
            </div>
          </Card>

          {inv && (
            <Card title="Payments received" actions={!inv.cancelled && inv.balance > 0 && <Button size="sm" onClick={() => setPaying(true)}><Plus className="h-3.5 w-3.5" />Record payment</Button>}>
              {!inv.payments.length ? <p className="p-4 text-sm text-slate-500">No payments yet. Balance due {rupees(inv.balance)}.</p> : (
                <ul className="divide-y divide-slate-100">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-24 text-slate-600">{dayLabel(p.paidOn)}</span>
                      <span className="flex-1 text-slate-600">{METHODS[p.method]}{p.note ? ` · ${p.note}` : ''}</span>
                      <span className="font-medium tabular-nums">{rupees(p.amount)}</span>
                      <button onClick={() => removePayment(p.id)} className="rounded p-1 text-slate-400 hover:text-rose-600" aria-label="Remove payment"><Trash2 className="h-4 w-4" /></button>
                    </li>
                  ))}
                  <li className="flex justify-between px-4 py-2.5 text-sm font-semibold"><span>Balance due</span><span className="tabular-nums">{rupees(inv.balance)}</span></li>
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="overflow-x-auto print:overflow-visible"><InvoiceSheet inv={sheet} s={settings.data} /></div>
      </div>

      {paying && inv && <PaymentModal title={`Payment for ${inv.number}`} max={inv.balance} onClose={() => setPaying(false)}
        onSave={async (b) => { const s = await api.post<Invoice>(`/accounting/invoices/${inv.id}/payments`, b); qc.setQueryData(['acct-invoice', id], s); refresh(); toast.success('Payment recorded'); }} />}
    </div>
  );
}

// ───────────────────────── The printed invoice ─────────────────────────

type SheetInvoice = ReturnType<typeof toBody> & ReturnType<typeof totals> & { number: string; date: string; dueDate: string | null; payments: Invoice['payments']; cancelled: boolean };
const NAVY = 'bg-[#13213a] text-white';
const GREY = 'bg-[#e8e9eb]';
const cell = 'border border-slate-500 px-2 py-1';
const sheetDate = (s?: string | null) => (s ? format(new Date(`${s}T12:00:00`), 'dd-MMM-yy') : '—');

/** Prisim's invoice, in the same style as the quotation. This element alone prints (A4). */
export function InvoiceSheet({ inv, s }: { inv: SheetInvoice; s: Settings }) {
  const rate = inv.gstRate;
  const half = Number.isInteger(rate / 2) ? String(rate / 2) : (rate / 2).toFixed(2);
  const bank = s.bank;
  const hasBank = !!(bank.accountNumber || bank.upiId);
  return (
    <div id="invoice-sheet" className="relative mx-auto w-full max-w-[794px] bg-white text-[13px] leading-snug text-slate-900 shadow-card print:w-full print:shadow-none" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
      {inv.cancelled && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="-rotate-12 rounded border-4 border-rose-500/60 px-6 py-2 text-5xl font-bold text-rose-500/60">CANCELLED</span></div>}
      <div className="border-2 border-[#2f5d50]">
        <div className="flex items-center gap-3 border-b-2 border-[#b8955a] px-4 py-3">
          <img src="/prisim-logo-dark.png" alt="Prisim" className="h-12 w-auto" />
          <div className="flex-1 text-center">
            <h1 className="text-3xl font-bold tracking-wide text-[#13213a]">{s.gstin ? 'TAX INVOICE' : 'INVOICE'}</h1>
          </div>
          <div className="w-28 text-right text-[11px] leading-tight text-slate-600">{s.gstin && <>GSTIN<br /><span className="font-semibold text-slate-900">{s.gstin}</span></>}</div>
        </div>
        <div className="px-4 py-2 text-center text-[11px] leading-tight text-slate-700">
          <p className="font-bold text-slate-900">{s.companyName}</p>
          {s.tagline && <p>{s.tagline}</p>}
          <p>{s.address}</p>
          <p>{[s.phone && `Ph: ${s.phone}`, s.email, s.website].filter(Boolean).join('  |  ')}</p>
        </div>
        <table className="w-full border-collapse">
          <tbody>
            <tr>
              <td className={clsx(cell, 'w-[17%] font-bold')}>Invoice No.:</td><td className={clsx(cell, GREY, 'w-[38%]')}>{inv.number}</td>
              <td className={clsx(cell, 'w-[15%] font-bold')}>Date:</td><td className={clsx(cell, GREY)}>{sheetDate(inv.date)}</td>
            </tr>
            <tr>
              <td className={clsx(cell, 'align-top font-bold')} rowSpan={2}>Bill To:</td>
              <td className={clsx(cell, 'align-top')} rowSpan={2}>
                <p className="font-semibold uppercase">{inv.clientName || '—'}</p>
                {inv.clientDetails.contactPerson && <p>Attn: {inv.clientDetails.contactPerson}</p>}
                {inv.clientDetails.address && <p className="whitespace-pre-line">{inv.clientDetails.address}</p>}
                {(inv.clientDetails.phone || inv.clientDetails.email) && <p>{[inv.clientDetails.phone, inv.clientDetails.email].filter(Boolean).join(' · ')}</p>}
                {inv.clientDetails.gstin && <p>GSTIN: {inv.clientDetails.gstin}</p>}
              </td>
              <td className={clsx(cell, 'font-bold')}>Due date:</td><td className={clsx(cell, GREY)}>{sheetDate(inv.dueDate)}</td>
            </tr>
            <tr><td className={clsx(cell, 'font-bold')}>Place of supply:</td><td className={clsx(cell, GREY)}>{inv.split === 'igst' ? `State ${inv.clientDetails.gstin.slice(0, 2)}` : (s.stateCode === '29' ? 'Karnataka (29)' : `State ${s.stateCode}`)}</td></tr>
          </tbody>
        </table>

        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr className={NAVY}>
              <th className={clsx(cell, 'w-[9%] text-center font-semibold')}>S.NO.</th>
              <th className={clsx(cell, 'text-center font-semibold')}>DESCRIPTION</th>
              <th className={clsx(cell, 'w-[9%] text-center font-semibold')}>QTY</th>
              <th className={clsx(cell, 'w-[15%] text-center font-semibold')}>RATE</th>
              <th className={clsx(cell, 'w-[16%] text-center font-semibold')}>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map((it, i) => (
              <tr key={i} className={GREY}>
                <td className={clsx(cell, 'text-center align-top')}>{String(i + 1).padStart(2, '0')}</td>
                <td className={clsx(cell, 'whitespace-pre-line')}>{it.description}</td>
                <td className={clsx(cell, 'text-center align-top')}>{it.qty}</td>
                <td className={clsx(cell, 'text-right align-top tabular-nums')}>{inr2(it.rate)}</td>
                <td className={clsx(cell, 'text-right align-top tabular-nums')}>{inr2(r2(it.qty * it.rate))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="w-full border-collapse">
          <tbody>
            {[
              ['Subtotal', inv.subtotal, true],
              ['Discount', -inv.discount, inv.discount > 0],
              ['Taxable value', inv.taxable, inv.discount > 0],
              [`CGST @ ${half}%`, inv.cgst, inv.split === 'cgst_sgst' && rate > 0],
              [`SGST @ ${half}%`, inv.sgst, inv.split === 'cgst_sgst' && rate > 0],
              [`IGST @ ${rate}%`, inv.igst, inv.split === 'igst' && rate > 0],
            ].filter((r) => r[2]).map(([label, v]) => (
              <tr key={String(label)} className={GREY}><td className="border-x border-slate-500 px-2 py-0.5 text-right text-slate-600">{label}</td><td className={clsx(cell, 'w-[16%] text-right font-bold tabular-nums')}>{(v as number) < 0 ? `− ${inr2(-(v as number))}` : inr2(v as number)}</td></tr>
            ))}
            <tr className={NAVY}><td className="border border-slate-500 px-2 py-1 text-base font-bold">GRAND TOTAL</td><td className="border border-slate-500 px-2 py-1 text-right text-base font-bold tabular-nums">{inr2(inv.total)}</td></tr>
          </tbody>
        </table>
        <p className="border-x border-b border-slate-500 px-2 py-1 font-bold italic">Amount in words: {amountInWords(inv.total)}</p>

        {inv.payments.length > 0 && (
          <table className="w-full border-collapse">
            <tbody>
              {inv.payments.map((p, i) => (
                <tr key={p.id}><td className="border-x border-slate-500 px-2 py-0.5 text-right text-slate-600">{p.note || (i === 0 ? 'Advance received' : 'Payment received')} on {sheetDate(p.paidOn)} ({METHODS[p.method]})</td><td className={clsx(cell, 'w-[16%] text-right tabular-nums')}>{inr2(p.amount)}</td></tr>
              ))}
              <tr className={GREY}><td className="border border-slate-500 px-2 py-1 text-right font-bold">{inv.balance > 0 ? 'BALANCE DUE' : 'FULLY PAID'}</td><td className={clsx(cell, 'w-[16%] text-right font-bold tabular-nums')}>{inr2(inv.balance)}</td></tr>
            </tbody>
          </table>
        )}

        {inv.notes && <p className="whitespace-pre-line border-x border-b border-slate-500 px-2 py-1.5"><span className="font-bold">Payment terms: </span>{inv.notes}</p>}

        {hasBank && (
          <div className="border-x border-b border-slate-500 px-2 py-1.5 text-[12px]">
            <p className="font-bold uppercase">Bank details</p>
            <p>{[bank.accountName && `A/c name: ${bank.accountName}`, bank.accountNumber && `A/c no.: ${bank.accountNumber}`].filter(Boolean).join('   |   ')}</p>
            <p>{[bank.bankName && `Bank: ${bank.bankName}`, bank.ifsc && `IFSC: ${bank.ifsc}`, bank.upiId && `UPI: ${bank.upiId}`].filter(Boolean).join('   |   ')}</p>
          </div>
        )}

        {inv.terms.length > 0 && (
          <>
            <p className="border-x border-slate-500 px-2 pt-2 font-bold uppercase">Terms & conditions</p>
            <div className="border-x border-slate-500">
              {inv.terms.map((t, i) => <p key={i} className={clsx('border-t border-slate-300 px-2 py-1 text-[12px]', GREY)}>{i + 1}. {t}</p>)}
            </div>
          </>
        )}

        <div className="grid grid-cols-2 border border-slate-500">
          <div className="px-2 py-1">
            <p>Received By</p>
            <p className="uppercase">{inv.clientName}</p>
            <div className="h-9" />
            <p>Customer Signature</p>
          </div>
          <div className="px-2 py-1 text-center">
            <p>For {s.companyName}</p>
            <div className="h-12" />
            <p className="text-right">Authorized Signature{inv.preparedBy ? ` · Prepared by ${inv.preparedBy}` : ''}</p>
          </div>
        </div>
        <p className={clsx('py-1 text-center text-[11px] text-slate-700', GREY)}>{s.companyName}&nbsp; | &nbsp;Thank you for your business</p>
      </div>
    </div>
  );
}
