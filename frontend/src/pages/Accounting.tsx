import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/ui';

/** The Prisim Accounting app, shown inside the CRM. Super Admins only. */
export const ACCOUNTING_URL = 'https://prisim-accounting-software.vercel.app';

export default function Accounting() {
  const { me } = useAuth();
  const [loaded, setLoaded] = useState(false);
  if (!me?.roles.includes('super_admin')) return <Navigate to="/" replace />;
  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-3">
      <PageHeader
        title="Accounting"
        subtitle="Expenses, clients & projects, quotations, invoices, budgets, reports and approvals"
        actions={<a href={`${ACCOUNTING_URL}/dashboard`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-surface px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          Open in new window <ExternalLink className="h-4 w-4" />
        </a>}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        {!loaded && <div className="absolute inset-0 flex items-center justify-center text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        <iframe title="Prisim Accounting" src={`${ACCOUNTING_URL}/dashboard`} onLoad={() => setLoaded(true)} className="h-full w-full border-0" />
      </div>
    </div>
  );
}
