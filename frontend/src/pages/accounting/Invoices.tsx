import { Fragment, ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import { ArrowLeft, Ban, Download, FileText, Plus, Printer, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { compressInvoiceUpload } from '../../lib/compressUpload';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Table, Tabs, Td, Textarea, Th } from '../../components/ui';
import {
  AccountingGate, ClientDetails, dayLabel, GST_STATES, Invoice, InvoiceExtra, INVOICE_STATUS, InvoiceItem, InvoiceStatus, METHODS, rupees, Settings, ShipTo,
  stateOf, todayIso, useLookups, useSettings,
} from './shared';
import { PaymentModal } from './Projects';

const GST_RATES = [0, 5, 12, 18, 28];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** 40,000.00 — Indian grouping, as on the printed invoice. */
const amt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

interface InvoiceFile {
  /** sizeBytes is what is stored (after compression); originalBytes is what was uploaded. */
  id: string; clientId: string; fileName: string; mimeType: string; sizeBytes: number; originalBytes: number; encoding: string | null; createdAt: string;
}

/** An invoice file as the client-wise list returns it. */
interface ListedInvoiceFile extends InvoiceFile { client: { id: string; name: string; status: string }; uploadedBy: string | null }

/** "1.2 MB" or "1.2 MB (was 3.4 MB)" when compression saved space. */
const storedSize = (f: Pick<InvoiceFile, 'sizeBytes' | 'originalBytes'>) =>
  f.originalBytes > f.sizeBytes ? `${fileSize(f.sizeBytes)} (was ${fileSize(f.originalBytes)})` : fileSize(f.sizeBytes);

/** Same maths as the server: CGST + SGST inside the company's state, IGST for a buyer in another state. */
function totals(items: InvoiceItem[], discount: number, gstRate: number, buyerState: string, stateCode: string, paid: number) {
  const subtotal = r2(items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0));
  const disc = Math.min(subtotal, Math.max(0, r2(discount || 0)));
  const taxable = r2(subtotal - disc);
  const igst = /^\d{2}$/.test(buyerState) && buyerState !== stateCode;
  const half = igst ? 0 : r2((taxable * gstRate) / 200);
  const igstAmt = igst ? r2((taxable * gstRate) / 100) : 0;
  const total = r2(taxable + half * 2 + igstAmt);
  return { subtotal, discount: disc, taxable, split: igst ? 'igst' as const : 'cgst_sgst' as const, cgst: half, sgst: half, igst: igstAmt, gst: r2(half * 2 + igstAmt), total, paid, balance: r2(Math.max(0, total - paid)) };
}

// ── Amount in words, Indian style: "INR Forty Seven Thousand Two Hundred Only" ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n: number) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ');
function words(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  return [crore ? `${words(crore)} Crore` : '', lakh ? `${two(lakh)} Lakh` : '', thousand ? `${two(thousand)} Thousand` : '', rest ? three(rest) : ''].filter(Boolean).join(' ');
}
export function inrWords(amount: number) {
  const rupeesPart = Math.floor(r2(amount));
  const paise = Math.round((r2(amount) - rupeesPart) * 100);
  return `INR ${words(rupeesPart)}${paise ? ` and ${two(paise)} paise` : ''} Only`;
}

export default function Invoices() {
  return <AccountingGate><InvoicesPage /></AccountingGate>;
}

type PageTab = 'invoices' | 'uploaded';

