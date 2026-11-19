import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PayrollEmployee, PayrollRun, Payslip, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/current-user';
import { AccountingSettingsService } from '../accounting/settings.service';
import { csv, day, iso, num } from '../accounting/shared';
import { EmployeeDto, PayDto, PayrollSettingsDto, PayslipDto, RunDto } from './payroll.dto';
import {
  calculatePay, daysInMonth, employedInMonth, LineItem, monthLabel, PayResult, PayrollSettings, r2, SalaryComponent, withDefaults,
} from './payroll-calc';

/** Employee details copied onto a payslip when it is made, so later edits don't change past payslips. */
export interface PayslipSnapshot {
  code: string; fullName: string; email: string | null; designation: string | null; department: string | null; location: string | null;
  dateOfJoining: string; dateOfLeaving: string | null; pan: string | null; uan: string | null; pfNumber: string | null; esiNumber: string | null;
  bankName: string | null; accountNumber: string | null; ifsc: string | null; paymentMethod: string;
  components: SalaryComponent[]; pfEnabled: boolean; pfCapped: boolean; esiEnabled: boolean; ptEnabled: boolean; monthlyTds: number;
}

const SALARY_CATEGORY = 'Salaries & Wages';
const PAY_MODES: Record<string, string> = { BANK_TRANSFER: 'Bank transfer', UPI: 'UPI', CASH: 'Cash', CARD: 'Card', CHEQUE: 'Cheque', OTHER: 'Other' };
const blank = (v?: string | null) => (v?.trim() ? v.trim() : null);
const json = (v: unknown) => v as Prisma.InputJsonValue;
const lineItems = (v: Prisma.JsonValue): LineItem[] => (Array.isArray(v) ? (v as unknown as LineItem[]) : []);

function snapshotOf(e: PayrollEmployee): PayslipSnapshot {
  return {
    code: e.code, fullName: e.fullName, email: e.email, designation: e.designation, department: e.department, location: e.location,
    dateOfJoining: iso(e.dateOfJoining)!, dateOfLeaving: iso(e.dateOfLeaving), pan: e.pan, uan: e.uan, pfNumber: e.pfNumber, esiNumber: e.esiNumber,
    bankName: e.bankName, accountNumber: e.accountNumber, ifsc: e.ifsc, paymentMethod: e.paymentMethod,
    components: e.components as unknown as SalaryComponent[], pfEnabled: e.pfEnabled, pfCapped: e.pfCapped, esiEnabled: e.esiEnabled,
    ptEnabled: e.ptEnabled, monthlyTds: num(e.monthlyTds),
  };
}

/** Works out a payslip from its employee snapshot and this month's adjustments. */
export function computePayslip(
  month: string, snap: PayslipSnapshot, adj: { lopDays: number; extraEarnings: LineItem[]; otherDeductions: LineItem[]; tdsOverride: number | null }, s: PayrollSettings,
): PayResult {
  return calculatePay({
    month, components: snap.components, dateOfJoining: snap.dateOfJoining, dateOfLeaving: snap.dateOfLeaving,
    lopDays: adj.lopDays, extraEarnings: adj.extraEarnings, otherDeductions: adj.otherDeductions,
    tds: adj.tdsOverride ?? snap.monthlyTds,
    pfEnabled: snap.pfEnabled, pfCapped: snap.pfCapped, esiEnabled: snap.esiEnabled, ptEnabled: snap.ptEnabled,
  }, s);
}

const money = (c: PayResult) => ({ calc: json(c), gross: c.gross, totalDeductions: c.totalDeductions, netPay: c.netPay, employerCost: c.employerCost });

type RunWithSlips = PayrollRun & { payslips: (Payslip & { employee: { userId: string | null } })[] };

