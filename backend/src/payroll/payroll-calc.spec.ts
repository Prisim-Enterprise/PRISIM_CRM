import { calculatePay, DEFAULT_PAYROLL_SETTINGS, employedInMonth, notEmployedDays, PayInput, professionalTax, withDefaults } from './payroll-calc';

// Statutory deductions on, as for a company that deducts them.
const S = { ...DEFAULT_PAYROLL_SETTINGS, statutory: { pf: true, esi: true, pt: true, tds: true } };

const base = (over: Partial<PayInput> = {}): PayInput => ({
  month: '2026-11',
  components: [
    { name: 'Basic', amount: 20000, pf: true },
    { name: 'House Rent Allowance', amount: 8000 },
    { name: 'Special Allowance', amount: 12000 },
  ],
  dateOfJoining: '2025-01-01', dateOfLeaving: null, lopDays: 0, extraEarnings: [], otherDeductions: [], tds: 0,
  pfEnabled: true, pfCapped: true, esiEnabled: true, ptEnabled: true,
  ...over,
});

describe('calculatePay', () => {
  it('a full month: PF on the ₹15,000 ceiling, no ESI above ₹21,000, Karnataka PT', () => {
    const p = calculatePay(base(), S);
    expect(p.gross).toBe(40000);
    expect(p.paidDays).toBe(30);
    expect(p.esiApplies).toBe(false);
    expect(p.deductions).toEqual([
      { key: 'pf', name: 'Provident Fund (EPF)', amount: 1800 },
      { key: 'pt', name: 'Professional Tax', amount: 200 },
    ]);
    expect(p.netPay).toBe(38000);
    // Employer: 12% of 15,000 = 1,800, of which 8.33% (1,250) is pension; EDLI and admin 0.5% each.
    expect(p.employer).toEqual({ epf: 550, eps: 1250, edli: 75, pfAdmin: 75, esi: 0, total: 1950 });
    expect(p.employerCost).toBe(41950);
  });

  it('PF on full wages when not capped; pension stays on the ceiling', () => {
    const p = calculatePay(base({ pfCapped: false }), S);
    expect(p.deductions[0].amount).toBe(2400);
    expect(p.employer.eps).toBe(1250);
    expect(p.employer.epf).toBe(1150);
  });

  it('loss of pay reduces every part of the salary by the unpaid days', () => {
    const p = calculatePay(base({ lopDays: 3 }), S); // November: 30 days
    expect(p.paidDays).toBe(27);
    expect(p.earnings.map((e) => e.earned)).toEqual([18000, 7200, 10800]);
    expect(p.gross).toBe(36000);
    expect(p.pfWages).toBe(18000);
  });

  it('ESI for a monthly salary of ₹21,000 or less, rounded up to the rupee', () => {
    const p = calculatePay(base({ components: [{ name: 'Basic', amount: 10000, pf: true }, { name: 'Special Allowance', amount: 8333 }] }), S);
    expect(p.esiApplies).toBe(true);
    // 0.75% of 18,333 = 137.50 → 138; 3.25% = 595.82 → 596
    expect(p.deductions.find((d) => d.key === 'esi')?.amount).toBe(138);
    expect(p.employer.esi).toBe(596);
    // Below ₹25,000: no Professional Tax
    expect(p.deductions.find((d) => d.key === 'pt')).toBeUndefined();
  });

  it('Professional Tax is ₹300 in February', () => {
    expect(calculatePay(base({ month: '2027-02' }), S).deductions.find((d) => d.key === 'pt')?.amount).toBe(300);
  });

  it('someone joining mid-month is paid from the joining date', () => {
    const p = calculatePay(base({ dateOfJoining: '2026-11-16' }), S);
    expect(p.notEmployedDays).toBe(15);
    expect(p.paidDays).toBe(15);
    expect(p.gross).toBe(20000);
  });

  it('someone leaving mid-month is paid up to the last working day', () => {
    const p = calculatePay(base({ dateOfLeaving: '2026-11-10' }), S);
    expect(p.paidDays).toBe(10);
  });

  it('one-off earnings and deductions, and TDS', () => {
    const p = calculatePay(base({
      extraEarnings: [{ name: 'Performance bonus', amount: 5000 }, { name: '', amount: 100 }],
      otherDeductions: [{ name: 'Salary advance', amount: 2000 }],
      tds: 1500,
    }), S);
    expect(p.extraEarnings).toEqual([{ name: 'Performance bonus', amount: 5000 }]);
    expect(p.gross).toBe(45000);
    expect(p.pfWages).toBe(20000); // bonuses are not PF wages
    expect(p.totalDeductions).toBe(1800 + 200 + 1500 + 2000);
    expect(p.netPay).toBe(45000 - 5500);
  });

  it('statutory deductions can be switched off per employee', () => {
    const p = calculatePay(base({ pfEnabled: false, ptEnabled: false }), S);
    expect(p.deductions).toEqual([]);
    expect(p.employer.total).toBe(0);
    expect(p.netPay).toBe(40000);
  });

  it('loss of pay cannot go beyond the month', () => {
    const p = calculatePay(base({ lopDays: 45 }), S);
    expect(p.paidDays).toBe(0);
    expect(p.gross).toBe(0);
    expect(p.netPay).toBe(0);
  });

  it('by default nothing is deducted: PF, ESI, Professional Tax and TDS are all off', () => {
    const p = calculatePay(base({ tds: 1500, components: [{ name: 'Basic', amount: 10000, pf: true }, { name: 'Special Allowance', amount: 5000 }] }), DEFAULT_PAYROLL_SETTINGS);
    expect(p.deductions).toEqual([]);
    expect(p.esiApplies).toBe(false);
    expect(p.employer.total).toBe(0);
    expect(p.netPay).toBe(15000);
    expect(p.employerCost).toBe(15000);
  });

  it('each statutory deduction can be switched on alone; other deductions always apply', () => {
    const only = (k: 'pf' | 'esi' | 'pt' | 'tds') => ({ ...DEFAULT_PAYROLL_SETTINGS, statutory: { pf: false, esi: false, pt: false, tds: false, [k]: true } });
    const keys = (k: 'pf' | 'esi' | 'pt' | 'tds') => calculatePay(base({ tds: 1000, otherDeductions: [{ name: 'Salary advance', amount: 500 }] }), only(k)).deductions.map((d) => d.key);
    expect(keys('pf')).toEqual(['pf', 'other']);
    expect(keys('pt')).toEqual(['pt', 'other']);
    expect(keys('tds')).toEqual(['tds', 'other']);
    expect(keys('esi')).toEqual(['other']); // ₹40,000 is above the ESI limit
  });

  it('a 30-day basis pays a full 31-day month as 30 days', () => {
    const s = { ...S, lopBasis: 'fixed30' as const };
    const p = calculatePay(base({ month: '2026-12', lopDays: 1 }), s);
    expect(p.basisDays).toBe(30);
    expect(p.paidDays).toBe(29);
  });
});

