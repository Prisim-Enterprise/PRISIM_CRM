import { r2 } from './shared';

// Client-wise money analysis. Pure: the service loads the rows, this adds them up.
//
// For the chosen period:   received (payments in), invoiced (invoices dated in it), spent (approved/paid expenses).
// As of today:            outstanding and overdue invoice balances (they aren't about a period).
// Profit = received − spent on that client. Company costs not tied to a client are "overhead",
// reported once for the whole business and not spread across clients.

export const UNLINKED = '__unlinked';

export interface AnalysisInput {
  clients: { id: string; name: string; status: string }[];
  projects: { clientId: string; status: string }[];
  income: { clientId: string | null; clientName: string; amount: number; date: string }[];
  expenses: { clientId: string | null; amount: number; date: string; category: string }[];
  invoices: { clientId: string | null; clientName: string; date: string; total: number; balance: number; status: string }[];
}

export interface ClientRow {
  /** null for money on invoices that aren't linked to a CRM client. */
  clientId: string | null; name: string; status: string | null;
  projects: number; activeProjects: number;
  received: number; invoiced: number; spent: number; profit: number;
  /** Profit as a share of received, or null when nothing was received. */
  margin: number | null;
  outstanding: number; overdue: number; invoices: number;
  lastPayment: string | null;
}

export interface MonthRow { month: string; received: number; spent: number; profit: number }

const monthsBetween = (from: string, to: string, max = 24) => {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out.slice(-max);
};

export function monthly(income: AnalysisInput['income'], expenses: AnalysisInput['expenses'], from: string, to: string): MonthRow[] {
  const rows = new Map(monthsBetween(from, to).map((m) => [m, { month: m, received: 0, spent: 0, profit: 0 }]));
  for (const i of income) { const r = rows.get(i.date.slice(0, 7)); if (r) r.received += i.amount; }
  for (const e of expenses) { const r = rows.get(e.date.slice(0, 7)); if (r) r.spent += e.amount; }
  return [...rows.values()].map((r) => ({ month: r.month, received: r2(r.received), spent: r2(r.spent), profit: r2(r.received - r.spent) }));
}

export function analyseClients(input: AnalysisInput, from: string, to: string) {
  const inRange = (d: string) => d >= from.slice(0, 10) && d <= to.slice(0, 10);
  const rows = new Map<string, ClientRow>();
  const blank = (clientId: string | null, name: string, status: string | null): ClientRow => ({
    clientId, name, status, projects: 0, activeProjects: 0, received: 0, invoiced: 0, spent: 0, profit: 0, margin: null,
    outstanding: 0, overdue: 0, invoices: 0, lastPayment: null,
  });
  for (const c of input.clients) rows.set(c.id, blank(c.id, c.name, c.status));
  const row = (clientId: string | null) => {
    const key = clientId ?? UNLINKED;
    if (!rows.has(key)) rows.set(key, blank(clientId, clientId ? 'Unknown client' : 'Not linked to a client', null));
    return rows.get(key)!;
  };

  for (const p of input.projects) { const r = row(p.clientId); r.projects += 1; if (p.status === 'ACTIVE') r.activeProjects += 1; }

  const income = input.income.filter((i) => inRange(i.date));
  for (const i of income) {
    const r = row(i.clientId);
    r.received += i.amount;
    if (!r.lastPayment || i.date > r.lastPayment) r.lastPayment = i.date;
  }

  const expenses = input.expenses.filter((e) => inRange(e.date));
  const clientSpend = expenses.filter((e) => e.clientId);
  const overheadRows = expenses.filter((e) => !e.clientId);
  for (const e of clientSpend) row(e.clientId).spent += e.amount;

  for (const inv of input.invoices) {
    const r = row(inv.clientId);
    r.outstanding += inv.balance;
    if (inv.status === 'overdue') r.overdue += inv.balance;
    if (inRange(inv.date)) { r.invoiced += inv.total; r.invoices += 1; }
  }

  const clients = [...rows.values()].map((r) => {
    const received = r2(r.received), spent = r2(r.spent), profit = r2(received - spent);
    return { ...r, received, spent, profit, invoiced: r2(r.invoiced), outstanding: r2(r.outstanding), overdue: r2(r.overdue), margin: received > 0 ? profit / received : null };
  });
  // Drop clients with nothing at all: no projects, money or invoices. They add noise, not insight.
  const active = clients.filter((c) => c.projects || c.received || c.spent || c.invoiced || c.outstanding);
  active.sort((a, b) => b.received - a.received || b.invoiced - a.invoiced || a.name.localeCompare(b.name));

  const sum = (k: 'received' | 'invoiced' | 'spent' | 'outstanding' | 'overdue') => r2(active.reduce((a, c) => a + c[k], 0));
  const received = sum('received');
  const clientSpent = sum('spent');
  const overhead = r2(overheadRows.reduce((a, e) => a + e.amount, 0));
  const top = active[0];
  return {
    clients: active,
    totals: {
      received, invoiced: sum('invoiced'), outstanding: sum('outstanding'), overdue: sum('overdue'),
      clientSpent, overhead, spent: r2(clientSpent + overhead),
      /** Received minus what was spent on clients. */
      grossProfit: r2(received - clientSpent),
      /** After overhead too: what the business actually kept. */
      netProfit: r2(received - clientSpent - overhead),
      grossMargin: received > 0 ? (received - clientSpent) / received : null,
      payingClients: active.filter((c) => c.clientId && c.received > 0).length,
      clientsWithWork: active.filter((c) => c.clientId).length,
      topClient: top && received > 0 ? { name: top.name, share: top.received / received } : null,
    },
    months: monthly(income, expenses, from, to),
  };
}

/** Spend grouped by category for one client, biggest first. */
export function spendByCategory(expenses: AnalysisInput['expenses']) {
  const m = new Map<string, number>();
  for (const e of expenses) m.set(e.category, (m.get(e.category) ?? 0) + e.amount);
  return [...m.entries()].map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount);
}
