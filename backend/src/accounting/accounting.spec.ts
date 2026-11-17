import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REQUIRED_PERMS } from '../common/current-user';
import { AccountingController } from './accounting.controller';
import {
  assertCanSubmit, csvCell, expenseWhere, fyLabel, invoicePrefix, invoiceStatus, invoiceTotals, InvoiceRow, MANAGE, nextInvoiceSequence,
  projectFigures, reviewFields, shapeInvoice, SUBMIT,
} from './shared';

const user = (id: string, ...perms: string[]) => ({ id, permissions: new Set(perms) });
const manager = user('m1', MANAGE);
const employee = user('e1', SUBMIT);
const item = (qty: number, rate: number) => ({ description: 'Ads', qty, rate });

describe('invoiceTotals', () => {
  it('splits GST into CGST + SGST inside Karnataka', () => {
    const t = invoiceTotals({ items: [item(2, 5000), item(1, 2500)], discount: 0, gstRate: 18, clientDetails: { gstin: '29ABCDE1234F1Z5' } }, '29', 0);
    expect(t).toMatchObject({ subtotal: 12500, taxable: 12500, split: 'cgst_sgst', cgst: 1125, sgst: 1125, igst: 0, gst: 2250, total: 14750, balance: 14750 });
  });

  it('charges IGST when the client GSTIN is from another state', () => {
    const t = invoiceTotals({ items: [item(1, 10000)], discount: 0, gstRate: 18, clientDetails: { gstin: '33ABCDE1234F1Z5' } }, '29', 0);
    expect(t).toMatchObject({ split: 'igst', cgst: 0, sgst: 0, igst: 1800, total: 11800 });
  });

  it('falls back to the state code when there is no GSTIN', () => {
    expect(invoiceTotals({ items: [item(1, 100)], discount: 0, gstRate: 18, clientDetails: { stateCode: '27' } }, '29', 0).split).toBe('igst');
    expect(invoiceTotals({ items: [item(1, 100)], discount: 0, gstRate: 18, clientDetails: {} }, '29', 0).split).toBe('cgst_sgst');
  });

  it('the GSTIN wins over a conflicting state code', () => {
    const t = invoiceTotals({ items: [item(1, 100)], discount: 0, gstRate: 18, clientDetails: { gstin: '29ABCDE1234F1Z5', stateCode: '27' } }, '29', 0);
    expect(t.split).toBe('cgst_sgst');
  });

  it('applies the discount before tax and never lets it exceed the subtotal', () => {
    const t = invoiceTotals({ items: [item(1, 1000)], discount: 200, gstRate: 18, clientDetails: {} }, '29', 0);
    expect(t).toMatchObject({ discount: 200, taxable: 800, gst: 144, total: 944 });
    const over = invoiceTotals({ items: [item(1, 1000)], discount: 5000, gstRate: 18, clientDetails: {} }, '29', 0);
    expect(over).toMatchObject({ discount: 1000, taxable: 0, total: 0 });
    expect(invoiceTotals({ items: [item(1, 1000)], discount: -50, gstRate: 0, clientDetails: {} }, '29', 0).discount).toBe(0);
  });

  it('rounds to paise and keeps CGST + SGST equal to the GST total', () => {
    const t = invoiceTotals({ items: [item(3, 333.33)], discount: 0, gstRate: 18, clientDetails: {} }, '29', 0);
    expect(t.subtotal).toBe(999.99);
    expect(t.cgst).toBe(90);
    expect(t.gst).toBe(t.cgst + t.sgst);
    expect(t.total).toBe(1179.99);
  });

  it('handles fractional quantities', () => {
    expect(invoiceTotals({ items: [item(1.5, 1000)], discount: 0, gstRate: 0, clientDetails: {} }, '29', 0).total).toBe(1500);
  });

  it('balance is total minus paid, and never negative', () => {
    expect(invoiceTotals({ items: [item(1, 1000)], discount: 0, gstRate: 0, clientDetails: {} }, '29', 400).balance).toBe(600);
    expect(invoiceTotals({ items: [item(1, 1000)], discount: 0, gstRate: 0, clientDetails: {} }, '29', 1500).balance).toBe(0);
  });
});

describe('invoiceStatus', () => {
  const today = '2026-11-17';
  it('cancelled beats everything', () => expect(invoiceStatus(true, 100, 100, '2026-01-01', today)).toBe('cancelled'));
  it('fully paid is paid even when past due', () => expect(invoiceStatus(false, 100, 100, '2026-01-01', today)).toBe('paid'));
  it('past due and not fully paid is overdue', () => expect(invoiceStatus(false, 100, 40, '2026-11-16', today)).toBe('overdue'));
  it('due today is not overdue yet', () => expect(invoiceStatus(false, 100, 0, today, today)).toBe('unpaid'));
  it('part paid before due is partial', () => expect(invoiceStatus(false, 100, 40, '2026-12-01', today)).toBe('partial'));
  it('a zero invoice is not "paid"', () => expect(invoiceStatus(false, 0, 0, null, today)).toBe('unpaid'));
});

describe('shapeInvoice', () => {
  it('adds up recorded payments into paid / balance / status', () => {
    const row = {
      id: 'i1', number: '2026-27/1', cancelled: false, date: new Date('2026-11-01T00:00:00Z'), dueDate: new Date('2026-11-30T00:00:00Z'),
      items: [item(1, 1000)], clientDetails: {}, discount: new Prisma.Decimal(0), gstRate: new Prisma.Decimal(18),
      payments: [{ amount: new Prisma.Decimal(500), paidOn: new Date('2026-11-05T00:00:00Z') }, { amount: new Prisma.Decimal(180), paidOn: new Date('2026-11-06T00:00:00Z') }],
    } as unknown as InvoiceRow;
    const s = shapeInvoice(row, { stateCode: '29' }, '2026-11-17');
    expect(s).toMatchObject({ total: 1180, paid: 680, balance: 500, status: 'partial', date: '2026-11-01', dueDate: '2026-11-30', gstRate: 18 });
    expect(s.payments.map((p) => p.paidOn)).toEqual(['2026-11-05', '2026-11-06']);
  });
});

