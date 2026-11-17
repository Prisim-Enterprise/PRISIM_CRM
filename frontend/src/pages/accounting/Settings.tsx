import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select, Spinner, Textarea } from '../../components/ui';
import { AccountingGate, MONTHS, Settings, useSettings } from './shared';

export default function AccountingSettings() {
  return <AccountingGate><SettingsPage /></AccountingGate>;
}

function SettingsPage() {
  const q = useSettings();
  const qc = useQueryClient();
  const [f, setF] = useState<(Omit<Settings, 'invoiceTerms'> & { invoiceTerms: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data && !f) setF({ ...q.data, invoiceTerms: q.data.invoiceTerms.join('\n') }); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading || !f) return q.error ? <ErrorBox error={q.error} /> : <Spinner />;
  const set = (c: Partial<typeof f>) => setF({ ...f, ...c });
  const bank = (c: Partial<Settings['bank']>) => set({ bank: { ...f.bank, ...c } });

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.put<Settings>('/accounting/settings', {
        ...f, gstin: f.gstin.trim().toUpperCase(), invoiceDueDays: Number(f.invoiceDueDays) || 0, fyStartMonth: Number(f.fyStartMonth),
        invoiceTerms: f.invoiceTerms.split('\n').map((t) => t.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean),
      });
      qc.setQueryData(['acct-settings'], saved);
      qc.invalidateQueries({ queryKey: ['acct-invoice-next'] }); qc.invalidateQueries({ queryKey: ['acct-invoices'] }); qc.invalidateQueries({ queryKey: ['acct-ledger'] });
      setF({ ...saved, invoiceTerms: saved.invoiceTerms.join('\n') });
      toast.success('Settings saved');
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title="Accounting settings" subtitle="Printed on invoices, and used for budgets and financial-year reports."
        actions={<Button loading={saving} onClick={save}><Save className="h-4 w-4" />Save</Button>} />
      <Card title="Company">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Company name"><Input value={f.companyName} onChange={(e) => set({ companyName: e.target.value })} /></Field>
          <Field label="Tagline"><Input value={f.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
          <Field label="Address" className="sm:col-span-2"><Textarea rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
          <Field label="Email"><Input value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Website"><Input value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="GST">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Your GSTIN" hint="Leave empty until registered. With a GSTIN, invoices print as “TAX INVOICE”.">
            <Input value={f.gstin} maxLength={15} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} placeholder="29XXXXX0000X1Z5" />
          </Field>
          <Field label="State code" hint="First two digits of a GSTIN; Karnataka is 29. Clients from another state are charged IGST, others CGST + SGST.">
            <Input value={f.stateCode} maxLength={2} onChange={(e) => set({ stateCode: e.target.value.replace(/\D/g, '') })} className="w-24" />
          </Field>
        </div>
      </Card>
      <Card title="Bank details (printed on invoices)">
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Account name"><Input value={f.bank.accountName} onChange={(e) => bank({ accountName: e.target.value })} /></Field>
          <Field label="Account number"><Input value={f.bank.accountNumber} onChange={(e) => bank({ accountNumber: e.target.value })} /></Field>
          <Field label="IFSC"><Input value={f.bank.ifsc} onChange={(e) => bank({ ifsc: e.target.value.toUpperCase() })} /></Field>
          <Field label="Bank & branch"><Input value={f.bank.bankName} onChange={(e) => bank({ bankName: e.target.value })} /></Field>
          <Field label="UPI ID"><Input value={f.bank.upiId} onChange={(e) => bank({ upiId: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Invoices & financial year">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Invoice number prefix" hint={`Numbers look like ${f.invoicePrefix || 'PI'}-26-001`}><Input value={f.invoicePrefix} maxLength={8} onChange={(e) => set({ invoicePrefix: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} /></Field>
          <Field label="Payment due after (days)"><Input type="number" min={0} max={365} value={f.invoiceDueDays} onChange={(e) => set({ invoiceDueDays: Number(e.target.value) })} /></Field>
          <Field label="Financial year starts in">
            <Select value={f.fyStartMonth} onChange={(e) => set({ fyStartMonth: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>
          </Field>
          <Field label="Default invoice terms & conditions" hint="One per line. Each new invoice starts with these, and they can be edited per invoice." className="sm:col-span-3">
            <Textarea rows={7} value={f.invoiceTerms} onChange={(e) => set({ invoiceTerms: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="Who can use Accounting">
        <div className="space-y-2 p-4 text-sm text-slate-600">
          <p><span className="font-medium text-slate-900">Full accounting</span> (every section, approvals, invoices, settings): the Super Admin role.</p>
          <p><span className="font-medium text-slate-900">Submit expenses only</span>: anyone given “Submit own expenses for approval”. They see Accounting → Expenses with just their own expenses, and accounts approves them.</p>
          <p>Change either under <Link to="/admin/roles" className="text-indigo-600 hover:underline">Roles & Permissions</Link>, or for one person under <Link to="/admin/users" className="text-indigo-600 hover:underline">Users & Teams</Link>.</p>
        </div>
      </Card>
    </div>
  );
}