/** Totals for a run, including what is owed to PF, ESI, Professional Tax and income tax. */
export function runTotals(slips: Pick<Payslip, 'calc'>[]) {
  const t = { employees: slips.length, gross: 0, deductions: 0, net: 0, employerCost: 0, pfEmployee: 0, pfEmployer: 0, eps: 0, epf: 0, edli: 0, pfAdmin: 0, esiEmployee: 0, esiEmployer: 0, pt: 0, tds: 0, other: 0 };
  for (const p of slips) {
    const c = p.calc as unknown as PayResult;
    t.gross += c.gross; t.deductions += c.totalDeductions; t.net += c.netPay; t.employerCost += c.employerCost;
    t.eps += c.employer.eps; t.epf += c.employer.epf; t.edli += c.employer.edli; t.pfAdmin += c.employer.pfAdmin; t.esiEmployer += c.employer.esi;
    for (const d of c.deductions) {
      if (d.key === 'pf') t.pfEmployee += d.amount;
      else if (d.key === 'esi') t.esiEmployee += d.amount;
      else if (d.key === 'pt') t.pt += d.amount;
      else if (d.key === 'tds') t.tds += d.amount;
      else t.other += d.amount;
    }
  }
  t.pfEmployer = t.epf + t.eps;
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k === 'employees' ? v : r2(v)])) as typeof t;
}

/** Employees, salary structures, monthly payroll runs and payslips. */
@Injectable()
export class PayrollService {
  constructor(private prisma: PrismaService, private audit: AuditService, private company: AccountingSettingsService) {}

  // ───────────────────────── Settings ─────────────────────────

  async settings(): Promise<PayrollSettings> {
    const row = await this.prisma.payrollSetting.findUnique({ where: { id: 1 } });
    return withDefaults(row?.data as Partial<PayrollSettings> | undefined);
  }

  async saveSettings(u: AuthUser, dto: PayrollSettingsDto) {
    const data = withDefaults({ ...dto, defaultComponents: dto.defaultComponents.map((c) => ({ name: c.name.trim(), amount: c.amount, pf: !!c.pf })) });
    await this.prisma.payrollSetting.upsert({ where: { id: 1 }, create: { id: 1, data: json(data) }, update: { data: json(data) } });
    await this.audit.record({ actorId: u.id, action: 'payroll.settings_updated', entityType: 'payroll', after: { statutory: data.statutory, pf: data.pf, esi: data.esi, pt: data.pt, lopBasis: data.lopBasis } });
    return data;
  }

  // ───────────────────────── Employees ─────────────────────────

