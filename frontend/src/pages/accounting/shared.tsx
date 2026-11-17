import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

// ───────────────────────── Types ─────────────────────────

export type ExpenseStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REJECTED';
export type PaymentMethod = 'BANK_TRANSFER' | 'UPI' | 'CASH' | 'CARD' | 'CHEQUE' | 'OTHER';
export type ProjectStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type InvoiceStatus = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'cancelled';

export interface Person { id: string; fullName: string }

export interface Expense {
  id: string; amount: number; dateIncurred: string; datePaid: string | null; status: ExpenseStatus; paymentMethod: PaymentMethod;
  description: string | null; tags: string[]; hasReceipt: boolean; receiptName: string | null; receiptType: string | null;
  categoryId: string | null; categoryLabel: string | null; topCategoryId: string | null;
  vendor: { id: string; name: string } | null; project: { id: string; title: string; client: { id: string; name: string } } | null;
  submittedBy: Person; reviewedBy: Person | null; reviewedAt: string | null; reviewComment: string | null; createdAt: string;
}
export interface ExpensePage { items: Expense[]; total: number; page: number; pages: number; sum: number; pending: { count: number; amount: number } }

export interface Lookups {
  categories: { id: string; name: string; parentId: string | null; sortOrder: number }[];
  vendors: { id: string; name: string }[];
  projects: { id: string; title: string; status: ProjectStatus; clientName: string }[];
  tags: string[];
  canManage: boolean;
}

export interface Payment { id: string; amount: number; paidOn: string; method: PaymentMethod; note: string | null }

export interface Project {
  id: string; title: string; status: ProjectStatus; notes: string | null; meetingDate: string | null; shootStart: string | null; shootEnd: string | null;
  quotedAmount: number | null; client: { id: string; name: string; contactName?: string | null; phone?: string | null; email?: string | null };
  received: number; spent: number; invoiced: number; balance: number; profit: number; lastPayment: string | null; paymentCount: number; createdAt: string;
}
export interface ProjectDetail extends Project { payments: Payment[]; expenses: Expense[]; invoices: Invoice[]; createdBy: Person }

export interface InvoiceItem { description: string; hsn?: string; qty: number; unit?: string; rate: number }
export interface ClientDetails { contactPerson: string; phone: string; email: string; gstin: string; address: string; stateCode?: string }
export interface InvoiceExtra {
  deliveryNote?: string; referenceNo?: string; otherReferences?: string; buyerOrderNo?: string; buyerOrderDate?: string;
  dispatchDocNo?: string; deliveryNoteDate?: string; dispatchedThrough?: string; destination?: string; termsOfDelivery?: string;
}
export interface ShipTo { name: string; address: string; gstin: string; stateCode: string }
export interface Invoice {
  id: string; number: string; date: string; dueDate: string | null; clientId: string | null; clientName: string; clientDetails: ClientDetails;
  items: InvoiceItem[]; gstRate: number; notes: string | null; terms: string[]; preparedBy: string | null; cancelled: boolean;
  extra: InvoiceExtra | null; shipTo: ShipTo | null;
  project: { id: string; title: string } | null; projectId: string | null; quotation: { id: string; number: string } | null; payments: Payment[];
  subtotal: number; discount: number; taxable: number; split: 'igst' | 'cgst_sgst'; cgst: number; sgst: number; igst: number; gst: number;
  total: number; paid: number; balance: number; status: InvoiceStatus; createdBy: Person;
}

export interface Settings {
  companyName: string; tagline: string; address: string; phone: string; email: string; website: string; gstin: string; stateCode: string;
  bank: { accountName: string; accountNumber: string; ifsc: string; bankName: string; upiId: string };
  invoicePrefix: string; invoiceDueDays: number; fyStartMonth: number; invoiceTerms: string[]; defaultHsn: string;
}

/** GST state codes (the first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
/** State code from a GSTIN, else the one picked. */
export const stateOf = (gstin: string | undefined, picked?: string) => {
  const g = (gstin ?? '').trim().slice(0, 2);
  return /^\d{2}$/.test(g) ? g : picked ?? '';
};

