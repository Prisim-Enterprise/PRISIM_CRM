import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format } from 'date-fns';
import { ArrowLeft, Copy, FileText, Plus, Printer, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { amountInWords, inr } from '../lib/money';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table, Td, Textarea, Th } from '../components/ui';

type Status = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED';
interface Item { title: string; points: string[]; qty: string; amount: number }
interface Quotation {
  id: string; number: string; date: string; validityDays: number; clientId: string | null; clientName: string; address: string | null;
  items: Item[]; gstRate: number; terms: string[]; status: Status; notes: string | null;
  subtotal: number; gst: number; total: number; createdBy: { id: string; fullName: string }; createdAt: string;
}
const STATUS: Record<Status, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'bg-slate-100 text-slate-700' },
  SENT: { label: 'Sent', color: 'bg-sky-100 text-sky-800' },
  ACCEPTED: { label: 'Accepted', color: 'bg-green-100 text-green-800' },
  REJECTED: { label: 'Rejected', color: 'bg-rose-100 text-rose-700' },
};

/** Prisim's standard statement of work. Editable per quotation. */
export const DEFAULT_TERMS = [
  'Full payment is required to confirm the project',
  'Meta advertising budget: ₹1,000 per day, payable separately by the client and not included in the service fee above.',
  'Google Ads budget: minimum recommended spend of ₹2,000 per day, payable separately by the client and not included in the service fee above.',
  'The package includes 13 reels and 30 poster creatives only. Additional work will be quoted separately.',
  'The client shall provide required brand assets, information, approvals and other content in a timely manner.',
  'Up to two reasonable revisions per creative are included. Additional revisions or major changes may be charged separately.',
  'Work will begin after receipt of the advance payment and required materials. The delivery schedule will be mutually agreed.',
  'Delays in receiving content, feedback or approvals may affect the delivery schedule.',
  'This quotation is valid for 15 days. GST is charged at 18%.',
  'Paid advertising spend, influencer fees, travel, location/prop costs and third-party subscriptions are excluded unless agreed in writing.',
];
const quoteDate = (s: string) => format(new Date(`${s.slice(0, 10)}T12:00:00`), 'dd-MMM-yy');

// ───────────────────────── List ─────────────────────────