  async employees() {
    const [rows, s] = await Promise.all([
      this.prisma.payrollEmployee.findMany({ orderBy: [{ dateOfLeaving: { sort: 'desc', nulls: 'first' } }, { code: 'asc' }], include: { user: { select: { id: true, fullName: true, email: true } }, _count: { select: { payslips: true } } } }),
      this.settings(),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    return rows.map(({ _count, ...e }) => {
      // A full month's pay with no adjustments, to show the take-home and cost of the salary.
      const snap = snapshotOf(e);
      const c = computePayslip(month, { ...snap, dateOfJoining: '1900-01-01', dateOfLeaving: null }, { lopDays: 0, extraEarnings: [], otherDeductions: [], tdsOverride: null }, s);
      return { ...this.shapeEmployee(e), user: e.user, payslipCount: _count.payslips, monthly: { gross: c.fullGross, net: c.netPay, employerCost: c.employerCost, annualCtc: r2(c.employerCost * 12) } };
    });
  }

  private shapeEmployee(e: PayrollEmployee) {
    return { ...e, dateOfJoining: iso(e.dateOfJoining), dateOfLeaving: iso(e.dateOfLeaving), monthlyTds: num(e.monthlyTds), active: !e.dateOfLeaving || iso(e.dateOfLeaving)! >= new Date().toISOString().slice(0, 10) };
  }

  /** EMP001, EMP002… one past the highest number in use. */
  async nextCode() {
    const codes = (await this.prisma.payrollEmployee.findMany({ select: { code: true } })).map((c) => c.code);
    const max = Math.max(0, ...codes.map((c) => /^EMP(\d+)$/i.exec(c)?.[1]).filter(Boolean).map(Number));
    return `EMP${String(max + 1).padStart(3, '0')}`;
  }

  private employeeData(dto: EmployeeDto) {
    const components = dto.components.map((c) => ({ name: c.name.trim(), amount: r2(c.amount), pf: !!c.pf })).filter((c) => c.name);
    if (!components.some((c) => c.amount > 0)) throw new BadRequestException('Add the salary: at least one part with an amount');
    if (dto.dateOfLeaving && dto.dateOfLeaving.slice(0, 10) < dto.dateOfJoining.slice(0, 10)) throw new BadRequestException('The leaving date is before the joining date');
    return {
      userId: dto.userId ?? null, fullName: dto.fullName.trim(), email: blank(dto.email)?.toLowerCase() ?? null, phone: blank(dto.phone),
      designation: blank(dto.designation), department: blank(dto.department), location: blank(dto.location),
      dateOfJoining: day(dto.dateOfJoining), dateOfLeaving: dto.dateOfLeaving ? day(dto.dateOfLeaving) : null,
      pan: blank(dto.pan)?.toUpperCase() ?? null, uan: blank(dto.uan), pfNumber: blank(dto.pfNumber)?.toUpperCase() ?? null, esiNumber: blank(dto.esiNumber),
      bankName: blank(dto.bankName), accountNumber: blank(dto.accountNumber), ifsc: blank(dto.ifsc)?.toUpperCase() ?? null,
      paymentMethod: dto.paymentMethod ?? 'BANK_TRANSFER', components: json(components),
      pfEnabled: dto.pfEnabled ?? true, pfCapped: dto.pfCapped ?? true, esiEnabled: dto.esiEnabled ?? true, ptEnabled: dto.ptEnabled ?? true,
      monthlyTds: r2(dto.monthlyTds ?? 0), notes: blank(dto.notes),
    };
  }

  private async checkUser(userId: string | null | undefined, exceptId?: string) {
    if (!userId) return;
    if (!(await this.prisma.user.count({ where: { id: userId, deletedAt: null } }))) throw new BadRequestException('That CRM user does not exist');
    const taken = await this.prisma.payrollEmployee.findFirst({ where: { userId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { fullName: true } });
    if (taken) throw new ConflictException(`That CRM user is already linked to ${taken.fullName}`);
  }

  private async codeFree(code: string, exceptId?: string) {
    const taken = await this.prisma.payrollEmployee.findFirst({ where: { code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { fullName: true } });
    if (taken) throw new ConflictException(`Employee ID ${code} is already used by ${taken.fullName}`);
  }

  async createEmployee(u: AuthUser, dto: EmployeeDto) {
    await this.checkUser(dto.userId);
    const code = dto.code?.trim().toUpperCase() || (await this.nextCode());
    await this.codeFree(code);
    const e = await this.prisma.payrollEmployee.create({ data: { ...this.employeeData(dto), code } });
    await this.audit.record({ actorId: u.id, action: 'payroll.employee_created', entityType: 'payroll_employee', entityId: e.id, after: { code, fullName: e.fullName } });
    return this.shapeEmployee(e);
  }

  async updateEmployee(u: AuthUser, id: string, dto: EmployeeDto) {
    const before = await this.prisma.payrollEmployee.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Employee not found');
    await this.checkUser(dto.userId, id);
    const code = dto.code?.trim().toUpperCase() || before.code;
    await this.codeFree(code, id);
    const e = await this.prisma.payrollEmployee.update({ where: { id }, data: { ...this.employeeData(dto), code } });
    await this.audit.record({
      actorId: u.id, action: 'payroll.employee_updated', entityType: 'payroll_employee', entityId: id,
      before: { components: before.components, monthlyTds: num(before.monthlyTds), dateOfLeaving: iso(before.dateOfLeaving) },
      after: { components: e.components, monthlyTds: num(e.monthlyTds), dateOfLeaving: iso(e.dateOfLeaving) },
    });
    return this.shapeEmployee(e);
  }

  async removeEmployee(u: AuthUser, id: string) {
    const e = await this.prisma.payrollEmployee.findUnique({ where: { id }, include: { _count: { select: { payslips: true } } } });
    if (!e) throw new NotFoundException('Employee not found');
    if (e._count.payslips) throw new BadRequestException('This person has payslips, so they are kept on record. Set a leaving date instead.');
    await this.prisma.payrollEmployee.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'payroll.employee_deleted', entityType: 'payroll_employee', entityId: id, before: { code: e.code, fullName: e.fullName } });
    return { deleted: true };
  }

  /** CRM users who can be linked to an employee (so they see their own payslips). */
  async linkableUsers() {
    return this.prisma.user.findMany({ where: { deletedAt: null }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, email: true, payrollProfile: { select: { id: true } } } })
      .then((rows) => rows.map(({ payrollProfile, ...x }) => ({ ...x, employeeId: payrollProfile?.id ?? null })));
  }

  // ───────────────────────── Runs ─────────────────────────

  async runs() {
    const rows = await this.prisma.payrollRun.findMany({ orderBy: { month: 'desc' }, include: { payslips: { select: { calc: true } } } });
    return rows.map(({ payslips, ...r }) => ({ ...this.shapeRun(r), totals: runTotals(payslips) }));
  }

  private shapeRun(r: PayrollRun) {
    return { ...r, paidOn: iso(r.paidOn), label: monthLabel(r.month) };
  }

  private async loadRun(id: string): Promise<RunWithSlips> {
    const run = await this.prisma.payrollRun.findUnique({ where: { id }, include: { payslips: { include: { employee: { select: { userId: true } } } } } });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  private shapePayslip(p: Payslip) {
    return {
      id: p.id, runId: p.runId, employeeId: p.employeeId, snapshot: p.snapshot as unknown as PayslipSnapshot,
      lopDays: num(p.lopDays), extraEarnings: lineItems(p.extraEarnings), otherDeductions: lineItems(p.otherDeductions),
      tdsOverride: p.tdsOverride == null ? null : num(p.tdsOverride), remarks: p.remarks, calc: p.calc as unknown as PayResult,
      gross: num(p.gross), totalDeductions: num(p.totalDeductions), netPay: num(p.netPay), employerCost: num(p.employerCost),
    };
  }

  async run(id: string) {
    const run = await this.loadRun(id);
    const slips = [...run.payslips].sort((a, b) => (a.snapshot as unknown as PayslipSnapshot).code.localeCompare((b.snapshot as unknown as PayslipSnapshot).code));
    // Employees on the payroll this month who have no payslip in the run yet.
    const inRun = new Set(run.payslips.map((p) => p.employeeId));
    const missing = run.status === 'DRAFT' ? (await this.eligible(run.month)).filter((e) => !inRun.has(e.id)).map((e) => ({ id: e.id, code: e.code, fullName: e.fullName })) : [];
    return { ...this.shapeRun(run), totals: runTotals(slips), payslips: slips.map((p) => this.shapePayslip(p)), missing };
  }

  private async eligible(month: string) {
    const all = await this.prisma.payrollEmployee.findMany({ orderBy: { code: 'asc' } });
    return all.filter((e) => employedInMonth(month, iso(e.dateOfJoining)!, iso(e.dateOfLeaving)));
  }

  private async newPayslip(runId: string, month: string, e: PayrollEmployee, s: PayrollSettings) {
    const snapshot = snapshotOf(e);
    const c = computePayslip(month, snapshot, { lopDays: 0, extraEarnings: [], otherDeductions: [], tdsOverride: null }, s);
    return { runId, employeeId: e.id, snapshot: json(snapshot), ...money(c) };
  }

  /** Starts a month's payroll with a payslip for everyone employed in that month. */
  async createRun(u: AuthUser, dto: RunDto) {
    if (await this.prisma.payrollRun.count({ where: { month: dto.month } })) throw new ConflictException(`Payroll for ${monthLabel(dto.month)} already exists`);
    const [employees, s] = await Promise.all([this.eligible(dto.month), this.settings()]);
    if (!employees.length) throw new BadRequestException(`Nobody is on the payroll in ${monthLabel(dto.month)}. Add employees first.`);
    const run = await this.prisma.$transaction(async (tx) => {
      const r = await tx.payrollRun.create({ data: { month: dto.month, createdById: u.id } });
      await tx.payslip.createMany({ data: await Promise.all(employees.map((e) => this.newPayslip(r.id, dto.month, e, s))) });
      return r;
    });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_created', entityType: 'payroll_run', entityId: run.id, after: { month: dto.month, employees: employees.length } });
    return this.run(run.id);
  }

  private assertDraft(run: PayrollRun) {
    if (run.status !== 'DRAFT') throw new BadRequestException('This payroll is finalised. Reopen it to make changes.');
  }

  /**
   * Picks up changes to employees' details and salaries (keeping this month's loss of pay and
   * adjustments), adds anyone missing, and drops anyone no longer employed in the month.
   */
  async refreshRun(u: AuthUser, id: string) {
    const run = await this.loadRun(id);
    this.assertDraft(run);
    const [employees, s] = await Promise.all([this.eligible(run.month), this.settings()]);
    const byId = new Map(employees.map((e) => [e.id, e]));
    const existing = new Set(run.payslips.map((p) => p.employeeId));
    await this.prisma.$transaction(async (tx) => {
      for (const p of run.payslips) {
        const e = byId.get(p.employeeId);
        if (!e) { await tx.payslip.delete({ where: { id: p.id } }); continue; }
        const snapshot = snapshotOf(e);
        const c = computePayslip(run.month, snapshot, this.adjustments(p), s);
        await tx.payslip.update({ where: { id: p.id }, data: { snapshot: json(snapshot), ...money(c) } });
      }
      const added = employees.filter((e) => !existing.has(e.id));
      if (added.length) await tx.payslip.createMany({ data: await Promise.all(added.map((e) => this.newPayslip(run.id, run.month, e, s))) });
    });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_refreshed', entityType: 'payroll_run', entityId: id });
    return this.run(id);
  }

  private adjustments(p: Payslip) {
    return { lopDays: num(p.lopDays), extraEarnings: lineItems(p.extraEarnings), otherDeductions: lineItems(p.otherDeductions), tdsOverride: p.tdsOverride == null ? null : num(p.tdsOverride) };
  }

  async removeRun(u: AuthUser, id: string) {
    const run = await this.loadRun(id);
    this.assertDraft(run);
    await this.prisma.payrollRun.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_deleted', entityType: 'payroll_run', entityId: id, before: { month: run.month } });
    return { deleted: true };
  }

  /** Locks the run. Its payslips then show to the employees linked to a CRM user. */
  async finaliseRun(u: AuthUser, id: string) {
    const run = await this.loadRun(id);
    this.assertDraft(run);
    if (!run.payslips.length) throw new BadRequestException('There are no payslips in this payroll');
    const negative = run.payslips.filter((p) => num(p.netPay) < 0).map((p) => (p.snapshot as unknown as PayslipSnapshot).fullName);
    if (negative.length) throw new BadRequestException(`Net pay is below zero for ${negative.join(', ')}. Reduce their deductions first.`);
    await this.prisma.payrollRun.update({ where: { id }, data: { status: 'FINALISED', finalisedAt: new Date() } });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_finalised', entityType: 'payroll_run', entityId: id, after: runTotals(run.payslips) });
    return this.run(id);
  }

  /** Back to draft for corrections. A paid payroll must be marked unpaid first. */
  async reopenRun(u: AuthUser, id: string) {
    const run = await this.loadRun(id);
    if (run.status === 'PAID') throw new BadRequestException('This payroll is marked paid. Mark it unpaid first.');
    if (run.status === 'DRAFT') return this.run(id);
    await this.prisma.payrollRun.update({ where: { id }, data: { status: 'DRAFT', finalisedAt: null } });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_reopened', entityType: 'payroll_run', entityId: id });
    return this.run(id);
  }

  /** Marks the salaries paid and, if asked, records the month's salary cost as an Accounting expense. */
  async payRun(u: AuthUser, id: string, dto: PayDto) {
    const run = await this.loadRun(id);
    if (run.status === 'DRAFT') throw new BadRequestException('Finalise the payroll before marking it paid');
    if (run.status === 'PAID') throw new BadRequestException('This payroll is already marked paid');
    const totals = runTotals(run.payslips);
    const paidOn = day(dto.paidOn);
    let expenseId: string | null = null;
    if (dto.recordExpense ?? true) {
      const category = await this.salaryCategory();
      const lastDay = `${run.month}-${String(daysInMonth(run.month)).padStart(2, '0')}`;
      const expense = await this.prisma.acctExpense.create({
        data: {
          amount: totals.employerCost, dateIncurred: day(lastDay), datePaid: paidOn, categoryId: category, paymentMethod: dto.method ?? 'BANK_TRANSFER',
          status: 'PAID', reviewedById: u.id, reviewedAt: new Date(), submittedById: u.id, tags: ['payroll'],
          description: [
            `Payroll ${monthLabel(run.month)}: ${totals.employees} employee${totals.employees === 1 ? '' : 's'}.`, `Gross Rs. ${totals.gross},`,
            totals.employerCost > totals.gross ? `employer contributions Rs. ${r2(totals.employerCost - totals.gross)},` : '', `net paid Rs. ${totals.net}.`,
          ].filter(Boolean).join(' '),
        },
      });
      expenseId = expense.id;
    }
    await this.prisma.payrollRun.update({ where: { id }, data: { status: 'PAID', paidOn, expenseId } });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_paid', entityType: 'payroll_run', entityId: id, after: { paidOn: dto.paidOn, net: totals.net, expenseId } });
    return this.run(id);
  }

  /** Back to finalised; the salary expense recorded with the payment is removed. */
  async unpayRun(u: AuthUser, id: string) {
    const run = await this.loadRun(id);
    if (run.status !== 'PAID') throw new BadRequestException('This payroll is not marked paid');
    if (run.expenseId) await this.prisma.acctExpense.deleteMany({ where: { id: run.expenseId } });
    await this.prisma.payrollRun.update({ where: { id }, data: { status: 'FINALISED', paidOn: null, expenseId: null } });
    await this.audit.record({ actorId: u.id, action: 'payroll.run_unpaid', entityType: 'payroll_run', entityId: id });
    return this.run(id);
  }

  private async salaryCategory() {
    const found = await this.prisma.acctCategory.findFirst({ where: { name: { equals: SALARY_CATEGORY, mode: 'insensitive' }, archived: false }, select: { id: true } });
    return (found ?? (await this.prisma.acctCategory.create({ data: { name: SALARY_CATEGORY }, select: { id: true } }))).id;
  }

  // ───────────────────────── Payslips ─────────────────────────

  async updatePayslip(u: AuthUser, id: string, dto: PayslipDto) {
    const p = await this.prisma.payslip.findUnique({ where: { id }, include: { run: true } });
    if (!p) throw new NotFoundException('Payslip not found');
    this.assertDraft(p.run);
    const adj = {
      lopDays: dto.lopDays ?? num(p.lopDays),
      extraEarnings: dto.extraEarnings ?? lineItems(p.extraEarnings),
      otherDeductions: dto.otherDeductions ?? lineItems(p.otherDeductions),
      tdsOverride: dto.tdsOverride === undefined ? (p.tdsOverride == null ? null : num(p.tdsOverride)) : dto.tdsOverride,
    };
    const c = computePayslip(p.run.month, p.snapshot as unknown as PayslipSnapshot, adj, await this.settings());
    const saved = await this.prisma.payslip.update({
      where: { id },
      data: {
        lopDays: c.lopDays, extraEarnings: json(c.extraEarnings), otherDeductions: json(c.deductions.filter((d) => d.key === 'other').map(({ name, amount }) => ({ name, amount }))),
        tdsOverride: adj.tdsOverride, remarks: dto.remarks === undefined ? p.remarks : blank(dto.remarks), ...money(c),
      },
    });
    await this.audit.record({ actorId: u.id, action: 'payroll.payslip_updated', entityType: 'payslip', entityId: id, after: { lopDays: c.lopDays, net: c.netPay } });
    return this.shapePayslip(saved);
  }

  /** Leaves someone out of this month's payroll (draft only). Refresh adds them back. */
  async removePayslip(u: AuthUser, id: string) {
    const p = await this.prisma.payslip.findUnique({ where: { id }, include: { run: true } });
    if (!p) throw new NotFoundException('Payslip not found');
    this.assertDraft(p.run);
    await this.prisma.payslip.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'payroll.payslip_removed', entityType: 'payslip', entityId: id, before: { runId: p.runId, employeeId: p.employeeId } });
    return { deleted: true };
  }