export interface Ledger {
  fyStartMonth: number;
  expenses: {
    id: string; amount: number; date: string; status: ExpenseStatus; method: PaymentMethod; categoryId: string | null; topCategoryId: string | null;
    vendorId: string | null; vendorName: string | null; projectId: string | null; projectLabel: string | null; submitterId: string; submitterName: string;
  }[];
  income: { amount: number; date: string; method: PaymentMethod; clientId: string | null; clientName: string; source: string }[];
  invoices: { count: number; invoicedInRange: number; outstanding: number; overdue: number; overdueCount: number };
  categories: { id: string; name: string; parentId: string | null; monthlyBudget: number | null; annualBudget: number | null; sortOrder: number; archived: boolean }[];
}

// ───────────────────────── Labels ─────────────────────────

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; color: string }> = {
  PENDING: { label: 'Pending', color: 'bg-amber-100 text-amber-800' },
  APPROVED: { label: 'Approved', color: 'bg-sky-100 text-sky-800' },
  PAID: { label: 'Paid', color: 'bg-green-100 text-green-800' },
  REJECTED: { label: 'Rejected', color: 'bg-rose-100 text-rose-700' },
};
export const METHODS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CASH: 'Cash', CARD: 'Card', CHEQUE: 'Cheque', OTHER: 'Other',
};
export const PROJECT_STATUS: Record<ProjectStatus, { label: string; color: string }> = {
  ACTIVE: { label: 'Active', color: 'bg-sky-100 text-sky-800' },
  COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  CANCELLED: { label: 'Cancelled', color: 'bg-slate-100 text-slate-600' },
};
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; color: string }> = {
  paid: { label: 'Paid', color: 'bg-green-100 text-green-800' },
  partial: { label: 'Part paid', color: 'bg-sky-100 text-sky-800' },
  unpaid: { label: 'Unpaid', color: 'bg-amber-100 text-amber-800' },
  overdue: { label: 'Overdue', color: 'bg-rose-100 text-rose-700' },
  cancelled: { label: 'Cancelled', color: 'bg-slate-100 text-slate-600' },
};
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ───────────────────────── Formatting ─────────────────────────

/** ₹1,23,456 (no paise unless there are some). */
export const rupees = (n: number): string => (n < 0 ? '−' + rupees(-n) : '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
/** ₹1.2L / ₹3.4Cr for chart axes. */
export const rupeesShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `₹${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `₹${Math.round(n)}`;
};
const asDate = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`);
export const dayLabel = (s?: string | null) => (s ? format(asDate(s), 'd MMM yyyy') : '—');
export const shortDay = (s?: string | null) => (s ? format(asDate(s), 'd MMM') : '—');
export const monthLabel = (key: string, long = false) => format(asDate(`${key}-01`), long ? 'MMMM yyyy' : 'MMM yy');
export const isoDay = (d: Date) => format(d, 'yyyy-MM-dd');
export const todayIso = () => isoDay(new Date());
export const monthKey = (s: string) => s.slice(0, 7);
export const pctChange = (cur: number, prev: number) => (prev ? ((cur - prev) / prev) * 100 : null);

// ───────────────────────── Date ranges ─────────────────────────

export type Preset = 'this_month' | 'last_month' | 'last_90' | 'fytd' | 'last_12';
export const PRESETS: Record<Preset, string> = {
  this_month: 'This month', last_month: 'Last month', last_90: 'Last 90 days', fytd: 'This financial year', last_12: 'Last 12 months',
};
export interface Range { from: string; to: string; label: string }
const firstOf = (y: number, m: number) => new Date(y, m, 1);
const lastOf = (y: number, m: number) => new Date(y, m + 1, 0);