describe('payroll helpers', () => {
  it('days not employed', () => {
    expect(notEmployedDays('2026-11', '2026-12-01')).toBe(30);
    expect(notEmployedDays('2026-11', '2025-01-01', '2026-10-31')).toBe(30);
    expect(notEmployedDays('2026-11', '2026-11-01', '2026-11-30')).toBe(0);
    expect(employedInMonth('2026-11', '2026-11-30')).toBe(true);
    expect(employedInMonth('2026-11', '2025-01-01', '2026-10-31')).toBe(false);
  });

  it('Professional Tax picks the highest slab reached', () => {
    const slabs = [{ from: 15000, amount: 150 }, { from: 20000, amount: 200, february: 300 }];
    expect(professionalTax(14999, '2026-11', slabs)).toBe(0);
    expect(professionalTax(15000, '2026-11', slabs)).toBe(150);
    expect(professionalTax(25000, '2027-02', slabs)).toBe(300);
  });

  it('saved settings keep any new defaults', () => {
    const s = withDefaults({ pf: { employeeRate: 10 } } as never);
    expect(s.pf.employeeRate).toBe(10);
    expect(s.pf.wageCeiling).toBe(15000);
    expect(s.esi.wageLimit).toBe(21000);
    expect(s.statutory).toEqual({ pf: false, esi: false, pt: false, tds: false });
  });
});
