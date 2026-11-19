// Payroll arithmetic. Everything here is pure so the rules can be unit-tested without a database.
//
// The defaults follow the usual Indian statutory rules (Karnataka, where Prisim is registered):
//   PF   12% employee and 12% employer on PF wages (Basic + DA), on wages up to ₹15,000 unless
//        the employee is set to contribute on full wages. Of the employer's 12%, 8.33% goes to the
//        pension scheme (EPS), always on wages up to ₹15,000 (so at most ₹1,250); the rest is EPF.
//        EDLI 0.5% and PF admin charges 0.5% are employer costs. PF amounts are rounded to the rupee.
//   ESI  0.75% employee and 3.25% employer of the month's gross, for employees whose monthly gross
//        salary is ₹21,000 or less. ESI amounts are rounded up to the next rupee.
//   PT   Karnataka: ₹200 a month when the month's gross is ₹25,000 or more, ₹300 in February.
//   TDS  The employee's monthly amount (worked out from their tax declaration), or this month's override.
// Every rate and limit can be changed in Payroll settings, and each of PF, ESI, Professional Tax and
// TDS can be switched off for the whole company (all four are off by default: salary paid in full).
// When one is off it is neither deducted nor charged to the employer, and the screens leave it out.

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupee = (n: number) => Math.round(n + Number.EPSILON);
const rupeeUp = (n: number) => Math.ceil(r2(n));

export interface PtSlab { from: number; amount: number; february?: number | null }

export interface Statutory { pf: boolean; esi: boolean; pt: boolean; tds: boolean }

export interface PayrollSettings {
  /** Company-wide switches. Off: not deducted, not charged to the employer, not shown. */
  statutory: Statutory;
  pf: { employeeRate: number; employerRate: number; epsRate: number; wageCeiling: number; edliRate: number; adminRate: number };
  esi: { employeeRate: number; employerRate: number; wageLimit: number };
  pt: { state: string; slabs: PtSlab[] };
  /** "calendar": pay is divided by the days in the month. "fixed30": always by 30 days. */
  lopBasis: 'calendar' | 'fixed30';
  /** Printed at the foot of every payslip. */
  payslipNote: string;
  /** Salary structure filled in for a new employee. */
  defaultComponents: SalaryComponent[];
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  statutory: { pf: false, esi: false, pt: false, tds: false },
  pf: { employeeRate: 12, employerRate: 12, epsRate: 8.33, wageCeiling: 15000, edliRate: 0.5, adminRate: 0.5 },
  esi: { employeeRate: 0.75, employerRate: 3.25, wageLimit: 21000 },
  pt: { state: 'Karnataka', slabs: [{ from: 25000, amount: 200, february: 300 }] },
  lopBasis: 'calendar',
  payslipNote: 'This is a computer-generated payslip and does not require a signature.',
  defaultComponents: [
    { name: 'Basic', amount: 0, pf: true },
    { name: 'House Rent Allowance', amount: 0, pf: false },
    { name: 'Conveyance Allowance', amount: 0, pf: false },
    { name: 'Special Allowance', amount: 0, pf: false },
  ],
};

/** Merges saved settings over the defaults, so settings saved before a new option existed still work. */
export function withDefaults(saved: Partial<PayrollSettings> | null | undefined): PayrollSettings {
  const s = saved ?? {};
  return {
    ...DEFAULT_PAYROLL_SETTINGS, ...s,
    statutory: { ...DEFAULT_PAYROLL_SETTINGS.statutory, ...(s.statutory ?? {}) },
    pf: { ...DEFAULT_PAYROLL_SETTINGS.pf, ...(s.pf ?? {}) },
    esi: { ...DEFAULT_PAYROLL_SETTINGS.esi, ...(s.esi ?? {}) },
    pt: { ...DEFAULT_PAYROLL_SETTINGS.pt, ...(s.pt ?? {}) },
    defaultComponents: s.defaultComponents?.length ? s.defaultComponents : DEFAULT_PAYROLL_SETTINGS.defaultComponents,
  };
}

export interface SalaryComponent { name: string; amount: number; pf?: boolean }
export interface LineItem { name: string; amount: number }

/** What the pay for one month is worked out from. */
export interface PayInput {
  /** "2026-11" */
  month: string;
  components: SalaryComponent[];
  dateOfJoining: string;
  dateOfLeaving?: string | null;
  lopDays: number;
  extraEarnings: LineItem[];
  otherDeductions: LineItem[];
  tds: number;
  pfEnabled: boolean;
  pfCapped: boolean;
  esiEnabled: boolean;
  ptEnabled: boolean;
}

export interface PayResult {
  daysInMonth: number;
  /** Days the pay is divided by: the days in the month, or 30. */
  basisDays: number;
  /** Days before joining or after leaving, within the month. */
  notEmployedDays: number;
  lopDays: number;
  paidDays: number;
  earnings: { name: string; full: number; earned: number; pf: boolean }[];
  extraEarnings: LineItem[];
  /** Full monthly salary, before loss of pay. */
  fullGross: number;
  gross: number;
  pfWages: number;
  esiApplies: boolean;
  deductions: { key: 'pf' | 'esi' | 'pt' | 'tds' | 'other'; name: string; amount: number }[];
  totalDeductions: number;
  netPay: number;
  employer: { epf: number; eps: number; edli: number; pfAdmin: number; esi: number; total: number };
  /** Gross plus the employer's contributions: what the month costs the company. */
  employerCost: number;
}

