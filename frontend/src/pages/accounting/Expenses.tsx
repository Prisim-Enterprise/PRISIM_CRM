import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Download, FileText, Paperclip, Plus, Receipt, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { useDirectory } from '../../lib/hooks';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, Table, Td, Textarea, Th } from '../../components/ui';
import {
  AccountingGate, categoryOptions, dayLabel, EXPENSE_STATUS, Expense, ExpensePage, ExpenseStatus, METHODS, PaymentMethod, rupees, todayIso, useLookups,
} from './shared';

const STATUS_FILTERS: Record<string, string> = {
  '': 'Any status', PENDING: 'Pending', 'APPROVED,PAID': 'Approved & paid', APPROVED: 'Approved (not paid)', PAID: 'Paid', REJECTED: 'Rejected',
};
const FILTER_KEYS = ['search', 'from', 'to', 'status', 'categoryId', 'vendorId', 'clientId', 'projectId', 'submittedById', 'paymentMethod', 'receipt', 'tag', 'sort'] as const;

export default function Expenses() {
  return <AccountingGate submitOk><ExpensesPage /></AccountingGate>;
}

function ExpensesPage() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const lookups = useLookups();
  const manager = !!lookups.data?.canManage;
  const people = useDirectory();
  const query = { ...filters, page, pageSize: 50 };
  const q = useQuery({ queryKey: ['acct-expenses', query], queryFn: () => api.get<ExpensePage>('/accounting/expenses', query), placeholderData: (p) => p });
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-expenses'] }); qc.invalidateQueries({ queryKey: ['acct-lookups'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); qc.invalidateQueries({ queryKey: ['acct-categories'] }); };
  // "Add expense" from the dashboard arrives as ?new=1.
  useEffect(() => {
    if (params.get('new')) { setEditing('new'); const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
    setPage(1); setSelected(new Set());
  };
  const anyFilter = FILTER_KEYS.some((k) => k !== 'sort' && filters[k]);
  const items = q.data?.items ?? [];
  const allChecked = items.length > 0 && items.every((e) => selected.has(e.id));

  const bulk = async (status: ExpenseStatus | 'delete') => {
    const ids = [...selected];
    if (status === 'delete' && !confirm(`Delete ${ids.length} expense(s)? This cannot be undone.`)) return;
    let comment: string | null | undefined;
    if (status === 'REJECTED') { comment = prompt('Reason for rejecting (optional):'); if (comment === null) return; }
    try {
      if (status === 'delete') await api.post('/accounting/expenses/delete', { ids });
      else await api.post('/accounting/expenses/review', { ids, status, ...(comment ? { comment } : {}) });
      toast.success(status === 'delete' ? `${ids.length} deleted` : `${ids.length} marked ${EXPENSE_STATUS[status].label.toLowerCase()}`);
      setSelected(new Set()); refresh();
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Expenses"
        subtitle={manager ? 'Every company expense. Add, approve, mark paid and export.' : 'Your expenses. New ones wait for approval by accounts.'}
        actions={<>
          <Button variant="secondary" onClick={() => api.download('/accounting/expenses/export', filters, 'expenses.csv').catch((e) => toast.error(errMsg(e)))}><Download className="h-4 w-4" />Export CSV</Button>
          <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add expense</Button>
        </>}
      />

      <div className="flex flex-wrap items-end gap-2">
        <Input value={filters.search} onChange={(e) => setFilter('search', e.target.value)} placeholder="Search description, vendor, client…" className="w-64" aria-label="Search" />
        <Input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} className="w-40" aria-label="From date" title="From date" />
        <Input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} className="w-40" aria-label="To date" title="To date" />
        <Select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-44" aria-label="Status">
          {Object.entries(STATUS_FILTERS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select value={filters.categoryId} onChange={(e) => setFilter('categoryId', e.target.value)} className="w-52" aria-label="Category">
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {categoryOptions(lookups.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
        {manager && <>
          <Select value={filters.vendorId} onChange={(e) => setFilter('vendorId', e.target.value)} className="w-44" aria-label="Vendor">
            <option value="">Any vendor</option><option value="none">No vendor</option>
            {lookups.data?.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <Select value={filters.clientId} onChange={(e) => setFilter('clientId', e.target.value)} className="w-44" aria-label="Client">
            <option value="">Any client</option><option value="none">No client (overhead)</option>
            {lookups.data?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={filters.projectId} onChange={(e) => setFilter('projectId', e.target.value)} className="w-52" aria-label="Client project">
            <option value="">Any project</option><option value="none">Not linked to a project</option>
            {lookups.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.clientName} · {p.title}</option>)}
          </Select>
          <Select value={filters.submittedById} onChange={(e) => setFilter('submittedById', e.target.value)} className="w-44" aria-label="Submitted by">
            <option value="">Anyone</option>
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
          <Select value={filters.paymentMethod} onChange={(e) => setFilter('paymentMethod', e.target.value)} className="w-40" aria-label="Payment method">
            <option value="">Any method</option>
            {(Object.keys(METHODS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
          </Select>
          {!!lookups.data?.tags.length && (
            <Select value={filters.tag} onChange={(e) => setFilter('tag', e.target.value)} className="w-36" aria-label="Tag">
              <option value="">Any tag</option>
              {lookups.data.tags.map((t) => <option key={t} value={t}>#{t}</option>)}
            </Select>
          )}
        </>}
        <Select value={filters.receipt} onChange={(e) => setFilter('receipt', e.target.value)} className="w-40" aria-label="Receipt">
          <option value="">With or without receipt</option><option value="yes">Has receipt</option><option value="no">No receipt</option>
        </Select>
        <Select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)} className="w-40" aria-label="Sort">
          <option value="">Newest first</option><option value="date_asc">Oldest first</option>
          <option value="amount_desc">Highest amount</option><option value="amount_asc">Lowest amount</option><option value="created_desc">Recently added</option>
        </Select>
        {anyFilter && <Button variant="ghost" onClick={() => { setParams(new URLSearchParams(), { replace: true }); setPage(1); }}><X className="h-4 w-4" />Clear</Button>}
      </div>

      {manager && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm">
          <span className="font-medium text-indigo-900">{selected.size} selected</span>
          <Button size="sm" variant="success" onClick={() => bulk('APPROVED')}><Check className="h-3.5 w-3.5" />Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => bulk('PAID')}>Mark paid</Button>
          <Button size="sm" variant="secondary" onClick={() => bulk('REJECTED')}>Reject</Button>
          <Button size="sm" variant="secondary" onClick={() => bulk('PENDING')}>Back to pending</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-rose-600 hover:bg-rose-100" onClick={() => bulk('delete')}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
        </div>
      )}

      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !items.length ? (
          <Empty title={anyFilter ? 'No expenses match these filters' : 'No expenses yet'} icon={<Receipt className="h-9 w-9" />}>
            {anyFilter ? 'Try a wider date range or clear some filters.' : <Button className="mt-3" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add the first expense</Button>}
          </Empty>
        ) : (
          <>
            <ExpenseTable items={items} manager={manager} selected={selected} allChecked={allChecked}
              onToggle={(id) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); setSelected(s); }}
              onToggleAll={() => setSelected(allChecked ? new Set() : new Set(items.map((e) => e.id)))}
              onOpen={setEditing} />
            <div className="flex flex-wrap items-center justify-between border-t border-slate-100">
              <Pagination page={q.data!.page} pages={q.data!.pages} total={q.data!.total} onPage={setPage} />
              <p className="px-4 py-3 text-sm text-slate-600">Total of these: <span className="font-semibold tabular-nums text-slate-900">{rupees(q.data!.sum)}</span></p>
            </div>
          </>
        )}
      </Card>

      {editing && <ExpenseModal expense={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

export function ExpenseTable({ items, manager, selected, allChecked, onToggle, onToggleAll, onOpen, showSubmitter = true }: {
  items: Expense[]; manager: boolean; selected?: Set<string>; allChecked?: boolean; onToggle?: (id: string) => void; onToggleAll?: () => void;
  onOpen: (e: Expense) => void; showSubmitter?: boolean;
}) {
  const pick = manager && !!onToggle;
  return (
    <Table>
      <thead>
        <tr>
          {pick && <Th className="w-8"><input type="checkbox" checked={allChecked} onChange={onToggleAll} aria-label="Select all" /></Th>}
          <Th>Date</Th><Th>Details</Th><Th>Category</Th><Th>Client · project</Th><Th>Method</Th><Th className="text-right">Amount</Th><Th>Status</Th>
          {showSubmitter && <Th>Submitted by</Th>}
        </tr>
      </thead>
      <tbody>
        {items.map((e) => (
          <tr key={e.id} className={clsx('cursor-pointer hover:bg-slate-50', selected?.has(e.id) && 'bg-indigo-50/60')} onClick={() => onOpen(e)}>
            {pick && <Td className="w-8"><input type="checkbox" checked={selected!.has(e.id)} onChange={() => onToggle!(e.id)} onClick={(ev) => ev.stopPropagation()} aria-label={`Select expense of ${rupees(e.amount)}`} /></Td>}
            <Td className="whitespace-nowrap">{dayLabel(e.dateIncurred)}</Td>
            <Td className="max-w-[18rem]">
              <p className="truncate font-medium text-slate-900">{e.vendor?.name ?? e.description ?? '—'}</p>
              {e.vendor && e.description && <p className="truncate text-xs text-slate-500">{e.description}</p>}
              {(e.tags.length > 0 || e.hasReceipt) && (
                <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                  {e.hasReceipt && <Paperclip className="h-3 w-3" aria-label="Has receipt" />}
                  {e.tags.map((t) => <span key={t} className="rounded bg-slate-100 px-1">#{t}</span>)}
                </p>
              )}
            </Td>
            <Td className="text-slate-600">{e.categoryLabel ?? <span className="text-slate-400">Uncategorized</span>}</Td>
            <Td className="max-w-[12rem] truncate text-slate-600">{e.project ? `${e.project.client.name} · ${e.project.title}` : e.client?.name ?? '—'}</Td>
            <Td className="whitespace-nowrap text-slate-600">{METHODS[e.paymentMethod]}</Td>
            <Td className="text-right font-medium tabular-nums">{rupees(e.amount)}</Td>
            <Td><Badge className={EXPENSE_STATUS[e.status].color}>{EXPENSE_STATUS[e.status].label}</Badge></Td>
            {showSubmitter && <Td className="whitespace-nowrap text-slate-600">{e.submittedBy.fullName}</Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// ───────────────────────── Add / edit ─────────────────────────

interface Form {
  amount: string; dateIncurred: string; datePaid: string; categoryId: string; vendorName: string; clientId: string; projectId: string;
  paymentMethod: PaymentMethod; status: ExpenseStatus; description: string; tags: string; reviewComment: string;
}

/** defaults: pre-fill the client and/or project when adding from a client or project page. */
export function ExpenseModal({ expense, onClose, onSaved, defaults }: {
  expense: Expense | null; onClose: () => void; onSaved: () => void; defaults?: { clientId?: string; projectId?: string };
}) {
  const lookups = useLookups();
  const manager = !!lookups.data?.canManage;
  const [f, setF] = useState<Form>(() => ({
    amount: expense ? String(expense.amount) : '', dateIncurred: expense?.dateIncurred ?? todayIso(), datePaid: expense?.datePaid ?? '',
    categoryId: expense?.categoryId ?? '', vendorName: expense?.vendor?.name ?? '',
    clientId: expense?.clientId ?? expense?.project?.client.id ?? defaults?.clientId ?? '', projectId: expense?.project?.id ?? defaults?.projectId ?? '',
    paymentMethod: expense?.paymentMethod ?? 'UPI', status: expense?.status ?? 'APPROVED', description: expense?.description ?? '',
    tags: expense?.tags.join(', ') ?? '', reviewComment: expense?.reviewComment ?? '',
  }));
  const [file, setFile] = useState<File | null>(null);
  const [hasReceipt, setHasReceipt] = useState(!!expense?.hasReceipt);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (c: Partial<Form>) => setF({ ...f, ...c });
  const locked = !!expense && !manager && expense.status !== 'PENDING';
  const cats = useMemo(() => categoryOptions(lookups.data?.categories ?? []), [lookups.data]);
  // A project that is no longer in the active list still shows on its own expenses.
  const projectGone = expense?.project && !lookups.data?.projects.some((p) => p.id === expense.project!.id);
  useEffect(() => { if (f.status !== 'PAID' && f.datePaid && !expense?.datePaid) set({ datePaid: '' }); }, [f.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const amount = Number(f.amount);
    if (!(amount > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (file && file.size > 10 * 1024 * 1024) { toast.error('Receipts can be up to 10 MB'); return; }
    setSaving(true);
    try {
      const body = {
        amount: Math.round(amount * 100) / 100, dateIncurred: f.dateIncurred, categoryId: f.categoryId || null, vendorName: f.vendorName.trim() || null,
        projectId: f.projectId || null, clientId: f.clientId || null, paymentMethod: f.paymentMethod, description: f.description.trim() || null,
        tags: f.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
        ...(manager ? { status: f.status, datePaid: f.datePaid || null, reviewComment: f.reviewComment.trim() || null } : {}),
      };
      const saved = expense ? await api.patch<Expense>(`/accounting/expenses/${expense.id}`, body) : await api.post<Expense>('/accounting/expenses', body);
      if (file) {
        try { await api.upload(`/accounting/expenses/${saved.id}/receipt`, file); }
        catch (e) { toast.error(`Saved, but the receipt didn't upload: ${errMsg(e)}`); onSaved(); onClose(); return; }
      }
      toast.success(expense ? 'Expense updated' : manager ? 'Expense added' : 'Expense sent for approval');
      onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!expense || !confirm('Delete this expense? This cannot be undone.')) return;
    try { await api.del(`/accounting/expenses/${expense.id}`); toast.success('Expense deleted'); onSaved(); onClose(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const removeReceipt = async () => {
    if (!expense || !confirm('Remove the receipt from this expense?')) return;
    try { await api.del(`/accounting/expenses/${expense.id}/receipt`); setHasReceipt(false); onSaved(); toast.success('Receipt removed'); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const openReceipt = async () => {
    const w = window.open('', '_blank');
    try { const url = await api.blobUrl(`/accounting/expenses/${expense!.id}/receipt`); if (w) w.location.href = url; else window.open(url, '_blank'); }
    catch (e) { w?.close(); toast.error(errMsg(e)); }
  };

  return (
    <Modal open wide onClose={onClose} title={expense ? 'Expense' : 'Add expense'}
      footer={<>
        {expense && !locked && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove}><Trash2 className="h-4 w-4" />Delete</Button>}
        <Button variant="secondary" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</Button>
        {!locked && <Button loading={saving} onClick={save}>{expense ? 'Save changes' : manager ? 'Add expense' : 'Send for approval'}</Button>}
      </>}>
      {locked && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">This expense is {EXPENSE_STATUS[expense!.status].label.toLowerCase()}, so it can't be changed. Ask accounts if something is wrong.</p>}
      <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)"><Input type="number" min={0} step="0.01" inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} autoFocus={!expense} /></Field>
        <Field label="Date of expense"><Input type="date" value={f.dateIncurred} max={todayIso()} onChange={(e) => set({ dateIncurred: e.target.value })} /></Field>
        <Field label="Vendor / paid to" hint="Type a new name to add it.">
          <Input list="acct-vendors" value={f.vendorName} onChange={(e) => set({ vendorName: e.target.value })} placeholder="e.g. Model name, studio, shop" />
          <datalist id="acct-vendors">{lookups.data?.vendors.map((v) => <option key={v.id} value={v.name} />)}</datalist>
        </Field>
        <Field label="Category">
          <Select value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">Uncategorized</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Client (optional)" hint={f.clientId ? undefined : 'Leave empty for company costs such as rent.'}>
          <Select value={f.clientId} onChange={(e) => {
            const clientId = e.target.value;
            // A project from another client no longer fits.
            const keep = lookups.data?.projects.find((p) => p.id === f.projectId)?.clientId === clientId;
            set({ clientId, projectId: keep ? f.projectId : '' });
          }}>
            <option value="">No client (company cost)</option>
            {expense?.client && !lookups.data?.clients.some((c) => c.id === expense.client!.id) && <option value={expense.client.id}>{expense.client.name}</option>}
            {lookups.data?.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Project (optional)">
          <Select value={f.projectId} onChange={(e) => {
            const projectId = e.target.value;
            const owner = lookups.data?.projects.find((p) => p.id === projectId)?.clientId;
            set({ projectId, clientId: owner ?? f.clientId });
          }}>
            <option value="">Not linked to a project</option>
            {projectGone && <option value={expense!.project!.id}>{expense!.project!.client.name} · {expense!.project!.title}</option>}
            {lookups.data?.projects.filter((p) => !f.clientId || p.clientId === f.clientId).map((p) => <option key={p.id} value={p.id}>{f.clientId ? p.title : `${p.clientName} · ${p.title}`}</option>)}
          </Select>
        </Field>
        <Field label="Payment method">
          <Select value={f.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value as PaymentMethod })}>
            {(Object.keys(METHODS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
          </Select>
        </Field>
        {manager && <>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set({ status: e.target.value as ExpenseStatus })}>
              {(Object.keys(EXPENSE_STATUS) as ExpenseStatus[]).map((s) => <option key={s} value={s}>{EXPENSE_STATUS[s].label}</option>)}
            </Select>
          </Field>
          <Field label="Date paid" hint={f.status === 'PAID' && !f.datePaid ? 'Left empty, it is set to today.' : undefined}>
            <Input type="date" value={f.datePaid} onChange={(e) => set({ datePaid: e.target.value })} />
          </Field>
        </>}
        <Field label="Description / notes" className="sm:col-span-2"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Tags (optional)" hint="Separate with commas, e.g. shoot, urgent" className="sm:col-span-2"><Input value={f.tags} onChange={(e) => set({ tags: e.target.value })} /></Field>
        {manager && <Field label="Comment from accounts (optional)" className="sm:col-span-2"><Input value={f.reviewComment} onChange={(e) => set({ reviewComment: e.target.value })} placeholder="e.g. reason for rejecting" /></Field>}
      </fieldset>

      <div className="rounded-xl border border-dashed border-slate-300 px-3 py-2.5">
        <p className="mb-1 text-sm font-medium text-slate-700">Receipt</p>
        {hasReceipt && !file ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" onClick={openReceipt} className="inline-flex items-center gap-1.5 font-medium text-indigo-700 hover:underline"><FileText className="h-4 w-4" />{expense?.receiptName ?? 'View receipt'}</button>
            {!locked && <>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>Replace</Button>
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={removeReceipt}>Remove</Button>
            </>}
          </div>
        ) : file ? (
          <div className="flex items-center gap-2 text-sm"><Paperclip className="h-4 w-4 text-slate-400" /><span className="truncate">{file.name}</span>
            <button type="button" onClick={() => setFile(null)} className="rounded p-0.5 text-slate-400 hover:text-rose-600" aria-label="Remove file"><X className="h-4 w-4" /></button></div>
        ) : !locked ? (
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" />Upload a photo or PDF</Button>
        ) : <p className="text-sm text-slate-500">No receipt.</p>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf" className="hidden"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        <p className="mt-1 text-xs text-slate-500">PNG, JPG, WebP, HEIC or PDF · up to 10 MB</p>
      </div>

      {expense && (
        <p className="text-xs text-slate-500">
          Submitted by {expense.submittedBy.fullName} on {dayLabel(expense.createdAt)}
          {expense.reviewedBy && <> · {expense.status === 'REJECTED' ? 'Rejected' : 'Reviewed'} by {expense.reviewedBy.fullName}{expense.reviewedAt ? ` on ${dayLabel(expense.reviewedAt)}` : ''}</>}
          {!manager && expense.reviewComment && <> · Comment: “{expense.reviewComment}”</>}
        </p>
      )}
    </Modal>
  );
}