  /** A payslip with what it needs to print: the company's name and address. */
  async payslip(id: string) {
    const p = await this.prisma.payslip.findUnique({ where: { id }, include: { run: true } });
    if (!p) throw new NotFoundException('Payslip not found');
    return this.printable(p);
  }

  private async printable(p: Payslip & { run: PayrollRun }) {
    const [c, s] = await Promise.all([this.company.settings(), this.settings()]);
    return {
      ...this.shapePayslip(p), month: p.run.month, monthLabel: monthLabel(p.run.month), status: p.run.status, paidOn: iso(p.run.paidOn),
      company: { name: c.companyName, address: c.address, phone: c.phone, email: c.email, website: c.website },
      note: s.payslipNote,
      /** Which statutory deductions are switched on, so the payslip leaves out the IDs of those that are off. */
      statutory: s.statutory,
    };
  }

  /** Every payslip in a run, ready to print together. */
  async runPayslips(id: string) {
    const run = await this.loadRun(id);
    const slips = [...run.payslips].sort((a, b) => (a.snapshot as unknown as PayslipSnapshot).code.localeCompare((b.snapshot as unknown as PayslipSnapshot).code));
    return Promise.all(slips.map((p) => this.printable({ ...p, run })));
  }

  // ───────────────────────── Employee self-service ─────────────────────────

