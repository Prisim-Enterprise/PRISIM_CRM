import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCheck, FileText, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '../../components/ui';
import { AccountingGate, dayLabel, Expense, ExpensePage, ExpenseStatus, METHODS, rupees } from './shared';
import { ExpenseModal } from './Expenses';

export default function Approvals() {
  return <AccountingGate><ApprovalsPage /></AccountingGate>;
}

function ApprovalsPage() {
  const q = useQuery({ queryKey: ['acct-expenses', 'approvals'], queryFn: () => api.get<ExpensePage>('/accounting/expenses', { status: 'PENDING', sort: 'date_asc', pageSize: 200 }) });
  const qc = useQueryClient();
  const [open, setOpen] = useState<Expense | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['acct-expenses'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] }); };
  const items = q.data?.items ?? [];

  const act = async (ids: string[], status: ExpenseStatus, key: string) => {
    const comment = ids.length === 1 ? comments[ids[0]]?.trim() : undefined;
    if (status === 'REJECTED' && ids.length === 1 && !comment && !confirm('Reject without a comment? A short reason helps the person fix it.')) return;
    setBusy(key);
    try {
      await api.post('/accounting/expenses/review', { ids, status, ...(comment ? { comment } : {}) });
      toast.success(ids.length === 1 ? (status === 'REJECTED' ? 'Rejected' : status === 'PAID' ? 'Approved and marked paid' : 'Approved') : `${ids.length} approved`);
      refresh();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const openReceipt = async (id: string) => {
    const w = window.open('', '_blank');
    try { const url = await api.blobUrl(`/accounting/expenses/${id}/receipt`); if (w) w.location.href = url; }
    catch (e) { w?.close(); toast.error(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Approvals" subtitle="Expenses waiting for accounts. Approve, approve and mark paid, or reject with a comment."
        actions={items.length > 1 && <Button variant="success" loading={busy === 'all'} onClick={() => confirm(`Approve all ${items.length} pending expenses (${rupees(q.data!.sum)})?`) && act(items.map((e) => e.id), 'APPROVED', 'all')}><CheckCheck className="h-4 w-4" />Approve all {items.length}</Button>} />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !items.length ? (
        <Card><Empty title="Nothing waiting for approval" icon={<CheckCheck className="h-9 w-9" />}>New expenses from the team show up here.</Empty></Card>
      ) : (
        <>
          <p className="text-sm text-slate-600">{items.length} pending · <span className="font-semibold text-slate-900">{rupees(q.data!.sum)}</span></p>
          <div className="space-y-3">
            {items.map((e) => (
              <Card key={e.id}>
                <div className="flex flex-wrap items-start gap-4 p-4">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(e)}>
                    <p className="text-lg font-semibold tabular-nums text-slate-900">{rupees(e.amount)}</p>
                    <p className="font-medium text-slate-800">{e.vendor?.name ?? e.description ?? 'No details'}</p>
                    {e.vendor && e.description && <p className="text-sm text-slate-600">{e.description}</p>}
                    <p className="mt-1 text-xs text-slate-500">
                      {dayLabel(e.dateIncurred)} · {e.categoryLabel ?? 'Uncategorized'} · {METHODS[e.paymentMethod]}
                      {e.project && <> · {e.project.client.name} · {e.project.title}</>}
                      {' '}· by {e.submittedBy.fullName}
                    </p>
                  </button>
                  <div className="flex w-full flex-col gap-2 sm:w-80">
                    {e.hasReceipt
                      ? <button onClick={() => openReceipt(e.id)} className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-indigo-700 hover:underline"><FileText className="h-4 w-4" />View receipt</button>
                      : <span className="inline-flex items-center gap-1.5 text-xs text-slate-400"><Paperclip className="h-3.5 w-3.5" />No receipt attached</span>}
                    <Input value={comments[e.id] ?? ''} onChange={(ev) => setComments({ ...comments, [e.id]: ev.target.value })} placeholder="Comment (optional)" aria-label="Comment" />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="success" loading={busy === `${e.id}-a`} onClick={() => act([e.id], 'APPROVED', `${e.id}-a`)}><Check className="h-3.5 w-3.5" />Approve</Button>
                      <Button size="sm" variant="secondary" loading={busy === `${e.id}-p`} onClick={() => act([e.id], 'PAID', `${e.id}-p`)}>Approve & mark paid</Button>
                      <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50" loading={busy === `${e.id}-r`} onClick={() => act([e.id], 'REJECTED', `${e.id}-r`)}><X className="h-3.5 w-3.5" />Reject</Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      {open && <ExpenseModal expense={open} onClose={() => setOpen(null)} onSaved={refresh} />}
    </div>
  );
}