function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const tab: PageTab = params.get('tab') === 'uploaded' ? 'uploaded' : 'invoices';
  const setTab = (t: PageTab) => setParams(t === 'invoices' ? {} : { tab: t }, { replace: true });
  /** Client shown in the Uploaded invoices tab; '' is every client. */
  const [fileClient, setFileClient] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [prepNote, setPrepNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<{ id: string; name: string }[]>('/clients/directory'), staleTime: 60_000 });
  const files = useQuery({ queryKey: ['acct-invoice-files'], queryFn: () => api.get<ListedInvoiceFile[]>('/accounting/invoice-files') });
  const q = useQuery({ queryKey: ['acct-invoices', search, status], queryFn: () => api.get<Invoice[]>('/accounting/invoices', { search, status }) });
  const all = useQuery({ queryKey: ['acct-invoices', '', ''], queryFn: () => api.get<Invoice[]>('/accounting/invoices'), enabled: !!(search || status) });
  const base = (search || status ? all.data : q.data) ?? [];
  const live = base.filter((i) => !i.cancelled);
  const list = q.data ?? [];
  const resetUpload = () => { setUploadOpen(false); setClientId(''); setFile(null); setPrepNote(''); };
  const closeUpload = () => { if (!uploading) resetUpload(); };
  const openUpload = (forClient = '') => { setClientId(forClient); setFile(null); setPrepNote(''); setUploadOpen(true); };
  const chooseFile = async (selected: File | undefined) => {
    setFile(null); setPrepNote('');
    if (!selected) return;
    setCompressing(true);
    try {
      // Any size can be picked; it is shrunk here to 1 MB or less before upload.
      const { file: prepared, originalBytes, method } = await compressInvoiceUpload(selected);
      setFile(prepared);
      const note = method === 'unchanged' ? 'already under 1 MB, sent as it is'
        : method === 'pdf-pages-as-images' ? `compressed from ${fileSize(originalBytes)}; pages saved as images, so the text can't be selected`
        : `compressed from ${fileSize(originalBytes)}`;
      setPrepNote(note);
      toast.success(`Ready: ${fileSize(prepared.size)} (${note})`);
    } catch (e) { toast.error(errMsg(e)); } finally { setCompressing(false); }
  };
  const uploadFile = async () => {
    if (!clientId || !file) return;
    setUploading(true);
    try {
      const saved = await api.upload<InvoiceFile>(`/accounting/invoice-files/${clientId}`, file);
      await qc.invalidateQueries({ queryKey: ['acct-invoice-files'] });
      toast.success(saved.originalBytes > saved.sizeBytes ? `Invoice uploaded · stored as ${storedSize(saved)}` : 'Invoice uploaded');
      // Close the window and show the file under its client.
      resetUpload(); setFileClient(saved.clientId); setTab('uploaded');
    } catch (e) { toast.error(errMsg(e)); } finally { setUploading(false); }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Invoices" subtitle="Tax invoices with GST, and the payments received. Make one from a quotation with “Create invoice” on the quotation."
        actions={<><Button variant="secondary" onClick={() => openUpload(tab === 'uploaded' ? fileClient : '')}><Upload className="h-4 w-4" />Upload invoice</Button><Link to="/accounting/invoices/new"><Button><Plus className="h-4 w-4" />New invoice</Button></Link></>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'invoices', label: 'Invoices' },
        { value: 'uploaded', label: 'Uploaded invoices', count: files.data?.length },
      ]} />
      {tab === 'uploaded' ? <UploadedInvoices files={files} client={fileClient} onClient={setFileClient} onUpload={openUpload} /> : <>
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
      </>}
      <Modal open={uploadOpen} onClose={closeUpload} title="Upload client invoice" footer={<>
        <Button variant="secondary" onClick={closeUpload} disabled={uploading}>Cancel</Button>
        <Button onClick={uploadFile} loading={uploading} disabled={!clientId || !file || compressing}>Upload invoice</Button>
      </>}>
        <Field label="Client">
          <Select value={clientId} onChange={(e) => { setClientId(e.target.value); setFile(null); }}>
            <option value="">Select a client first</option>
            {(clients.data ?? []).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
          </Select>
        </Field>
        <Field label="Invoice file" hint="PDF, PNG, JPG or WebP of any size. It is compressed to 1 MB or less before upload.">
          <Input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" disabled={!clientId || compressing || uploading} onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
        </Field>
        {compressing && <p className="text-sm text-slate-500">Compressing to 1 MB or less… large PDFs can take a few seconds.</p>}
        {file && <p className="text-sm text-slate-600">Ready: {file.name} · {fileSize(file.size)}{prepNote && ` · ${prepNote}`}</p>}
      </Modal>
    </div>
  );
}

// ───────────────────────── Uploaded invoice files, client-wise ─────────────────────────

