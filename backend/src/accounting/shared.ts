import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AcctExpenseStatus, AcctPaymentMethod, Prisma } from '@prisma/client';
import { AuthUser } from '../common/current-user';
import { localDateKey } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';

// Helpers shared by the accounting services. Everything here is pure (or takes Prisma
// as an argument) so the money and permission rules can be unit-tested without a database.

export const MANAGE = 'accounting.manage';
export const SUBMIT = 'accounting.expenses.submit';

export const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
export const today = () => localDateKey(new Date());

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
export const csv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
export const csvList = ({ value }: { value: unknown }) =>
  value == null || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean);

export const RECEIPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
export const INVOICE_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
/** Client invoice files: the web app compresses any file down to this before upload; the server refuses anything bigger. */
export const MAX_INVOICE_FILE_BYTES = 1024 * 1024;

export const isManager = (u: Pick<AuthUser, 'permissions'>) => u.permissions.has(MANAGE);
export function assertCanSubmit(u: Pick<AuthUser, 'permissions'>) {
  if (!isManager(u) && !u.permissions.has(SUBMIT)) throw new ForbiddenException('You do not have access to accounting');
}

export async function assertClientExists(prisma: PrismaService, clientId?: string | null) {
  if (clientId && !(await prisma.client.count({ where: { id: clientId } }))) throw new BadRequestException('That client does not exist');
}
export async function assertProjectExists(prisma: PrismaService, projectId?: string | null) {
  if (projectId && !(await prisma.acctProject.count({ where: { id: projectId } }))) throw new BadRequestException('That project does not exist');
}

// ───────────────────────── Settings ─────────────────────────

export interface AcctSettingsData {
  companyName: string; tagline: string; address: string; phone: string; email: string; website: string;
  gstin: string; stateCode: string;
  bank: { accountName: string; accountNumber: string; ifsc: string; bankName: string; upiId: string };
  invoicePrefix: string; invoiceDueDays: number; fyStartMonth: number; invoiceTerms: string[];
  /** HSN/SAC filled in on new invoice lines (998365: advertising services). */
  defaultHsn: string;
}

export const DEFAULT_SETTINGS: AcctSettingsData = {
  // As on Prisim's tax invoice.
  companyName: 'Prisim',
  tagline: 'Digital Marketing | Advertising | Lead Generation | Business Growth | Software Development',
  address: 'No.21, Ramachandra Arcad\n3rd Floor, MSRE Road\nBangalore - 560 054.',
  phone: '9742502964',
  email: 'varuncena12@gmail.com',
  website: 'www.prisim.co.in',
  gstin: '29CROPV8759A1ZX',
  stateCode: '29',
  bank: { accountName: '', accountNumber: '', ifsc: '', bankName: '', upiId: '' },
  invoicePrefix: '',
  invoiceDueDays: 15,
  fyStartMonth: 4,
  invoiceTerms: [],
  defaultHsn: '998365',
};

// ───────────────────────── Invoices ─────────────────────────

export type InvoiceItem = { description: string; hsn?: string; qty: number; unit?: string; rate: number };
export type ClientDetails = { contactPerson?: string; phone?: string; email?: string; gstin?: string; address?: string; stateCode?: string };

/** Totals for an invoice. Inside the company's state: CGST + SGST; another state (by GSTIN): IGST. */
export function invoiceTotals(inv: { items: InvoiceItem[]; discount: number; gstRate: number; clientDetails: ClientDetails }, stateCode: string, paid: number) {
  const subtotal = r2(inv.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0));
  const discount = Math.min(subtotal, Math.max(0, r2(Number(inv.discount) || 0)));
  const taxable = r2(subtotal - discount);
  const fromGstin = (inv.clientDetails.gstin ?? '').trim().slice(0, 2);
  const clientState = /^\d{2}$/.test(fromGstin) ? fromGstin : (inv.clientDetails.stateCode ?? '');
  const igst = /^\d{2}$/.test(clientState) && clientState !== stateCode;
  const rate = Number(inv.gstRate) || 0;
  const half = igst ? 0 : r2((taxable * rate) / 200);
  const igstAmt = igst ? r2((taxable * rate) / 100) : 0;
  const gst = r2(half * 2 + igstAmt);
  const total = r2(taxable + gst);
  return { subtotal, discount, taxable, split: igst ? 'igst' : 'cgst_sgst', cgst: half, sgst: half, igst: igstAmt, gst, total, paid: r2(paid), balance: r2(Math.max(0, total - paid)) };
}