export default function Quotations() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['quotations', search, status], queryFn: () => api.get<Quotation[]>('/quotations', { search, status }) });
  const list = q.data ?? [];
  const sum = (s?: Status) => list.filter((x) => !s || x.status === s).reduce((a, x) => a + x.total, 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Quotations" subtitle="Prisim quotations, shared by sales and accounts. Print or save as PDF in the standard format."
        actions={<Link to="/quotations/new"><Button><Plus className="h-4 w-4" />New quotation</Button></Link>} />
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number or client…" className="w-64" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
          <option value="">All statuses</option>
          {(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </Select>
        {list.length > 0 && <span className="ml-auto text-sm text-slate-500">{list.length} quotation{list.length === 1 ? '' : 's'} · {inr(sum())} total · {inr(sum('ACCEPTED'))} accepted</span>}
      </div>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !list.length ? (
          <Empty title="No quotations yet" icon={<FileText className="h-8 w-8" />}><Link to="/quotations/new"><Button className="mt-3"><Plus className="h-4 w-4" />New quotation</Button></Link></Empty>
        ) : (
          <Table>
            <thead><tr><Th>Number</Th><Th>Client</Th><Th>Date</Th><Th className="text-right">Grand total</Th><Th>Status</Th><Th>Made by</Th></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id} className="hover:bg-slate-50">
                  <Td><Link to={`/quotations/${x.id}`} className="font-mono font-medium text-indigo-700 hover:underline">{x.number}</Link></Td>
                  <Td><Link to={`/quotations/${x.id}`} className="font-medium text-slate-900 hover:underline">{x.clientName}</Link></Td>
                  <Td className="whitespace-nowrap">{quoteDate(x.date)}</Td>
                  <Td className="text-right font-medium tabular-nums">{inr(x.total)}</Td>
                  <Td><Badge className={STATUS[x.status].color}>{STATUS[x.status].label}</Badge></Td>
                  <Td className="text-slate-600">{x.createdBy.fullName}</Td>
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

type Form = {
  number: string; date: string; validityDays: number; clientId: string; clientName: string; address: string;
  items: { title: string; points: string; qty: string; amount: string }[]; gstRate: number; terms: string; status: Status;
};
const emptyItem = { title: '', points: '', qty: '1 Package', amount: '' };
const toForm = (x: Quotation): Form => ({
  number: x.number, date: x.date.slice(0, 10), validityDays: x.validityDays, clientId: x.clientId ?? '', clientName: x.clientName, address: x.address ?? '',
  items: x.items.map((i) => ({ title: i.title, points: i.points.join('\n'), qty: i.qty, amount: String(i.amount) })),
  gstRate: x.gstRate, terms: x.terms.join('\n'), status: x.status,
});
const toBody = (f: Form) => ({
  number: f.number.trim() || undefined, date: f.date, validityDays: Number(f.validityDays) || 15, clientId: f.clientId || null,
  clientName: f.clientName.trim(), address: f.address.trim() || null, gstRate: Number(f.gstRate),
  items: f.items.filter((i) => i.title.trim() || i.amount).map((i) => ({
    title: i.title.trim() || 'Item', points: i.points.split('\n').map((p) => p.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean),
    qty: i.qty.trim(), amount: Math.round((Number(i.amount) || 0) * 100) / 100,
  })),
  terms: f.terms.split('\n').map((t) => t.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean), status: f.status,
});

export function QuotationEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['quotation', id], queryFn: () => api.get<Quotation>(`/quotations/${id}`), enabled: !isNew });
  const next = useQuery({ queryKey: ['quotation-next'], queryFn: () => api.get<{ number: string }>('/quotations/next-number'), enabled: isNew });
  const clients = useQuery({ queryKey: ['client-directory'], queryFn: () => api.get<{ id: string; name: string }[]>('/clients/directory'), staleTime: 60_000 });
  const [f, setF] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isNew && existing.data && !f) setF(toForm(existing.data));
    if (isNew && next.data && !f) setF({
      number: next.data.number, date: format(new Date(), 'yyyy-MM-dd'), validityDays: 15, clientId: '', clientName: '', address: '',
      items: [{ ...emptyItem, title: 'Digital Marketing Content Package', points: 'Short-form video reels – 13 reels\nStatic / promotional poster creatives – 30 posters' }],
      gstRate: 18, terms: DEFAULT_TERMS.join('\n'), status: 'DRAFT',
    });
  }, [existing.data, next.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => (f ? toBody(f) : null), [f]);
  if ((!isNew && existing.isLoading) || (isNew && next.isLoading) || !f || !body) return existing.error ? <ErrorBox error={existing.error} /> : <Spinner />;
  const set = (c: Partial<Form>) => setF({ ...f, ...c });
  const setItem = (i: number, c: Partial<Form['items'][number]>) => set({ items: f.items.map((it, j) => (j === i ? { ...it, ...c } : it)) });

  const save = async () => {
    if (body.clientName.length < 2) { toast.error('Add the client name'); return; }
    if (!body.items.length) { toast.error('Add at least one item'); return; }
    setSaving(true);
    try {
      const saved = isNew ? await api.post<Quotation>('/quotations', body) : await api.patch<Quotation>(`/quotations/${id}`, body);
      qc.invalidateQueries({ queryKey: ['quotations'] }); qc.invalidateQueries({ queryKey: ['quotation-next'] });
      qc.setQueryData(['quotation', saved.id], saved);
      toast.success(isNew ? `Quotation ${saved.number} saved` : 'Saved');
      if (isNew) nav(`/quotations/${saved.id}`, { replace: true }); else setF(toForm(saved));
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const duplicate = async () => {
    try { const c = await api.post<Quotation>(`/quotations/${id}/duplicate`); toast.success(`Copied as ${c.number}`); setF(null); nav(`/quotations/${c.id}`); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => {
    if (!confirm(`Delete quotation ${f.number}? This cannot be undone.`)) return;
    try { await api.del(`/quotations/${id}`); qc.invalidateQueries({ queryKey: ['quotations'] }); toast.success('Deleted'); nav('/quotations'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const print = async () => {
    // Print what's on screen; save first so the printed copy and the saved one match.
    if (isNew || JSON.stringify(toBody(toForm(existing.data!))) !== JSON.stringify(body)) await save();
    setTimeout(() => window.print(), 150);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to="/quotations" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Quotations</Link>
        <h1 className="ml-2 text-xl font-semibold text-slate-900">{isNew ? 'New quotation' : f.number}</h1>
        <div className="ml-auto flex flex-wrap gap-2">
          {!isNew && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={remove}><Trash2 className="h-4 w-4" />Delete</Button>}
          {!isNew && <Button variant="secondary" onClick={duplicate}><Copy className="h-4 w-4" />Duplicate</Button>}
          <Button variant="secondary" onClick={print}><Printer className="h-4 w-4" />Print / Save PDF</Button>
          <Button loading={saving} onClick={save}><Save className="h-4 w-4" />Save</Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {/* Form */}
        <Card className="h-fit print:hidden">
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quotation No."><Input value={f.number} onChange={(e) => set({ number: e.target.value })} /></Field>
              <Field label="Status"><Select value={f.status} onChange={(e) => set({ status: e.target.value as Status })}>{(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</Select></Field>
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
              <Field label="Validity (days)"><Input type="number" min={1} max={365} value={f.validityDays} onChange={(e) => set({ validityDays: Number(e.target.value) })} /></Field>
            </div>
            <Field label="CRM client (optional)" hint="Links it to the client. Fills in the name.">
              <Select value={f.clientId} onChange={(e) => { const c = clients.data?.find((x) => x.id === e.target.value); set({ clientId: e.target.value, clientName: c ? c.name : f.clientName }); }}>
                <option value="">Not linked</option>
                {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Client name"><Input value={f.clientName} onChange={(e) => set({ clientName: e.target.value })} placeholder="Clean well solutions" /></Field>
            <Field label="Registered address"><Textarea rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>

            <div>
              <p className="mb-1 text-sm font-semibold text-slate-800">Scope of work</p>
              <div className="space-y-2">
                {f.items.map((it, i) => (
                  <div key={i} className="space-y-2 rounded-xl border border-slate-200 p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-400">{String(i + 1).padStart(2, '0')}</span>
                      <Input value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Description" aria-label={`Item ${i + 1} description`} />
                      {f.items.length > 1 && <button onClick={() => set({ items: f.items.filter((_, j) => j !== i) })} className="rounded p-1 text-slate-400 hover:text-rose-600" aria-label={`Remove item ${i + 1}`}><X className="h-4 w-4" /></button>}
                    </div>
                    <Textarea rows={2} value={it.points} onChange={(e) => setItem(i, { points: e.target.value })} placeholder="Bullet points, one per line" aria-label={`Item ${i + 1} points`} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} placeholder="Qty" aria-label={`Item ${i + 1} quantity`} />
                      <Input type="number" min={0} step="0.01" value={it.amount} onChange={(e) => setItem(i, { amount: e.target.value })} placeholder="Amount ₹" aria-label={`Item ${i + 1} amount`} />
                    </div>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => set({ items: [...f.items, { ...emptyItem }] })}><Plus className="h-3.5 w-3.5" />Add item</Button>
            </div>
            <Field label="GST %"><Input type="number" min={0} max={100} step="0.01" value={f.gstRate} onChange={(e) => set({ gstRate: Number(e.target.value) })} className="w-28" /></Field>
            <Field label="Statement of work" hint="One point per line. They're numbered automatically.">
              <Textarea rows={10} value={f.terms} onChange={(e) => set({ terms: e.target.value })} />
            </Field>
          </div>
        </Card>

        {/* Preview: exactly what prints */}
        <div className="overflow-x-auto print:overflow-visible">
          <QuotationSheet q={body as unknown as Quotation} />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── The printed quotation ─────────────────────────

const NAVY = 'bg-[#13213a] text-white';
const GREY = 'bg-[#e8e9eb]';
const cell = 'border border-slate-500 px-2 py-1';

/** Prisim's quotation layout. This element alone prints (A4). */
export function QuotationSheet({ q }: { q: Pick<Quotation, 'number' | 'date' | 'validityDays' | 'clientName' | 'address' | 'items' | 'gstRate' | 'terms'> }) {
  const subtotal = Math.round(q.items.reduce((a, i) => a + Number(i.amount || 0), 0) * 100) / 100;
  const gst = Math.round(subtotal * (q.gstRate / 100) * 100) / 100;
  const total = Math.round((subtotal + gst) * 100) / 100;
  const gstLabel = Number.isInteger(q.gstRate) ? String(q.gstRate) : q.gstRate.toFixed(2);
  return (
    <div id="quotation-sheet" className="mx-auto w-full max-w-[794px] bg-white text-[13px] leading-snug text-slate-900 shadow-card print:w-full print:shadow-none" style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <div className="border-2 border-[#2f5d50] p-0">
        {/* Header */}
        <div className="flex items-center border-b-2 border-[#b8955a] px-4 py-3">
          <div className="flex w-32 flex-col items-center">
            <img src="/prisim-logo-dark.png" alt="Prisim" className="h-12 w-auto" />
          </div>
          <h1 className="flex-1 text-center text-3xl font-bold tracking-wide text-[#13213a]">QUOTATION</h1>
          <div className="w-32" />
        </div>
        <div className="h-4" />
        {/* Details */}
        <table className="w-full border-collapse">
          <tbody>
            <tr>
              <td className={clsx(cell, 'w-[17%] font-bold')}>Quotation No.:</td>
              <td className={clsx(cell, GREY, 'w-[50%] text-slate-600')}>{q.number}</td>
              <td className={clsx(cell, 'w-[11%] font-bold')}>Date:</td>
              <td className={clsx(cell, GREY, 'text-slate-600')}>{quoteDate(q.date)}</td>
            </tr>
            <tr>
              <td className={clsx(cell, 'font-bold')}>Client Name:</td>
              <td className={clsx(cell, GREY, 'text-slate-600')}>{q.clientName || '—'}</td>
              <td className={clsx(cell, 'font-bold')}>Validity:</td>
              <td className={clsx(cell, GREY, 'text-slate-600')}>{q.validityDays} days</td>
            </tr>
            <tr>
              <td className={clsx(cell, 'align-top font-bold')}>Registered Address:</td>
              <td className={clsx(cell, 'whitespace-pre-line')}>{q.address || ''}</td>
              <td className={clsx(cell, GREY)} colSpan={2} />
            </tr>
          </tbody>
        </table>

        {/* Scope of work */}
        <p className="px-2 pt-1 font-bold uppercase">Scope of work</p>
        <table className="w-full border-collapse">
          <thead>
            <tr className={NAVY}>
              <th className={clsx(cell, 'w-[15%] text-center font-semibold')}>S.NO.</th>
              <th className={clsx(cell, 'text-center font-semibold')}>DESCRIPTION</th>
              <th className={clsx(cell, 'w-[11%] text-center font-semibold')}>QTY</th>
              <th className={clsx(cell, 'w-[14%] text-center font-semibold')}>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            {q.items.map((it, i) => (
              <Fragment key={i}>
                <tr className={GREY}>
                  <td className={clsx(cell, 'py-6 text-center')}>{String(i + 1).padStart(2, '0')}</td>
                  <td className={clsx(cell, 'py-3')}>
                    <p>{it.title}</p>
                    {it.points.map((p, j) => <p key={j}>• {p}</p>)}
                  </td>
                  <td className={clsx(cell, 'text-center')}>{it.qty}</td>
                  <td className={clsx(cell, 'text-right tabular-nums')}>{inr(Number(it.amount) || 0)}</td>
                </tr>
              </Fragment>
            ))}
            <tr className={GREY}><td className={clsx(cell, 'h-5')} /><td className={cell} /><td className={cell} /><td className={cell} /></tr>
          </tbody>
        </table>
        <table className="w-full border-collapse">
          <tbody>
            <tr className={GREY}><td className="border-x border-slate-500 px-2 py-0.5 text-right text-slate-600" colSpan={3}>Subtotal</td><td className={clsx(cell, 'w-[14%] text-right font-bold tabular-nums')}>{inr(subtotal)}</td></tr>
            <tr className={GREY}><td className="border-x border-slate-500 px-2 py-0.5 text-right text-slate-600" colSpan={3}>GST @ {gstLabel}%</td><td className={clsx(cell, 'text-right font-bold tabular-nums')}>{inr(gst)}</td></tr>
            <tr className={NAVY}><td className="border border-slate-500 px-2 py-1 text-base font-bold" colSpan={3}>GRAND TOTAL</td><td className="border border-slate-500 px-2 py-1 text-right text-base font-bold tabular-nums">{inr(total)}</td></tr>
          </tbody>
        </table>
        <p className="border-x border-b border-slate-500 px-2 py-1 font-bold italic">Amount in words: {amountInWords(total)}</p>

        {/* Statement of work */}
        <p className="border-x border-slate-500 px-2 pt-2 text-base font-bold uppercase">Statement of work</p>
        <div className="border-x border-slate-500">
          {q.terms.map((t, i) => <p key={i} className={clsx('border-t border-slate-300 px-2 py-1 text-[12px]', GREY)}>{i + 1}. {t}</p>)}
        </div>

        {/* Signatures */}
        <div className="grid grid-cols-2 border border-slate-500">
          <div className="px-2 py-1">
            <p>Accepted By</p>
            <p className="uppercase">{q.clientName}</p>
            <div className="h-9" />
            <p>Authorized Signature</p>
          </div>
          <div className="px-2 py-1 text-center">
            <p>For PRISIM</p>
            <div className="h-12" />
            <p className="text-right">Authorized Signature</p>
          </div>
        </div>
        <p className={clsx('py-1 text-center text-[11px] text-slate-700', GREY)}>PRISIM&nbsp; | &nbsp;Digital Marketing Services&nbsp; | &nbsp;Thank you for your business</p>
      </div>
    </div>
  );
}