describe('invoice numbering', () => {
  it('labels Indian financial years from April', () => {
    expect(fyLabel('2026-11-17', 4)).toBe('2026-27');
    expect(fyLabel('2027-02-10', 4)).toBe('2026-27');
    expect(fyLabel('2027-04-01', 4)).toBe('2027-28');
    expect(fyLabel('2099-05-01', 4)).toBe('2099-00');
    expect(fyLabel('2026-03-01', 1)).toBe('2026');
  });

  it('builds the prefix with and without a company prefix', () => {
    expect(invoicePrefix({ invoicePrefix: '', fyStartMonth: 4 }, '2026-11-17')).toBe('2026-27/');
    expect(invoicePrefix({ invoicePrefix: 'PRS', fyStartMonth: 4 }, '2026-11-17')).toBe('PRS/2026-27/');
  });

  it('continues from the highest number and ignores hand-typed oddities', () => {
    expect(nextInvoiceSequence('2026-27/', [])).toBe('2026-27/1');
    expect(nextInvoiceSequence('2026-27/', ['2026-27/2', '2026-27/10', '2026-27/9'])).toBe('2026-27/11');
    expect(nextInvoiceSequence('2026-27/', ['2026-27/7A', '2026-27/', '2025-26/40', '2026-27/3'])).toBe('2026-27/4');
  });
});

describe('expense access', () => {
  it('only accounting managers and submitters get in', () => {
    expect(() => assertCanSubmit(manager)).not.toThrow();
    expect(() => assertCanSubmit(employee)).not.toThrow();
    expect(() => assertCanSubmit(user('x'))).toThrow(ForbiddenException);
  });

  it('a submitter only ever sees their own expenses, even when asking for someone else', () => {
    const where = expenseWhere(employee, { submittedById: 'someone-else' });
    expect(where.AND).toEqual(expect.arrayContaining([{ submittedById: 'e1' }, { submittedById: 'someone-else' }]));
    // Both conditions are ANDed, so the result is empty rather than another person's data.
  });

  it('a manager is not restricted to their own', () => {
    expect(expenseWhere(manager, {}).AND).toEqual([]);
  });

  it('rejects filter ids that are not uuids', () => {
    expect(() => expenseWhere(manager, { categoryId: "x' OR 1=1" })).toThrow(BadRequestException);
    expect(() => expenseWhere(manager, { categoryId: 'none', vendorId: 'none', projectId: 'none' })).not.toThrow();
  });
});

describe('reviewFields', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  it('does nothing when the status is unchanged', () => expect(reviewFields('m1', 'APPROVED', 'APPROVED', null, now)).toEqual({}));
  it('records the reviewer on approval', () => expect(reviewFields('m1', 'APPROVED', 'PENDING', null, now)).toEqual({ status: 'APPROVED', reviewedById: 'm1', reviewedAt: now }));
  it('marking PAID without a date pays it today', () => {
    expect(reviewFields('m1', 'PAID', 'APPROVED', null, now, '2026-11-17')).toMatchObject({ status: 'PAID', datePaid: new Date('2026-11-17T00:00:00Z') });
    expect(reviewFields('m1', 'PAID', 'APPROVED', new Date('2026-11-01'), now)).not.toHaveProperty('datePaid');
  });
  it('back to PENDING clears the reviewer', () => expect(reviewFields('m1', 'PENDING', 'REJECTED', null, now)).toEqual({ status: 'PENDING', reviewedById: null, reviewedAt: null }));
});

describe('projectFigures', () => {
  const money = (received: number, spent: number, invoiced: number) => ({ received, spent, invoiced, lastPayment: null, paymentCount: 0 });
  it('bills the larger of quote and invoiced', () => {
    expect(projectFigures(50000, money(20000, 5000, 0))).toEqual({ balance: 30000, profit: 15000 });
    expect(projectFigures(50000, money(20000, 0, 59000))).toEqual({ balance: 39000, profit: 20000 });
    expect(projectFigures(null, money(0, 0, 0))).toEqual({ balance: 0, profit: 0 });
  });
  it('overpayment does not produce a negative balance; loss shows as negative profit', () => {
    expect(projectFigures(1000, money(1500, 2000, 0))).toEqual({ balance: 0, profit: -500 });
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+91 98450')).toBe(`"'+91 98450"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@sum')).toBe(`"'@sum"`);
  });
  it('quotes commas and newlines, leaves plain text alone', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });
});

describe('accounting routes', () => {
  // Routes a plain expense submitter may call. The service limits them to their own expenses.
  const SUBMITTER_ROUTES = new Set(['lookups', 'listExpenses', 'exportExpenses', 'createExpense', 'updateExpense', 'removeExpense', 'attachReceipt', 'receipt', 'removeReceipt']);
  const proto = AccountingController.prototype as unknown as Record<string, unknown>;
  const routes = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function');

  it.each(routes)('%s is guarded correctly', (name) => {
    const perms = Reflect.getMetadata(REQUIRED_PERMS, proto[name] as object) as string[] | undefined;
    if (SUBMITTER_ROUTES.has(name)) expect(perms).toBeUndefined();
    else expect(perms).toEqual([MANAGE]);
  });
});