/** The chosen period and the one before it, for comparison. */
export function presetRange(p: Preset, fyStart: number, now = new Date()): { current: Range; previous: Range } {
  const y = now.getFullYear(), m = now.getMonth();
  const t = new Date(y, m, now.getDate());
  switch (p) {
    case 'this_month':
      return { current: { from: isoDay(firstOf(y, m)), to: isoDay(t), label: 'This month' }, previous: { from: isoDay(firstOf(y, m - 1)), to: isoDay(lastOf(y, m - 1)), label: 'last month' } };
    case 'last_month':
      return { current: { from: isoDay(firstOf(y, m - 1)), to: isoDay(lastOf(y, m - 1)), label: 'Last month' }, previous: { from: isoDay(firstOf(y, m - 2)), to: isoDay(lastOf(y, m - 2)), label: 'the month before' } };
    case 'last_90': {
      const from = new Date(t); from.setDate(from.getDate() - 89);
      const pTo = new Date(from); pTo.setDate(pTo.getDate() - 1);
      const pFrom = new Date(pTo); pFrom.setDate(pFrom.getDate() - 89);
      return { current: { from: isoDay(from), to: isoDay(t), label: 'Last 90 days' }, previous: { from: isoDay(pFrom), to: isoDay(pTo), label: 'the 90 days before' } };
    }
    case 'fytd': {
      const fy = m + 1 >= fyStart ? y : y - 1;
      return {
        current: { from: isoDay(firstOf(fy, fyStart - 1)), to: isoDay(t), label: 'This financial year' },
        previous: { from: isoDay(firstOf(fy - 1, fyStart - 1)), to: isoDay(new Date(y - 1, m, now.getDate())), label: 'same time last year' },
      };
    }
    case 'last_12':
      return { current: { from: isoDay(firstOf(y, m - 11)), to: isoDay(t), label: 'Last 12 months' }, previous: { from: isoDay(firstOf(y, m - 23)), to: isoDay(lastOf(y, m - 12)), label: 'the 12 months before' } };
  }
}

/** Last n month keys (YYYY-MM), oldest first, ending this month. */
export function lastMonths(n: number, now = new Date()) {
  return Array.from({ length: n }, (_, i) => isoDay(firstOf(now.getFullYear(), now.getMonth() - (n - 1 - i))).slice(0, 7));
}

/** A category's monthly budget: its own monthly figure, else annual / 12, else (for a parent) the sum of its subcategories. */
export function monthlyBudget(id: string, cats: Ledger['categories']): number {
  const c = cats.find((x) => x.id === id);
  if (c?.monthlyBudget != null) return c.monthlyBudget;
  if (c?.annualBudget != null) return c.annualBudget / 12;
  return cats.filter((x) => x.parentId === id && !x.archived).reduce((s, x) => s + monthlyBudget(x.id, cats), 0);
}

export const CHART_COLORS = ['#4f46e5', '#f97316', '#10b981', '#eab308', '#ec4899', '#0ea5e9', '#8b5cf6', '#14b8a6'];
export const OTHER_COLOR = '#94a3b8';

// ───────────────────────── Data & access ─────────────────────────

export const useLookups = () => useQuery({ queryKey: ['acct-lookups'], queryFn: () => api.get<Lookups>('/accounting/lookups'), staleTime: 30_000 });
export const useSettings = () => useQuery({ queryKey: ['acct-settings'], queryFn: () => api.get<Settings>('/accounting/settings'), staleTime: 60_000 });

/** Shows the page only to people with accounting access; everyone else goes back to the dashboard. */
export function AccountingGate({ children, submitOk }: { children: ReactNode; submitOk?: boolean }) {
  const { can } = useAuth();
  if (can('accounting.manage') || (submitOk && can('accounting.expenses.submit'))) return <>{children}</>;
  return <Navigate to={submitOk ? '/' : can('accounting.expenses.submit') ? '/accounting/expenses' : '/'} replace />;
}

/** Category options, indented under their parent. */
export function categoryOptions(cats: Lookups['categories']) {
  const top = cats.filter((c) => !c.parentId);
  return top.flatMap((p) => [{ id: p.id, label: p.name }, ...cats.filter((c) => c.parentId === p.id).map((c) => ({ id: c.id, label: `   ${p.name} › ${c.name}` }))]);
}

export const downloadCsv = (name: string, rows: (string | number)[][]) => {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