export type InvoiceStatus = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'cancelled';

/** Cancelled wins; then fully paid; then past due; then part paid; else unpaid. */
export function invoiceStatus(cancelled: boolean, total: number, paid: number, dueDate: string | null, todayKey: string): InvoiceStatus {
  if (cancelled) return 'cancelled';
  if (total > 0 && paid >= total) return 'paid';
  if (dueDate && dueDate < todayKey) return 'overdue';
  return paid > 0 ? 'partial' : 'unpaid';
}

/** Financial year label: Nov 2026 → "2026-27", Feb 2027 → "2026-27". */
export const fyLabel = (isoDate: string, fyStart: number) => {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= fyStart ? y : y - 1;
  return fyStart === 1 ? String(start) : `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

/** The invoice-number prefix for a date, e.g. "PRS/2026-27/". */
export const invoicePrefix = (s: Pick<AcctSettingsData, 'invoicePrefix' | 'fyStartMonth'>, date: string) =>
  `${s.invoicePrefix ? `${s.invoicePrefix}/` : ''}${fyLabel(date, s.fyStartMonth)}/`;

/** Next number in the sequence: one past the highest plain integer after the prefix. */
export function nextInvoiceSequence(prefix: string, existing: string[]) {
  const max = Math.max(0, ...existing.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)).filter((n) => /^\d+$/.test(n)).map(Number));
  return `${prefix}${max + 1}`;
}

export const person = { select: { id: true, fullName: true } } as const;

export const invoiceInclude = {
  payments: { orderBy: { paidOn: 'asc' } },
  client: { select: { id: true, name: true } },
  project: { select: { id: true, title: true } },
  quotation: { select: { id: true, number: true } },
  createdBy: person,
} satisfies Prisma.AcctInvoiceInclude;
export type InvoiceRow = Prisma.AcctInvoiceGetPayload<{ include: typeof invoiceInclude }>;

export function shapeInvoice(i: InvoiceRow, s: Pick<AcctSettingsData, 'stateCode'>, todayKey = today()) {
  const items = i.items as InvoiceItem[];
  const clientDetails = i.clientDetails as ClientDetails;
  const payments = i.payments.map((p) => ({ ...p, amount: num(p.amount), paidOn: iso(p.paidOn)! }));
  const t = invoiceTotals({ items, discount: num(i.discount), gstRate: num(i.gstRate), clientDetails }, s.stateCode, payments.reduce((a, p) => a + p.amount, 0));
  const due = iso(i.dueDate);
  const status = invoiceStatus(i.cancelled, t.total, t.paid, due, todayKey);
  return { ...i, date: iso(i.date)!, dueDate: due, items, clientDetails, gstRate: num(i.gstRate), payments, ...t, status };
}

// ───────────────────────── Expenses ─────────────────────────

export const expenseInclude = {
  category: { select: { id: true, name: true, parentId: true, parent: { select: { id: true, name: true } } } },
  vendor: { select: { id: true, name: true } },
  project: { select: { id: true, title: true, client: { select: { id: true, name: true } } } },
  submittedBy: person,
  reviewedBy: person,
} satisfies Prisma.AcctExpenseInclude;
export type ExpenseRow = Prisma.AcctExpenseGetPayload<{ include: typeof expenseInclude }>;

export function shapeExpense(e: ExpenseRow) {
  const { receiptKey, ...rest } = e;
  return {
    ...rest, amount: num(e.amount), dateIncurred: iso(e.dateIncurred)!, datePaid: iso(e.datePaid),
    hasReceipt: !!receiptKey,
    categoryLabel: e.category ? (e.category.parent ? `${e.category.parent.name} › ${e.category.name}` : e.category.name) : null,
    topCategoryId: e.category ? e.category.parentId ?? e.category.id : null,
  };
}

export const EXPENSE_SORTS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'created_desc'] as const;

export interface ExpenseFilter {
  from?: string; to?: string; status?: AcctExpenseStatus[];
  categoryId?: string; vendorId?: string; projectId?: string; submittedById?: string;
  paymentMethod?: AcctPaymentMethod; search?: string; tag?: string; receipt?: 'yes' | 'no';
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Expense filter. People without accounting.manage only ever see their own expenses, whatever they ask for. */
export function expenseWhere(u: Pick<AuthUser, 'id' | 'permissions'>, q: ExpenseFilter): Prisma.AcctExpenseWhereInput {
  for (const id of [q.categoryId, q.vendorId, q.projectId]) if (id && id !== 'none' && !UUID.test(id)) throw new BadRequestException('Invalid filter');
  const and: Prisma.AcctExpenseWhereInput[] = [];
  if (!isManager(u)) and.push({ submittedById: u.id });
  if (q.from || q.to) and.push({ dateIncurred: { ...(q.from ? { gte: day(q.from) } : {}), ...(q.to ? { lte: day(q.to) } : {}) } });
  if (q.status?.length) and.push({ status: { in: q.status } });
  if (q.categoryId === 'none') and.push({ categoryId: null });
  else if (q.categoryId) and.push({ OR: [{ categoryId: q.categoryId }, { category: { parentId: q.categoryId } }] });
  if (q.vendorId === 'none') and.push({ vendorId: null });
  else if (q.vendorId) and.push({ vendorId: q.vendorId });
  if (q.projectId === 'none') and.push({ projectId: null });
  else if (q.projectId) and.push({ projectId: q.projectId });
  if (q.submittedById) and.push({ submittedById: q.submittedById });
  if (q.paymentMethod) and.push({ paymentMethod: q.paymentMethod });
  if (q.tag) and.push({ tags: { has: q.tag.trim().toLowerCase() } });
  if (q.receipt) and.push({ receiptKey: q.receipt === 'yes' ? { not: null } : null });
  const s = q.search?.trim();
  if (s) {
    const c = { contains: s, mode: 'insensitive' as const };
    and.push({ OR: [{ description: c }, { vendor: { name: c } }, { category: { name: c } }, { project: { title: c } }, { project: { client: { name: c } } }] });
  }
  return { AND: and };
}

export function expenseOrder(sort?: (typeof EXPENSE_SORTS)[number]): Prisma.AcctExpenseOrderByWithRelationInput[] {
  switch (sort) {
    case 'date_asc': return [{ dateIncurred: 'asc' }, { createdAt: 'asc' }];
    case 'amount_desc': return [{ amount: 'desc' }];
    case 'amount_asc': return [{ amount: 'asc' }];
    case 'created_desc': return [{ createdAt: 'desc' }];
    default: return [{ dateIncurred: 'desc' }, { createdAt: 'desc' }];
  }
}

/**
 * Status change fields for a review. Only managers call this (non-managers' expenses stay PENDING).
 * Back to PENDING clears the reviewer; PAID without a paid date is paid today.
 */
export function reviewFields(reviewerId: string, status: AcctExpenseStatus | undefined, prev: AcctExpenseStatus | null, datePaid: Date | null | undefined, now = new Date(), todayKey = today()) {
  if (!status || status === prev) return {};
  if (status === 'PENDING') return { status, reviewedById: null, reviewedAt: null };
  return { status, reviewedById: reviewerId, reviewedAt: now, ...(status === 'PAID' && !datePaid ? { datePaid: day(todayKey) } : {}) };
}

export const normalizeTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

// ───────────────────────── Projects ─────────────────────────

export type ProjectMoney = { received: number; spent: number; invoiced: number; lastPayment: string | null; paymentCount: number };

/** Billed is the larger of the quote and what has been invoiced; balance never goes negative. */
export function projectFigures(quoted: number | null, money: ProjectMoney) {
  const billed = Math.max(quoted ?? 0, money.invoiced);
  return { balance: r2(Math.max(0, billed - money.received)), profit: r2(money.received - money.spent) };
}
