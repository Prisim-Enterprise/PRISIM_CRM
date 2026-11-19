import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_PAYROLL_SETTINGS } from './payroll-calc';

const ON = { ...DEFAULT_PAYROLL_SETTINGS, statutory: { pf: true, esi: true, pt: true, tds: true } };
import { computePayslip, PayrollService, PayslipSnapshot, runTotals } from './payroll.service';

const u = { id: 'admin', permissions: new Set(['accounting.payroll.manage']) } as never;

const snap: PayslipSnapshot = {
  code: 'EMP001', fullName: 'Asha Rao', email: null, designation: 'Designer', department: 'Creative', location: 'Bangalore',
  dateOfJoining: '2025-01-01', dateOfLeaving: null, pan: 'ABCDE1234F', uan: '100000000001', pfNumber: null, esiNumber: null,
  bankName: 'HDFC Bank', accountNumber: '50100012345678', ifsc: 'HDFC0001234', paymentMethod: 'BANK_TRANSFER',
  components: [{ name: 'Basic', amount: 20000, pf: true }, { name: 'Special Allowance', amount: 20000 }],
  pfEnabled: true, pfCapped: true, esiEnabled: true, ptEnabled: true, monthlyTds: 1000,
};
const noAdj = { lopDays: 0, extraEarnings: [], otherDeductions: [], tdsOverride: null };
const calc = computePayslip('2026-11', snap, noAdj, ON);
const slip = (over: Record<string, unknown> = {}) => ({
  id: 'p1', runId: 'r1', employeeId: 'e1', snapshot: snap, lopDays: new Prisma.Decimal(0), extraEarnings: [], otherDeductions: [], tdsOverride: null, remarks: null,
  calc, gross: new Prisma.Decimal(calc.gross), totalDeductions: new Prisma.Decimal(calc.totalDeductions), netPay: new Prisma.Decimal(calc.netPay), employerCost: new Prisma.Decimal(calc.employerCost),
  employee: { userId: 'u1' }, ...over,
});

function setup(status: 'DRAFT' | 'FINALISED' | 'PAID', slips = [slip()]) {
  const run = { id: 'r1', month: '2026-11', status, paidOn: null, expenseId: status === 'PAID' ? 'x1' : null, notes: null, createdById: 'admin', finalisedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const prisma = {
    payrollRun: { findUnique: jest.fn().mockResolvedValue({ ...run, payslips: slips }), update: jest.fn().mockResolvedValue(run) },
    payrollEmployee: { findMany: jest.fn().mockResolvedValue([]) },
    payrollSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    acctCategory: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'cat1' }) },
    acctExpense: { create: jest.fn().mockResolvedValue({ id: 'x1' }), deleteMany: jest.fn() },
    payslip: { findFirst: jest.fn() },
  };
  const company = { settings: jest.fn().mockResolvedValue({ companyName: 'Prisim', address: 'Bangalore', phone: '', email: '', website: '' }) };
  const svc = new PayrollService(prisma as never, { record: jest.fn() } as never, company as never);
  return { svc, prisma };
}

describe('payroll runs', () => {
  it('totals what is owed to PF, ESI, Professional Tax and income tax', () => {
    const t = runTotals([slip(), slip()] as never);
    expect(t).toMatchObject({ employees: 2, gross: 80000, pfEmployee: 3600, pt: 400, tds: 2000, esiEmployee: 0, eps: 2500, epf: 1100, pfEmployer: 3600 });
    expect(t.net).toBe(2 * (40000 - 1800 - 200 - 1000));
  });

  it('marking paid records the month\'s salary cost as a paid expense under Salaries & Wages', async () => {
    const { svc, prisma } = setup('FINALISED');
    await svc.payRun(u, 'r1', { paidOn: '2026-12-01' });
    expect(prisma.acctCategory.create).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Salaries & Wages' } }));
    const data = prisma.acctExpense.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ amount: calc.employerCost, categoryId: 'cat1', status: 'PAID', tags: ['payroll'] });
    expect(data.dateIncurred.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(prisma.payrollRun.update.mock.calls[0][0].data).toMatchObject({ status: 'PAID', expenseId: 'x1' });
  });

  it('can be marked paid without recording an expense', async () => {
    const { svc, prisma } = setup('FINALISED');
    await svc.payRun(u, 'r1', { paidOn: '2026-12-01', recordExpense: false });
    expect(prisma.acctExpense.create).not.toHaveBeenCalled();
  });

  it('a draft must be finalised before it is paid', async () => {
    const { svc } = setup('DRAFT');
    await expect(svc.payRun(u, 'r1', { paidOn: '2026-12-01' })).rejects.toThrow(BadRequestException);
  });

  it('marking unpaid removes the salary expense', async () => {
    const { svc, prisma } = setup('PAID');
    await svc.unpayRun(u, 'r1');
    expect(prisma.acctExpense.deleteMany).toHaveBeenCalledWith({ where: { id: 'x1' } });
    expect(prisma.payrollRun.update.mock.calls[0][0].data).toMatchObject({ status: 'FINALISED', expenseId: null });
  });

  it('will not finalise a payslip with net pay below zero', async () => {
    const { svc } = setup('DRAFT', [slip({ netPay: new Prisma.Decimal(-10) })]);
    await expect(svc.finaliseRun(u, 'r1')).rejects.toThrow(/below zero for Asha Rao/);
  });

  it('a paid payroll cannot be reopened until it is marked unpaid', async () => {
    const { svc } = setup('PAID');
    await expect(svc.reopenRun(u, 'r1')).rejects.toThrow(/Mark it unpaid first/);
  });
});

describe('employee\'s own payslips', () => {
  it('only finalised or paid months, only their own, without the employer\'s costs', async () => {
    const { svc, prisma } = setup('FINALISED');
    prisma.payslip.findFirst.mockResolvedValue({ ...slip(), run: { id: 'r1', month: '2026-11', status: 'FINALISED', paidOn: null } });
    const p = await svc.myPayslip({ id: 'u1' } as never, 'p1');
    expect(prisma.payslip.findFirst.mock.calls[0][0].where).toEqual({ id: 'p1', employee: { userId: 'u1' }, run: { status: { in: ['FINALISED', 'PAID'] } } });
    expect(p.employerCost).toBeUndefined();
    expect(p.calc.employer).toBeUndefined();
    expect(p.netPay).toBe(calc.netPay);
  });
});