  /** The signed-in person's own payslips, once their payroll is finalised. */
  async myPayslips(u: AuthUser) {
    const rows = await this.prisma.payslip.findMany({
      where: { employee: { userId: u.id }, run: { status: { in: ['FINALISED', 'PAID'] } } },
      include: { run: true }, orderBy: { run: { month: 'desc' } },
    });
    return rows.map((p) => ({ id: p.id, month: p.run.month, monthLabel: monthLabel(p.run.month), status: p.run.status, paidOn: iso(p.run.paidOn), gross: num(p.gross), totalDeductions: num(p.totalDeductions), netPay: num(p.netPay) }));
  }

  async myPayslip(u: AuthUser, id: string) {
    const p = await this.prisma.payslip.findFirst({ where: { id, employee: { userId: u.id }, run: { status: { in: ['FINALISED', 'PAID'] } } }, include: { run: true } });
    if (!p) throw new NotFoundException('Payslip not found');
    const shaped = await this.printable(p);
    // Employees see their own payslip, but not what the company pays on top of it.
    return { ...shaped, employerCost: undefined, calc: { ...shaped.calc, employer: undefined, employerCost: undefined } };
  }

  // ───────────────────────── Exports ─────────────────────────

  /** Salary register: one row per employee with every earning and deduction. */
  async registerCsv(id: string) {
    const [run, s] = await Promise.all([this.run(id), this.settings()]);
    // PF and ESI columns only when the company deducts them (or this month has them).
    const pf = s.statutory.pf || run.totals.pfEmployer > 0, esi = s.statutory.esi || run.totals.esiEmployer > 0;
    const earningNames = [...new Set(run.payslips.flatMap((p) => [...p.calc.earnings.map((e) => e.name), ...p.calc.extraEarnings.map((e) => e.name)]))];
    const deductionNames = [...new Set(run.payslips.flatMap((p) => p.calc.deductions.map((d) => d.name)))];
    const employerHead = [...(pf ? ['Employer PF', 'EDLI + PF admin'] : []), ...(esi ? ['Employer ESI'] : []), ...(pf || esi ? ['Cost to company'] : [])];
    const head = ['Employee ID', 'Name', 'Designation', 'Department', 'PAN', ...(pf ? ['UAN'] : []), 'Days in month', 'LOP days', 'Paid days', ...earningNames, 'Gross', ...deductionNames, 'Total deductions', 'Net pay', ...employerHead];
    const rows = run.payslips.map((p) => {
      const c = p.calc, e = p.snapshot;
      const earned = (n: string) => (c.earnings.find((e) => e.name === n)?.earned ?? 0) + (c.extraEarnings.find((e) => e.name === n)?.amount ?? 0);
      const employer = [...(pf ? [c.employer.epf + c.employer.eps, c.employer.edli + c.employer.pfAdmin] : []), ...(esi ? [c.employer.esi] : []), ...(pf || esi ? [c.employerCost] : [])];
      return [e.code, e.fullName, e.designation ?? '', e.department ?? '', e.pan ?? '', ...(pf ? [e.uan ?? ''] : []), c.basisDays, c.lopDays, c.paidDays,
        ...earningNames.map(earned), c.gross, ...deductionNames.map((n) => c.deductions.filter((d) => d.name === n).reduce((a, d) => a + d.amount, 0)),
        c.totalDeductions, c.netPay, ...employer];
    });
    const t = run.totals;
    const employerTotals = [...(pf ? [t.pfEmployer, r2(t.edli + t.pfAdmin)] : []), ...(esi ? [t.esiEmployer] : []), ...(pf || esi ? [t.employerCost] : [])];
    rows.push(['', 'Total', '', '', '', ...(pf ? [''] : []), '', '', '', ...earningNames.map(() => ''), t.gross, ...deductionNames.map(() => ''), t.deductions, t.net, ...employerTotals]);
    return { name: `salary-register-${run.month}.csv`, body: csv([head, ...rows]) };
  }

  /** For the bank's bulk transfer upload: who to pay, where, and how much. */
  async bankCsv(id: string) {
    const run = await this.run(id);
    const head = ['Employee ID', 'Name', 'Bank', 'Account number', 'IFSC', 'Amount', 'Payment mode', 'Narration'];
    const rows = run.payslips.filter((p) => p.netPay > 0).map((p) => [
      p.snapshot.code, p.snapshot.fullName, p.snapshot.bankName ?? '', p.snapshot.accountNumber ?? '', p.snapshot.ifsc ?? '', p.netPay, PAY_MODES[p.snapshot.paymentMethod] ?? p.snapshot.paymentMethod, `Salary ${monthLabel(run.month)}`,
    ]);
    return { name: `salary-transfer-${run.month}.csv`, body: csv([head, ...rows]) };
  }
}
