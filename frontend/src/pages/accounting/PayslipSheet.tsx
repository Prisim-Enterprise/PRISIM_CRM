import clsx from 'clsx';
import { format } from 'date-fns';
import { inrWords } from './Invoices';
import { METHODS, PaymentMethod } from './shared';

// The printed payslip, in the usual Indian format: company, month, employee and statutory IDs,
// attendance, earnings beside deductions, net pay in figures and words. Shared by the payroll
// screens and the employee's own "My payslips".

export interface PayslipSnapshot {
  code: string; fullName: string; email: string | null; designation: string | null; department: string | null; location: string | null;
  dateOfJoining: string; dateOfLeaving: string | null; pan: string | null; uan: string | null; pfNumber: string | null; esiNumber: string | null;
  bankName: string | null; accountNumber: string | null; ifsc: string | null; paymentMethod: PaymentMethod;
  components: { name: string; amount: number; pf?: boolean }[]; pfEnabled: boolean; pfCapped: boolean; esiEnabled: boolean; ptEnabled: boolean; monthlyTds: number;
}
export interface LineItem { name: string; amount: number }
export interface PayCalc {
  daysInMonth: number; basisDays: number; notEmployedDays: number; lopDays: number; paidDays: number;
  earnings: { name: string; full: number; earned: number; pf: boolean }[]; extraEarnings: LineItem[];
  fullGross: number; gross: number; pfWages: number; esiApplies: boolean;
  deductions: { key: 'pf' | 'esi' | 'pt' | 'tds' | 'other'; name: string; amount: number }[];
  totalDeductions: number; netPay: number;
  /** Left out of an employee's own copy. */
  employer?: { epf: number; eps: number; edli: number; pfAdmin: number; esi: number; total: number };
  employerCost?: number;
}
export interface PrintablePayslip {
  id: string; snapshot: PayslipSnapshot; calc: PayCalc; remarks: string | null; month: string; monthLabel: string;
  status: 'DRAFT' | 'FINALISED' | 'PAID'; paidOn: string | null;
  company: { name: string; address: string; phone: string; email: string; website: string }; note: string;
  /** Company-wide switches: PF and ESI numbers only show when those deductions are on (or on this payslip). */
  statutory?: { pf: boolean; esi: boolean; pt: boolean; tds: boolean };
}

/** 40,000.00 */
export const amt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (s: string | null) => (s ? format(new Date(`${s}T12:00:00`), 'dd MMM yyyy') : '—');
const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const B = 'border-slate-400';

function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2 py-[3px]">
      <span className="w-32 shrink-0 text-slate-600">{label}</span>
      <span className="font-medium">: {value || '—'}</span>
    </div>
  );
}