function UploadedInvoices({ files, client, onClient, onUpload }: {
  files: UseQueryResult<ListedInvoiceFile[]>; client: string; onClient: (id: string) => void; onUpload: (clientId: string) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const all = useMemo(() => files.data ?? [], [files.data]);
  // Clients that have files, A to Z, for the filter.
  const clients = useMemo(() => [...new Map(all.map((f) => [f.client.id, f.client])).values()].sort((a, b) => a.name.localeCompare(b.name)), [all]);
  const shownClient = clients.some((c) => c.id === client) ? client : '';
  const term = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const m = new Map<string, { client: ListedInvoiceFile['client']; files: ListedInvoiceFile[] }>();
    for (const f of all) {
      if (shownClient && f.client.id !== shownClient) continue;
      if (term && !f.fileName.toLowerCase().includes(term) && !f.client.name.toLowerCase().includes(term)) continue;
      const g = m.get(f.client.id) ?? { client: f.client, files: [] };
      g.files.push(f);
      m.set(f.client.id, g);
    }
    return [...m.values()].sort((a, b) => a.client.name.localeCompare(b.client.name));
  }, [all, shownClient, term]);

  const open = async (f: InvoiceFile) => {
    try { window.open(await api.blobUrl(`/accounting/invoice-files/${f.id}/file`), '_blank', 'noopener,noreferrer'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const download = async (f: InvoiceFile) => {
    try {
      const url = await api.blobUrl(`/accounting/invoice-files/${f.id}/file`);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (f: InvoiceFile) => {
    if (!confirm(`Delete ${f.fileName}?`)) return;
    try {
      await api.del(`/accounting/invoice-files/${f.id}`);
      await qc.invalidateQueries({ queryKey: ['acct-invoice-files'] });
      toast.success('Invoice file deleted');
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (files.isLoading) return <Card><Spinner /></Card>;
  if (files.error) return <Card><div className="p-4"><ErrorBox error={files.error} /></div></Card>;
  if (!all.length) return (
    <Card>
      <Empty title="No uploaded invoices yet" icon={<FileText className="h-9 w-9" />}>
        <p className="text-sm text-slate-500">Upload a client&apos;s invoice file and it is listed here under that client.</p>
        <Button className="mt-3" onClick={() => onUpload('')}><Upload className="h-4 w-4" />Upload invoice</Button>
      </Empty>
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Select value={shownClient} onChange={(e) => onClient(e.target.value)} className="w-56" aria-label="Client">
          <option value="">All clients ({clients.length})</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search file or client…" className="w-64" aria-label="Search files" />
      </div>
      {!groups.length ? <Card><Empty title="No files match" icon={<FileText className="h-9 w-9" />} /></Card> : groups.map((g) => (
        <Card key={g.client.id}
          title={<span>{g.client.name} <span className="font-normal text-slate-500">· {g.files.length} file{g.files.length === 1 ? '' : 's'}</span></span>}
          actions={<Button variant="secondary" onClick={() => onUpload(g.client.id)}><Upload className="h-4 w-4" />Upload</Button>}>
          <Table>
            <thead><tr><Th>File</Th><Th>Uploaded</Th><Th>By</Th><Th className="text-right">Size</Th><Th className="text-right"><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {g.files.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50">
                  <Td>
                    <button className="flex max-w-[22rem] items-center gap-2 text-left text-indigo-700 hover:underline" onClick={() => void open(f)} title="Open">
                      <FileText className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate">{f.fileName}</span>
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap">{format(new Date(f.createdAt), 'd MMM yyyy, h:mm a')}</Td>
                  <Td>{f.uploadedBy ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{storedSize(f)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Download" onClick={() => void download(f)}><Download className="h-4 w-4" /></button>
                    <button className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="Delete" onClick={() => void remove(f)}><Trash2 className="h-4 w-4" /></button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

// ───────────────────────── Editor ─────────────────────────

type ItemForm = { description: string; hsn: string; qty: string; unit: string; rate: string };
interface Form {
  number: string; date: string; dueDate: string; clientId: string; clientName: string; details: ClientDetails & { stateCode: string };
  sameShip: boolean; ship: ShipTo; extra: InvoiceExtra;
  items: ItemForm[]; discount: string; gstRate: number; notes: string; terms: string; preparedBy: string; projectId: string;
}
const NO_DETAILS = { contactPerson: '', phone: '', email: '', gstin: '', address: '', stateCode: '' };
const NO_SHIP: ShipTo = { name: '', address: '', gstin: '', stateCode: '' };
const EXTRA_FIELDS: [keyof InvoiceExtra, string][] = [
  ['deliveryNote', 'Delivery Note'], ['referenceNo', 'Reference No. & Date'], ['otherReferences', 'Other References'],
  ['buyerOrderNo', "Buyer's Order No."], ['buyerOrderDate', "Buyer's order dated"], ['dispatchDocNo', 'Dispatch Doc No.'],
  ['deliveryNoteDate', 'Delivery Note Date'], ['dispatchedThrough', 'Dispatched through'], ['destination', 'Destination'], ['termsOfDelivery', 'Terms of Delivery'],
];
const toForm = (i: Invoice): Form => ({
  number: i.number, date: i.date, dueDate: i.dueDate ?? '', clientId: i.clientId ?? '', clientName: i.clientName,
  details: { ...NO_DETAILS, ...i.clientDetails, stateCode: i.clientDetails.stateCode ?? '' },
  sameShip: !i.shipTo, ship: { ...NO_SHIP, ...(i.shipTo ?? {}) }, extra: { ...(i.extra ?? {}) },
  items: i.items.map((x) => ({ description: x.description, hsn: x.hsn ?? '', qty: String(x.qty), unit: x.unit ?? '', rate: String(x.rate) })),
  discount: i.discount ? String(i.discount) : '', gstRate: i.gstRate, notes: i.notes ?? '', terms: i.terms.join('\n'), preparedBy: i.preparedBy ?? '', projectId: i.projectId ?? '',
});
const toBody = (f: Form) => ({
  number: f.number.trim() || undefined, date: f.date, dueDate: f.dueDate || null, clientId: f.clientId || null, clientName: f.clientName.trim(),
  clientDetails: { ...f.details, gstin: f.details.gstin.trim().toUpperCase(), stateCode: stateOf(f.details.gstin, f.details.stateCode) },
  shipTo: f.sameShip || !f.ship.name.trim() ? null : { ...f.ship, name: f.ship.name.trim(), gstin: f.ship.gstin.trim().toUpperCase(), stateCode: stateOf(f.ship.gstin, f.ship.stateCode) },
  extra: Object.fromEntries(Object.entries(f.extra).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v)) as InvoiceExtra,
  items: f.items.filter((i) => i.description.trim() || Number(i.rate)).map((i) => ({
    description: i.description.trim() || 'Service', hsn: i.hsn.trim().toUpperCase(), qty: Number(i.qty) || 0, unit: i.unit.trim(), rate: r2(Number(i.rate) || 0),
  })),
  discount: r2(Number(f.discount) || 0), gstRate: Number(f.gstRate), notes: f.notes.trim() || null,
  terms: f.terms.split('\n').map((t) => t.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean), preparedBy: f.preparedBy.trim() || null, projectId: f.projectId || null,
});
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return format(d, 'yyyy-MM-dd'); };

function StateSelect({ gstin, value, onChange, label }: { gstin: string; value: string; onChange: (v: string) => void; label: string }) {
  const fromGstin = stateOf(gstin);
  return (
    <Field label={label} hint={fromGstin ? 'Taken from the GSTIN.' : undefined}>
      <Select value={fromGstin || value} disabled={!!fromGstin} onChange={(e) => onChange(e.target.value)}>
        <option value="">Same as ours</option>
        {Object.entries(GST_STATES).map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
      </Select>
    </Field>
  );
}

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
  /** Which copies the next print includes: both, or just one so it can be saved as its own PDF. */
  const [printing, setPrinting] = useState<readonly Copy[]>(COPIES);
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
        details: { ...NO_DETAILS }, sameShip: true, ship: { ...NO_SHIP }, extra: {},
        items: [{ description: '', hsn: settings.data.defaultHsn, qty: '1', unit: '', rate: '' }],
        discount: '', gstRate: 18, notes: '', terms: settings.data.invoiceTerms.join('\n'), preparedBy: me?.fullName ?? '', projectId: params.get('projectId') ?? '',
      };
      const cid = params.get('clientId');
      if (cid) fillClient(cid, blank).then(setF); else setF(blank);
    }
  }, [existing.data, next.data, settings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => (f ? toBody(f) : null), [f]);
  if ((!isNew && existing.isLoading) || !f || !body || !settings.data) return existing.error ? <ErrorBox error={existing.error} /> : <Spinner />;
  const inv = existing.data;
  const t = totals(body.items, body.discount, body.gstRate, body.clientDetails.stateCode, settings.data.stateCode, inv?.paid ?? 0);
  const set = (c: Partial<Form>) => setF({ ...f, ...c });
  const setItem = (i: number, c: Partial<ItemForm>) => set({ items: f.items.map((it, j) => (j === i ? { ...it, ...c } : it)) });
  const projects = (lookups.data?.projects ?? []).filter((p) => !f.clientId || p.clientName === f.clientName || p.id === f.projectId);
  const dirty = !inv || JSON.stringify(toBody(toForm(inv))) !== JSON.stringify(body);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-invoices'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); qc.invalidateQueries({ queryKey: ['acct-projects'] }); qc.invalidateQueries({ queryKey: ['acct-project'] }); };

  const save = async (): Promise<Invoice | null> => {
    if (body.clientName.length < 2) { toast.error('Add the buyer name'); return null; }
    if (!body.items.length) { toast.error('Add at least one item'); return null; }
    for (const [who, g] of [['Buyer', body.clientDetails.gstin], ['Consignee', body.shipTo?.gstin ?? '']]) {
      if (g && !/^[0-9A-Z]{15}$/.test(g)) { toast.error(`${who} GSTIN is 15 letters and numbers`); return null; }
    }
    if (!f.sameShip && !f.ship.name.trim()) { toast.error('Add the consignee name, or tick “Same as buyer”'); return null; }
    setSaving(true);
    try {
      const saved = isNew ? await api.post<Invoice>('/accounting/invoices', body) : await api.patch<Invoice>(`/accounting/invoices/${id}`, body);
      refresh(); qc.invalidateQueries({ queryKey: ['acct-invoice-next'] }); qc.setQueryData(['acct-invoice', saved.id], saved);
      toast.success(isNew ? `Invoice ${saved.number} saved` : 'Saved');
      setF(toForm(saved));
      if (isNew) nav(`/accounting/invoices/${saved.id}`, { replace: true });
      return saved;
    } catch (e) { toast.error(errMsg(e)); return null; } finally { setSaving(false); }
  };
  const print = async (copies: readonly Copy[]) => {
    let number = f.number;
    if (dirty) { const saved = await save(); if (!saved) return; number = saved.number; }
    setPrinting(copies);
    // The browser names the saved PDF after the page title, so each copy gets its own file name.
    const title = document.title;
    const name = number || 'Invoice';
    document.title = copies.length === 1 ? `${name} - ${COPY_NAMES[copies[0]]}` : name;
    const restore = () => { document.title = title; setPrinting(COPIES); window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    setTimeout(() => window.print(), 150);
  };
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

  const sheet: SheetInvoice = { ...body, number: f.number, date: f.date, cancelled: !!inv?.cancelled, ...t };

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
          <Button variant="secondary" onClick={() => print(['ORIGINAL FOR RECIPIENT'])} title="Print or save only the original copy, for the client"><Printer className="h-4 w-4" />Original</Button>
          <Button variant="secondary" onClick={() => print(['DUPLICATE FOR SUPPLIER'])} title="Print or save only the duplicate copy, for Prisim's records"><Printer className="h-4 w-4" />Duplicate</Button>
          <Button variant="secondary" onClick={() => print(COPIES)} title="Both copies, one per page"><Printer className="h-4 w-4" />Both copies</Button>
          <Button loading={saving} onClick={save}><Save className="h-4 w-4" />Save</Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <div className="space-y-4 print:hidden">
          <Card>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Invoice No."><Input value={f.number} onChange={(e) => set({ number: e.target.value })} /></Field>
                <Field label="Dated"><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
                <Field label="Payment due by" hint="For tracking; not printed."><Input type="date" value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field>
                <Field label="GST rate">
                  <Select value={f.gstRate} onChange={(e) => set({ gstRate: Number(e.target.value) })}>
                    {[...new Set([...GST_RATES, f.gstRate])].sort((a, b) => a - b).map((r) => <option key={r} value={r}>{r ? `${r}%` : 'No GST'}</option>)}
                  </Select>
                </Field>
              </div>
              <Field label="Mode / terms of payment"><Input value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. 50% advance, balance on delivery" /></Field>

              <p className="pt-1 text-sm font-semibold text-slate-800">Buyer (bill to)</p>
              <Field label="CRM client" hint="Fills in the name and contact details.">
                <Select value={f.clientId} onChange={async (e) => setF(e.target.value ? await fillClient(e.target.value, f) : { ...f, clientId: '' })}>
                  <option value="">Not linked</option>
                  {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Buyer name"><Input value={f.clientName} onChange={(e) => set({ clientName: e.target.value })} placeholder="e.g. Valnovation Technologies Private Limited" /></Field>
              <Field label="Address"><Textarea rows={3} value={f.details.address} onChange={(e) => set({ details: { ...f.details, address: e.target.value } })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="GSTIN/UIN"><Input value={f.details.gstin} maxLength={15} onChange={(e) => set({ details: { ...f.details, gstin: e.target.value.toUpperCase() } })} /></Field>
                <StateSelect label="State" gstin={f.details.gstin} value={f.details.stateCode} onChange={(v) => set({ details: { ...f.details, stateCode: v } })} />
                <Field label="Contact person"><Input value={f.details.contactPerson} onChange={(e) => set({ details: { ...f.details, contactPerson: e.target.value } })} /></Field>
                <Field label="Phone"><Input value={f.details.phone} onChange={(e) => set({ details: { ...f.details, phone: e.target.value } })} /></Field>
              </div>
              {t.split === 'igst' && <p className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">Buyer is in another state, so IGST applies.</p>}

              <label className="flex items-center gap-2 pt-1 text-sm font-semibold text-slate-800">
                <input type="checkbox" checked={f.sameShip} onChange={(e) => set({ sameShip: e.target.checked, ship: e.target.checked ? f.ship : { ...f.ship, name: f.ship.name || f.clientName, address: f.ship.address || f.details.address } })} />
                Consignee (ship to) same as buyer
              </label>
              {!f.sameShip && (
                <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                  <Field label="Consignee name"><Input value={f.ship.name} onChange={(e) => set({ ship: { ...f.ship, name: e.target.value } })} /></Field>
                  <Field label="Address"><Textarea rows={2} value={f.ship.address} onChange={(e) => set({ ship: { ...f.ship, address: e.target.value } })} /></Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="GSTIN/UIN"><Input value={f.ship.gstin} maxLength={15} onChange={(e) => set({ ship: { ...f.ship, gstin: e.target.value.toUpperCase() } })} /></Field>
                    <StateSelect label="State" gstin={f.ship.gstin} value={f.ship.stateCode} onChange={(v) => set({ ship: { ...f.ship, stateCode: v } })} />
                  </div>
                </div>
              )}

              <div>
                <p className="mb-1 pt-1 text-sm font-semibold text-slate-800">Particulars</p>
                <div className="space-y-2">
                  {f.items.map((it, i) => (
                    <div key={i} className="space-y-2 rounded-xl border border-slate-200 p-2.5">
                      <div className="flex items-start gap-2">
                        <span className="pt-2 text-xs font-semibold text-slate-400">{i + 1}</span>
                        <Textarea rows={2} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} placeholder="e.g. Digital Marketing Handling" aria-label={`Item ${i + 1} description`} />
                        {f.items.length > 1 && <button onClick={() => set({ items: f.items.filter((_, j) => j !== i) })} className="mt-1.5 rounded p-1 text-slate-400 hover:text-rose-600" aria-label={`Remove item ${i + 1}`}><X className="h-4 w-4" /></button>}
                      </div>
                      <div className="grid grid-cols-4 gap-2 pl-4">
                        <Input value={it.hsn} onChange={(e) => setItem(i, { hsn: e.target.value })} placeholder="HSN/SAC" aria-label={`Item ${i + 1} HSN/SAC`} title="HSN/SAC" />
                        <Input type="number" min={0} step="1" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} placeholder="Qty" aria-label={`Item ${i + 1} quantity`} title="Quantity" />
                        <Input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder="per (Nos)" aria-label={`Item ${i + 1} unit`} title="Unit (per)" />
                        <Input type="number" min={0} step="0.01" value={it.rate} onChange={(e) => setItem(i, { rate: e.target.value })} placeholder="Rate ₹" aria-label={`Item ${i + 1} rate`} title="Rate" />
                      </div>
                      <p className="pl-4 text-right text-xs tabular-nums text-slate-500">Amount ₹{amt((Number(it.qty) || 0) * (Number(it.rate) || 0))}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-xs text-slate-500">Quantity and rate print only when there's a unit or a quantity other than 1.</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => set({ items: [...f.items, { description: '', hsn: settings.data!.defaultHsn, qty: '1', unit: '', rate: '' }] })}><Plus className="h-3.5 w-3.5" />Add item</Button>
              </div>
              <Field label="Discount (₹)"><Input type="number" min={0} step="0.01" value={f.discount} onChange={(e) => set({ discount: e.target.value })} className="w-40" /></Field>

              <details className="rounded-xl border border-slate-200 px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold text-slate-800">Other details (delivery note, order no., dispatch…)</summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {EXTRA_FIELDS.map(([k, label]) => (
                    <Field key={k} label={label} className={k === 'termsOfDelivery' ? 'col-span-2' : undefined}>
                      <Input value={f.extra[k] ?? ''} onChange={(e) => set({ extra: { ...f.extra, [k]: e.target.value } })} />
                    </Field>
                  ))}
                </div>
              </details>
              <Field label="Declaration / terms (optional)" hint="One per line. Printed beside the signature."><Textarea rows={3} value={f.terms} onChange={(e) => set({ terms: e.target.value })} /></Field>
              <Field label="Client project (optional)">
                <Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}>
                  <option value="">Not linked</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.clientName} · {p.title}</option>)}
                  {inv?.project && !projects.some((p) => p.id === inv.project!.id) && <option value={inv.project.id}>{inv.project.title}</option>}
                </Select>
              </Field>
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

        <div className="overflow-x-auto print:overflow-visible"><InvoiceCopies inv={sheet} s={settings.data} printing={printing} /></div>
      </div>

      {paying && inv && <PaymentModal title={`Payment for ${inv.number}`} max={inv.balance} onClose={() => setPaying(false)}
        onSave={async (b) => { const s = await api.post<Invoice>(`/accounting/invoices/${inv.id}/payments`, b); qc.setQueryData(['acct-invoice', id], s); refresh(); toast.success('Payment recorded'); }} />}
    </div>
  );
}

// ───────────────────────── The printed tax invoice ─────────────────────────

type SheetInvoice = ReturnType<typeof toBody> & ReturnType<typeof totals> & { number: string; date: string; cancelled: boolean };
const sheetDate = (s?: string | null) => (s ? format(new Date(`${s}T12:00:00`), 'd-MMM-yy') : '');
const pctLabel = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));
const B = 'border-black';

/** One labelled box in the header grid: small label, bold value. */
function Box({ label, value, className }: { label: string; value?: ReactNode; className?: string }) {
  return (
    <td className={clsx('border', B, 'px-1 align-top', className)}>
      <p className="text-[10px] leading-tight">{label}</p>
      <p className="min-h-[14px] text-[11px] font-bold leading-tight">{value}</p>
    </td>
  );
}

function Party({ title, name, address, gstin, stateCode, extra }: { title?: string; name: string; address?: string; gstin?: string; stateCode?: string; extra?: ReactNode }) {
  const st = stateOf(gstin, stateCode);
  return (
    <div className="text-[11px] leading-tight">
      {title && <p className="text-[10px]">{title}</p>}
      <p className="font-bold">{name}</p>
      {address && <p className="whitespace-pre-line">{address}</p>}
      <table className="mt-0.5">
        <tbody>
          {gstin && <tr><td className="pr-2">GSTIN/UIN</td><td>: {gstin}</td></tr>}
          {st && <tr><td className="pr-2">State Name</td><td>: {GST_STATES[st] ?? st}, Code : {st}</td></tr>}
        </tbody>
      </table>
      {extra}
    </div>
  );
}

/** The two copies a tax invoice is issued in, each printed on its own A4 page. */
const COPIES = ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR SUPPLIER'] as const;
type Copy = (typeof COPIES)[number];
const COPY_NAMES: Record<Copy, string> = { 'ORIGINAL FOR RECIPIENT': 'Original for Recipient', 'DUPLICATE FOR SUPPLIER': 'Duplicate for Supplier' };

/**
 * Both copies of the invoice, one after the other on screen. This element alone prints:
 * the copies in `printing`, each on its own page.
 */
export function InvoiceCopies({ inv, s, printing = COPIES }: { inv: SheetInvoice; s: Settings; printing?: readonly Copy[] }) {
  return (
    <div id="invoice-sheet" className="space-y-6 print:space-y-0">
      {COPIES.map((copy) => {
        const printed = printing.includes(copy);
        const breakBefore = printed && COPIES.slice(0, COPIES.indexOf(copy)).some((c) => printing.includes(c));
        return <InvoiceSheet key={copy} inv={inv} s={s} copy={copy} className={clsx(!printed && 'print:hidden', breakBefore && 'print:break-before-page')} />;
      })}
    </div>
  );
}

/** Prisim's tax invoice layout: one copy on one A4 page. */
function InvoiceSheet({ inv, s, copy, className }: { inv: SheetInvoice; s: Settings; copy: Copy; className?: string }) {
  const x = inv.extra ?? {};
  const half = pctLabel(inv.gstRate / 2);
  const buyerState = inv.clientDetails.stateCode || s.stateCode;
  const ship = inv.shipTo ?? { name: inv.clientName, address: inv.clientDetails.address, gstin: inv.clientDetails.gstin, stateCode: buyerState };
  const showQty = (it: InvoiceItem) => !!it.unit || Number(it.qty) !== 1;
  // HSN summary: taxable value per HSN/SAC, after spreading any discount across lines.
  const factor = inv.subtotal ? inv.taxable / inv.subtotal : 1;
  const byHsn = new Map<string, number>();
  for (const it of inv.items) byHsn.set(it.hsn || '', (byHsn.get(it.hsn || '') ?? 0) + it.qty * it.rate * factor);
  const hsnRows = [...byHsn.entries()].map(([hsn, v]) => {
    const taxable = r2(v);
    const h = inv.split === 'igst' ? 0 : r2((taxable * inv.gstRate) / 200);
    const ig = inv.split === 'igst' ? r2((taxable * inv.gstRate) / 100) : 0;
    return { hsn, taxable, half: h, igst: ig, tax: r2(h * 2 + ig) };
  });
  const bank = s.bank;
  const hasBank = !!(bank.accountNumber || bank.upiId);
  const cell = clsx('border-x', B, 'px-1');
  const units = new Set(inv.items.map((it) => it.unit ?? ''));
  const qtyTotal = units.size === 1 && [...units][0] ? `${inv.items.reduce((a, it) => a + it.qty, 0)} ${[...units][0]}` : '';

  return (
    <div className={clsx('invoice-copy relative mx-auto w-full max-w-[794px] bg-white px-6 pb-4 pt-5 text-black shadow-card print:w-full print:px-0 print:pt-0 print:shadow-none', className)} style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
      {inv.cancelled && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="-rotate-12 rounded border-4 border-rose-500/60 px-6 py-2 text-5xl font-bold text-rose-500/60">CANCELLED</span></div>}
      <div className="relative mb-0.5 text-center">
        <span className="text-[15px] font-bold">Tax Invoice</span>
        <span className="absolute right-0 top-0.5 text-[10px] italic">({copy})</span>
      </div>

      {/* Header: seller, consignee and buyer on the left; reference boxes on the right */}
      <table className={clsx('w-full table-fixed border-collapse border', B)}>
        <colgroup><col className="w-1/2" /><col className="w-1/4" /><col className="w-1/4" /></colgroup>
        <tbody>
          <tr>
            <td rowSpan={3} className={clsx('border px-1 py-0.5 align-top', B)}>
              <Party name={s.companyName} address={s.address} gstin={s.gstin} stateCode={s.stateCode}
                extra={<>{s.phone && <p>Contact : {s.phone}</p>}{s.email && <p>E-Mail : {s.email}</p>}</>} />
            </td>
            <Box label="Invoice No." value={inv.number} />
            <Box label="Dated" value={sheetDate(inv.date)} />
          </tr>
          <tr><Box label="Delivery Note" value={x.deliveryNote} /><Box label="Mode/Terms of Payment" value={inv.notes} /></tr>
          <tr><Box label="Reference No. & Date." value={x.referenceNo} /><Box label="Other References" value={x.otherReferences} /></tr>
          <tr>
            <td rowSpan={3} className={clsx('border px-1 py-0.5 align-top', B)}>
              <Party title="Consignee (Ship to)" name={ship.name} address={ship.address} gstin={ship.gstin} stateCode={ship.stateCode || buyerState} />
            </td>
            <Box label="Buyer's Order No." value={x.buyerOrderNo} />
            <Box label="Dated" value={x.buyerOrderDate} />
          </tr>
          <tr><Box label="Dispatch Doc No." value={x.dispatchDocNo} /><Box label="Delivery Note Date" value={x.deliveryNoteDate} /></tr>
          <tr><Box label="Dispatched through" value={x.dispatchedThrough} /><Box label="Destination" value={x.destination} /></tr>
          <tr>
            <td className={clsx('border px-1 py-0.5 align-top', B)}>
              <Party title="Buyer (Bill to)" name={inv.clientName || ' '} address={inv.clientDetails.address} gstin={inv.clientDetails.gstin} stateCode={buyerState}
                extra={inv.clientDetails.contactPerson || inv.clientDetails.phone ? <p>Contact : {[inv.clientDetails.contactPerson, inv.clientDetails.phone].filter(Boolean).join(', ')}</p> : null} />
            </td>
            <td colSpan={2} className={clsx('border px-1 align-top', B)}>
              <p className="text-[10px] leading-tight">Terms of Delivery</p>
              <p className="whitespace-pre-line text-[11px] font-bold leading-tight">{x.termsOfDelivery}</p>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Particulars */}
      <table className={clsx('w-full table-fixed border-collapse border border-t-0 text-[11px]', B)}>
        <colgroup>
          <col className="w-[5%]" /><col className="w-[43%]" /><col className="w-[11%]" /><col className="w-[10%]" /><col className="w-[10%]" /><col className="w-[6%]" /><col className="w-[15%]" />
        </colgroup>
        <thead>
          <tr className="text-[10px]">
            {['Sl\nNo.', 'Particulars', 'HSN/SAC', 'Quantity', 'Rate', 'per', 'Amount'].map((h) => <th key={h} className={clsx('whitespace-pre-line border px-1 py-0.5 text-center font-normal', B)}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {inv.items.map((it, i) => (
            <tr key={i} className="align-top">
              <td className={clsx(cell, 'pt-1 text-center')}>{i + 1}</td>
              <td className={clsx(cell, 'whitespace-pre-line pt-1 font-bold')}>{it.description}</td>
              <td className={clsx(cell, 'pt-1')}>{it.hsn}</td>
              <td className={clsx(cell, 'pt-1 text-right font-bold')}>{showQty(it) ? `${it.qty}${it.unit ? ` ${it.unit}` : ''}` : ''}</td>
              <td className={clsx(cell, 'pt-1 text-right')}>{showQty(it) ? amt(it.rate) : ''}</td>
              <td className={clsx(cell, 'pt-1')}>{showQty(it) ? it.unit : ''}</td>
              <td className={clsx(cell, 'pt-1 text-right font-bold')}>{amt(r2(it.qty * it.rate))}</td>
            </tr>
          ))}
          {inv.discount > 0 && (
            <tr><td className={cell} /><td className={clsx(cell, 'text-right font-bold italic')}>Less : Discount</td><td className={cell} /><td className={cell} /><td className={cell} /><td className={cell} /><td className={clsx(cell, 'text-right font-bold')}>(-){amt(inv.discount)}</td></tr>
          )}
          {inv.gstRate > 0 && (inv.split === 'igst'
            ? [['Output IGST', pctLabel(inv.gstRate), inv.igst] as const]
            : [['Output CGST', half, inv.cgst] as const, ['Output SGST', half, inv.sgst] as const]
          ).map(([label, rate, v]) => (
            <tr key={label}>
              <td className={cell} /><td className={clsx(cell, 'text-right font-bold')}>{label} {rate}%</td><td className={cell} /><td className={cell} />
              <td className={clsx(cell, 'text-right')}>{rate}</td><td className={cell}>%</td><td className={clsx(cell, 'text-right font-bold')}>{amt(v)}</td>
            </tr>
          ))}
          {/* Space down to the total, as on the printed form */}
          <tr style={{ height: `${Math.max(60, 300 - inv.items.length * 34)}px` }}>
            {Array.from({ length: 7 }, (_, i) => <td key={i} className={cell} />)}
          </tr>
          <tr className={clsx('border-t', B)}>
            <td className={cell} /><td className={clsx(cell, 'text-right')}>Total</td><td className={cell} />
            <td className={clsx(cell, 'text-right font-bold')}>{qtyTotal}</td>
            <td className={cell} /><td className={cell} />
            <td className={clsx(cell, 'whitespace-nowrap text-right text-[12px] font-bold')}>₹ {amt(inv.total)}</td>
          </tr>
        </tbody>
      </table>

      {/* Amount in words and the tax summary */}
      <div className={clsx('border border-t-0 px-1 text-[11px]', B)}>
        <div className="flex justify-between"><span className="text-[10px]">Amount Chargeable (in words)</span><span className="text-[10px] italic">E. & O.E</span></div>
        <p className="font-bold">{inrWords(inv.total)}</p>
      </div>
      {inv.gstRate > 0 && (
        <table className={clsx('w-full border-collapse border border-t-0 text-[10px]', B)}>
          <thead>
            <tr>
              <th rowSpan={2} className={clsx('border px-1 font-normal', B)}>HSN/SAC</th>
              <th rowSpan={2} className={clsx('border px-1 font-normal', B)}>Taxable<br />Value</th>
              {inv.split === 'igst'
                ? <th colSpan={2} className={clsx('border px-1 font-normal', B)}>Integrated Tax</th>
                : <><th colSpan={2} className={clsx('border px-1 font-normal', B)}>CGST</th><th colSpan={2} className={clsx('border px-1 font-normal', B)}>SGST/UTGST</th></>}
              <th rowSpan={2} className={clsx('border px-1 font-normal', B)}>Total<br />Tax Amount</th>
            </tr>
            <tr>
              {(inv.split === 'igst' ? [0] : [0, 1]).map((k) => <Fragment key={k}><th className={clsx('border px-1 font-normal', B)}>Rate</th><th className={clsx('border px-1 font-normal', B)}>Amount</th></Fragment>)}
            </tr>
          </thead>
          <tbody>
            {hsnRows.map((h) => (
              <tr key={h.hsn}>
                <td className={clsx(cell, 'text-left')}>{h.hsn}</td>
                <td className={clsx(cell, 'text-right')}>{amt(h.taxable)}</td>
                {inv.split === 'igst'
                  ? <><td className={clsx(cell, 'text-right')}>{pctLabel(inv.gstRate)}%</td><td className={clsx(cell, 'text-right')}>{amt(h.igst)}</td></>
                  : <><td className={clsx(cell, 'text-right')}>{half}%</td><td className={clsx(cell, 'text-right')}>{amt(h.half)}</td><td className={clsx(cell, 'text-right')}>{half}%</td><td className={clsx(cell, 'text-right')}>{amt(h.half)}</td></>}
                <td className={clsx(cell, 'text-right')}>{amt(h.tax)}</td>
              </tr>
            ))}
            <tr className={clsx('border-t font-bold', B)}>
              <td className={clsx(cell, 'text-right')}>Total</td>
              <td className={clsx(cell, 'text-right')}>{amt(inv.taxable)}</td>
              {inv.split === 'igst'
                ? <><td className={cell} /><td className={clsx(cell, 'text-right')}>{amt(inv.igst)}</td></>
                : <><td className={cell} /><td className={clsx(cell, 'text-right')}>{amt(inv.cgst)}</td><td className={cell} /><td className={clsx(cell, 'text-right')}>{amt(inv.sgst)}</td></>}
              <td className={clsx(cell, 'text-right')}>{amt(inv.gst)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className={clsx('border border-t-0 px-1 pb-3 pt-0.5 text-[11px]', B)}>
        {inv.gstRate > 0 && <p>Tax Amount (in words) : <span className="font-bold">{inrWords(inv.gst)}</span></p>}
        <div className="mt-2 grid grid-cols-2 gap-4">
          <div className="text-[10px] leading-snug">
            {hasBank && (
              <>
                <p>Company's Bank Details</p>
                {bank.accountName && <p>A/c Holder's Name : <b>{bank.accountName}</b></p>}
                {bank.bankName && <p>Bank Name : <b>{bank.bankName}</b></p>}
                {bank.accountNumber && <p>A/c No. : <b>{bank.accountNumber}</b></p>}
                {bank.ifsc && <p>Branch & IFS Code : <b>{bank.ifsc}</b></p>}
                {bank.upiId && <p>UPI : <b>{bank.upiId}</b></p>}
              </>
            )}
            {inv.terms.length > 0 && (
              <div className={hasBank ? 'mt-1.5' : ''}>
                <p className="underline">Declaration</p>
                {inv.terms.map((t, i) => <p key={i}>{inv.terms.length > 1 ? `${i + 1}. ` : ''}{t}</p>)}
              </div>
            )}
          </div>
          <div className={clsx('flex min-h-[64px] flex-col items-end justify-between border-l border-t pl-2 pt-0.5', B)}>
            <p className="text-[11px] font-bold">for {s.companyName}</p>
            <p className="text-[10px]">Authorised Signatory</p>
          </div>
        </div>
      </div>
      <p className="mt-1 text-center text-[10px]">This is a Computer Generated Invoice</p>
    </div>
  );
}