export const daysInMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Days of the month before the joining date or after the leaving date. */
export function notEmployedDays(month: string, dateOfJoining: string, dateOfLeaving?: string | null) {
  const days = daysInMonth(month);
  const first = `${month}-01`, last = `${month}-${String(days).padStart(2, '0')}`;
  if (dateOfJoining > last || (dateOfLeaving && dateOfLeaving < first)) return days;
  let off = 0;
  if (dateOfJoining > first) off += Number(dateOfJoining.slice(8, 10)) - 1;
  if (dateOfLeaving && dateOfLeaving < last) off += days - Number(dateOfLeaving.slice(8, 10));
  return Math.min(days, off);
}

/** Professional Tax for a month's gross: the highest slab reached, with its February amount in February. */
export function professionalTax(gross: number, month: string, slabs: PtSlab[]) {
  const slab = [...slabs].sort((a, b) => b.from - a.from).find((s) => gross >= s.from);
  if (!slab) return 0;
  return month.endsWith('-02') && slab.february != null ? slab.february : slab.amount;
}

const clean = (items: LineItem[]) => items.map((i) => ({ name: i.name.trim(), amount: r2(Number(i.amount) || 0) })).filter((i) => i.name && i.amount > 0);

export function calculatePay(input: PayInput, s: PayrollSettings): PayResult {
  const dim = daysInMonth(input.month);
  const basisDays = s.lopBasis === 'fixed30' ? 30 : dim;
  const off = notEmployedDays(input.month, input.dateOfJoining, input.dateOfLeaving);
  // With a 30-day basis, a fully worked 31-day month is still 30 paid days.
  const offOnBasis = off >= dim ? basisDays : Math.min(basisDays, off);
  const lopDays = Math.max(0, Math.min(Number(input.lopDays) || 0, basisDays - offOnBasis));
  const paidDays = r2(Math.max(0, basisDays - offOnBasis - lopDays));
  const ratio = basisDays ? paidDays / basisDays : 0;

  const earnings = input.components
    .filter((c) => c.name.trim())
    .map((c) => {
      const full = r2(Number(c.amount) || 0);
      return { name: c.name.trim(), full, earned: rupee(full * ratio), pf: !!c.pf };
    });
  const extraEarnings = clean(input.extraEarnings);
  const fullGross = r2(earnings.reduce((a, e) => a + e.full, 0));
  const gross = r2(earnings.reduce((a, e) => a + e.earned, 0) + extraEarnings.reduce((a, e) => a + e.amount, 0));
  const pfWages = r2(earnings.filter((e) => e.pf).reduce((a, e) => a + e.earned, 0));

  // PF
  const ceilingWages = Math.min(pfWages, s.pf.wageCeiling);
  const pfBase = input.pfCapped ? ceilingWages : pfWages;
  const pfOn = s.statutory.pf && input.pfEnabled && pfWages > 0;
  const pfEmployee = pfOn ? rupee((pfBase * s.pf.employeeRate) / 100) : 0;
  const pfEmployerTotal = pfOn ? rupee((pfBase * s.pf.employerRate) / 100) : 0;
  const eps = pfOn ? Math.min(pfEmployerTotal, rupee((ceilingWages * s.pf.epsRate) / 100)) : 0;
  const epf = pfEmployerTotal - eps;
  const edli = pfOn ? rupee((ceilingWages * s.pf.edliRate) / 100) : 0;
  const pfAdmin = pfOn ? rupee((pfBase * s.pf.adminRate) / 100) : 0;

  // ESI: decided on the full monthly salary, worked out on what was earned this month.
  const esiApplies = s.statutory.esi && input.esiEnabled && fullGross > 0 && fullGross <= s.esi.wageLimit;
  const esiEmployee = esiApplies && gross > 0 ? rupeeUp((gross * s.esi.employeeRate) / 100) : 0;
  const esiEmployer = esiApplies && gross > 0 ? rupeeUp((gross * s.esi.employerRate) / 100) : 0;

  const pt = s.statutory.pt && input.ptEnabled ? professionalTax(gross, input.month, s.pt.slabs) : 0;
  const tds = s.statutory.tds ? r2(Math.max(0, Number(input.tds) || 0)) : 0;

  const deductions: PayResult['deductions'] = [];
  if (pfEmployee) deductions.push({ key: 'pf', name: 'Provident Fund (EPF)', amount: pfEmployee });
  if (esiEmployee) deductions.push({ key: 'esi', name: 'ESI', amount: esiEmployee });
  if (pt) deductions.push({ key: 'pt', name: 'Professional Tax', amount: pt });
  if (tds) deductions.push({ key: 'tds', name: 'Income Tax (TDS)', amount: tds });
  for (const d of clean(input.otherDeductions)) deductions.push({ key: 'other', name: d.name, amount: d.amount });
  const totalDeductions = r2(deductions.reduce((a, d) => a + d.amount, 0));

  const employerTotal = r2(epf + eps + edli + pfAdmin + esiEmployer);
  return {
    daysInMonth: dim, basisDays, notEmployedDays: off, lopDays, paidDays,
    earnings, extraEarnings, fullGross, gross, pfWages, esiApplies,
    deductions, totalDeductions, netPay: r2(gross - totalDeductions),
    employer: { epf, eps, edli, pfAdmin, esi: esiEmployer, total: employerTotal },
    employerCost: r2(gross + employerTotal),
  };
}

/** True when the employee is on the payroll for at least one day of the month. */
export const employedInMonth = (month: string, dateOfJoining: string, dateOfLeaving?: string | null) =>
  notEmployedDays(month, dateOfJoining, dateOfLeaving) < daysInMonth(month);

/** "2026-11" → "November 2026" */
export const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};