/** One payslip on one A4 page. `employerDetails` adds the company's PF/ESI contributions (management copy). */
export function PayslipSheet({ p, employerDetails = false, className }: { p: PrintablePayslip; employerDetails?: boolean; className?: string }) {
  const s = p.snapshot, c = p.calc;
  const earnings = [...c.earnings.map((e) => ({ name: e.name, full: e.full as number | null, amount: e.earned })), ...c.extraEarnings.map((e) => ({ name: e.name, full: null, amount: e.amount }))];
  const rows = earnings.length >= c.deductions.length ? earnings.length : c.deductions.length;
  const showFull = c.paidDays !== c.basisDays;
  // Deductions that are switched off are left out entirely: no column, no ID, no employer share.
  const hasDeductions = c.deductions.length > 0;
  const showPf = !!p.statutory?.pf || c.deductions.some((d) => d.key === 'pf') || !!c.employer?.eps;
  const showEsi = !!p.statutory?.esi || c.deductions.some((d) => d.key === 'esi') || !!c.employer?.esi;
  return (
    <div className={clsx('payslip-page mx-auto w-full max-w-[794px] bg-white px-8 py-7 text-[12px] leading-snug text-black shadow-card print:max-w-none print:px-0 print:py-0 print:shadow-none', className)}
      style={{ fontFamily: 'Arial, Helvetica, sans-serif' }}>
      {p.status === 'DRAFT' && <p className="mb-2 rounded bg-amber-100 px-2 py-1 text-center text-[11px] font-semibold text-amber-800 print:border print:border-amber-500">DRAFT: not final until the payroll is finalised</p>}
      <div className={clsx('flex items-start justify-between gap-6 border-b-2 pb-3', 'border-slate-800')}>
        <div>
          <p className="text-[18px] font-bold">{p.company.name}</p>
          <p className="whitespace-pre-line text-[11px] text-slate-700">{p.company.address}</p>
          <p className="text-[11px] text-slate-700">{[p.company.phone, p.company.email, p.company.website].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-slate-600">Payslip for the month of</p>
          <p className="text-[16px] font-bold">{p.monthLabel}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-8 text-[11.5px]">
        <div>
          <Detail label="Employee Name" value={s.fullName} />
          <Detail label="Designation" value={s.designation} />
          <Detail label="Department" value={s.department} />
          <Detail label="Date of Joining" value={dmy(s.dateOfJoining)} />
          <Detail label="Location" value={s.location} />
          <Detail label="Pay Mode" value={METHODS[s.paymentMethod] ?? s.paymentMethod} />
        </div>
        <div>
          <Detail label="Employee ID" value={s.code} />
          <Detail label="PAN" value={s.pan} />
          {showPf && <Detail label="UAN" value={s.uan} />}
          {showPf && <Detail label="PF No." value={s.pfNumber} />}
          {showEsi && <Detail label="ESI No." value={s.esiNumber} />}
          <Detail label="Bank / A/c No." value={[s.bankName, s.accountNumber].filter(Boolean).join(' · ')} />
        </div>
      </div>

      <table className={clsx('mt-3 w-full border-collapse border text-center text-[11.5px]', B)}>
        <tbody>
          <tr className="bg-slate-50">
            {['Days in month', 'Paid days', 'LOP days', ...(c.notEmployedDays ? ['Not yet joined / left'] : [])].map((h) => <td key={h} className={clsx('border px-2 py-1 text-slate-600', B)}>{h}</td>)}
          </tr>
          <tr className="font-semibold">
            <td className={clsx('border px-2 py-1', B)}>{c.basisDays}</td>
            <td className={clsx('border px-2 py-1', B)}>{fmtDays(c.paidDays)}</td>
            <td className={clsx('border px-2 py-1', B)}>{fmtDays(c.lopDays)}</td>
            {!!c.notEmployedDays && <td className={clsx('border px-2 py-1', B)}>{c.notEmployedDays}</td>}
          </tr>
        </tbody>
      </table>

      <table className={clsx('mt-3 w-full table-fixed border-collapse border text-[11.5px]', B)}>
        <colgroup>
          {hasDeductions ? <>
            <col className={showFull ? 'w-[28%]' : 'w-[34%]'} />{showFull && <col className="w-[12%]" />}<col className={showFull ? 'w-[12%]' : 'w-[16%]'} />
            <col className="w-[32%]" /><col className="w-[16%]" />
          </> : <>
            <col className={showFull ? 'w-[52%]' : 'w-[70%]'} />{showFull && <col className="w-[24%]" />}<col className={showFull ? 'w-[24%]' : 'w-[30%]'} />
          </>}
        </colgroup>
        <thead>
          <tr className="bg-slate-100 text-left">
            <th className={clsx('border px-2 py-1.5', B)}>Earnings</th>
            {showFull && <th className={clsx('border px-2 py-1.5 text-right', B)}>Actual (₹)</th>}
            <th className={clsx('border px-2 py-1.5 text-right', B)}>Earned (₹)</th>
            {hasDeductions && <th className={clsx('border px-2 py-1.5', B)}>Deductions</th>}
            {hasDeductions && <th className={clsx('border px-2 py-1.5 text-right', B)}>Amount (₹)</th>}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.max(rows, 1) }, (_, i) => {
            const e = earnings[i], d = c.deductions[i];
            return (
              <tr key={i} className="align-top">
                <td className={clsx('border-x px-2 py-1', B)}>{e?.name}</td>
                {showFull && <td className={clsx('border-x px-2 py-1 text-right tabular-nums text-slate-600', B)}>{e?.full != null ? amt(e.full) : ''}</td>}
                <td className={clsx('border-x px-2 py-1 text-right tabular-nums', B)}>{e ? amt(e.amount) : ''}</td>
                {hasDeductions && <td className={clsx('border-x px-2 py-1', B)}>{d?.name}</td>}
                {hasDeductions && <td className={clsx('border-x px-2 py-1 text-right tabular-nums', B)}>{d ? amt(d.amount) : ''}</td>}
              </tr>
            );
          })}
          <tr className="bg-slate-50 font-bold">
            <td className={clsx('border px-2 py-1.5', B)}>Gross Earnings</td>
            {showFull && <td className={clsx('border px-2 py-1.5 text-right tabular-nums', B)}>{amt(c.fullGross)}</td>}
            <td className={clsx('border px-2 py-1.5 text-right tabular-nums', B)}>{amt(c.gross)}</td>
            {hasDeductions && <td className={clsx('border px-2 py-1.5', B)}>Total Deductions</td>}
            {hasDeductions && <td className={clsx('border px-2 py-1.5 text-right tabular-nums', B)}>{amt(c.totalDeductions)}</td>}
          </tr>
        </tbody>
      </table>

      <div className={clsx('mt-3 flex items-center justify-between rounded border-2 px-3 py-2', 'border-slate-800')}>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-600">{hasDeductions ? 'Net Pay (Gross Earnings − Total Deductions)' : 'Net Pay'}</p>
          <p className="text-[11.5px]">{inrWords(c.netPay)}</p>
        </div>
        <p className="whitespace-nowrap text-[18px] font-bold tabular-nums">₹ {amt(c.netPay)}</p>
      </div>

      {employerDetails && !!c.employer?.total && (
        <div className="mt-3 text-[11px]">
          <p className="font-semibold">Employer contributions (paid by the company, not deducted from salary)</p>
          <p className="text-slate-700">
            EPF ₹{amt(c.employer.epf)} · Pension (EPS) ₹{amt(c.employer.eps)} · EDLI ₹{amt(c.employer.edli)} · PF admin ₹{amt(c.employer.pfAdmin)} · ESI ₹{amt(c.employer.esi)}
            {' '}· <b>Cost to company this month ₹{amt(c.employerCost ?? c.gross + c.employer.total)}</b>
          </p>
        </div>
      )}
      {p.remarks && <p className="mt-3 text-[11px]"><span className="font-semibold">Remarks: </span>{p.remarks}</p>}
      {p.paidOn && <p className="mt-1 text-[11px] text-slate-700">Paid on {dmy(p.paidOn)}</p>}
      <p className="mt-6 border-t border-slate-300 pt-2 text-center text-[10.5px] text-slate-600">{p.note}</p>
    </div>
  );
}

/** Payslips to print: one per page. This element alone prints. */
export function PayslipPrint({ slips, employerDetails = false }: { slips: PrintablePayslip[]; employerDetails?: boolean }) {
  return (
    <div id="payslip-sheet" className="space-y-6 print:space-y-0">
      {slips.map((p, i) => <PayslipSheet key={p.id} p={p} employerDetails={employerDetails} className={i > 0 ? 'print:break-before-page' : undefined} />)}
    </div>
  );
}

/** Prints the payslips on the page, naming the saved PDF after `title`. */
export function printPayslips(title: string) {
  const before = document.title;
  document.title = title;
  const restore = () => { document.title = before; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 100);
}
