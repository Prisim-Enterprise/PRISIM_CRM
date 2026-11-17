import { analyseClients, AnalysisInput, monthly, spendByCategory } from './analysis';
import { expenseClientId, expenseWhere, MANAGE } from './shared';

const input = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  clients: [
    { id: 'a', name: 'Asha Builders', status: 'ACTIVE' },
    { id: 'b', name: 'Bright Foods', status: 'ACTIVE' },
    { id: 'c', name: 'Idle Co', status: 'ACTIVE' },
  ],
  projects: [{ clientId: 'a', status: 'ACTIVE' }, { clientId: 'a', status: 'COMPLETED' }, { clientId: 'b', status: 'ACTIVE' }],
  income: [
    { clientId: 'a', clientName: 'Asha Builders', amount: 60000, date: '2026-10-05' },
    { clientId: 'a', clientName: 'Asha Builders', amount: 40000, date: '2026-11-02' },
    { clientId: 'b', clientName: 'Bright Foods', amount: 25000, date: '2026-11-10' },
    { clientId: 'b', clientName: 'Bright Foods', amount: 99999, date: '2026-08-01' }, // before the period
    { clientId: null, clientName: 'Walk-in', amount: 5000, date: '2026-11-11' },
  ],
  expenses: [
    { clientId: 'a', amount: 30000, date: '2026-10-20', category: 'Shoot' },
    { clientId: 'b', amount: 35000, date: '2026-11-12', category: 'Ads' },
    { clientId: null, amount: 10000, date: '2026-11-01', category: 'Rent' },
    { clientId: 'a', amount: 7777, date: '2026-12-01', category: 'Shoot' }, // after the period
  ],
  invoices: [
    { clientId: 'a', clientName: 'Asha Builders', date: '2026-10-01', total: 118000, balance: 18000, status: 'partial' },
    { clientId: 'b', clientName: 'Bright Foods', date: '2026-07-01', total: 50000, balance: 50000, status: 'overdue' },
  ],
  ...over,
});

describe('analyseClients', () => {
  const a = analyseClients(input(), '2026-10-01', '2026-11-30');
  const row = (id: string | null) => a.clients.find((c) => c.clientId === id)!;

  it('adds up each client for the period only', () => {
    expect(row('a')).toMatchObject({ received: 100000, spent: 30000, profit: 70000, invoiced: 118000, invoices: 1, projects: 2, activeProjects: 1, lastPayment: '2026-11-02' });
    expect(row('a').margin).toBeCloseTo(0.7);
    expect(row('b')).toMatchObject({ received: 25000, spent: 35000, profit: -10000, invoiced: 0 });
  });

  it('shows outstanding and overdue as of now, whatever the period', () => {
    expect(row('a')).toMatchObject({ outstanding: 18000, overdue: 0 });
    expect(row('b')).toMatchObject({ outstanding: 50000, overdue: 50000 });
  });

  it('keeps money on unlinked invoices in its own row', () => {
    expect(row(null)).toMatchObject({ name: 'Not linked to a client', received: 5000 });
  });

  it('leaves out clients with no activity at all', () => {
    expect(a.clients.find((c) => c.clientId === 'c')).toBeUndefined();
  });

  it('ranks clients by money received', () => {
    expect(a.clients.map((c) => c.clientId)).toEqual(['a', 'b', null]);
  });

  it('totals: overhead is counted once, outside the clients', () => {
    expect(a.totals).toMatchObject({
      received: 130000, clientSpent: 65000, overhead: 10000, spent: 75000, grossProfit: 65000, netProfit: 55000,
      outstanding: 68000, overdue: 50000, invoiced: 118000, payingClients: 2, clientsWithWork: 2,
    });
    expect(a.totals.grossMargin).toBeCloseTo(0.5);
    expect(a.totals.topClient).toMatchObject({ name: 'Asha Builders' });
    expect(a.totals.topClient!.share).toBeCloseTo(100000 / 130000);
  });

  it('a client that only lost money has a negative margin; nothing received means no margin', () => {
    expect(row('b').margin).toBeCloseTo(-0.4);
    const only = analyseClients(input({ income: [] }), '2026-10-01', '2026-11-30');
    expect(only.clients.find((c) => c.clientId === 'a')!.margin).toBeNull();
    expect(only.totals.grossMargin).toBeNull();
    expect(only.totals.topClient).toBeNull();
  });

  it('builds a month-by-month series including overhead', () => {
    expect(a.months).toEqual([
      { month: '2026-10', received: 60000, spent: 30000, profit: 30000 },
      { month: '2026-11', received: 70000, spent: 45000, profit: 25000 },
    ]);
  });
});

describe('monthly', () => {
  it('lists every month in the range, even empty ones, capped at 24', () => {
    expect(monthly([], [], '2026-11-15', '2027-02-01').map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    const long = monthly([], [], '2020-01-01', '2026-12-31');
    expect(long).toHaveLength(24);
    expect(long.at(-1)!.month).toBe('2026-12');
  });
});

describe('spendByCategory', () => {
  it('groups and sorts, biggest first', () => {
    expect(spendByCategory([
      { clientId: 'a', amount: 10, date: '2026-01-01', category: 'Ads' },
      { clientId: 'a', amount: 30, date: '2026-01-01', category: 'Shoot' },
      { clientId: 'a', amount: 5, date: '2026-01-01', category: 'Ads' },
    ])).toEqual([{ name: 'Shoot', amount: 30 }, { name: 'Ads', amount: 15 }]);
  });
});

describe('expenseClientId', () => {
  it("the project's client always wins", () => expect(expenseClientId('p-client', 'other', 'old')).toBe('p-client'));
  it('without a project, the picked client', () => expect(expenseClientId(null, 'picked', 'old')).toBe('picked'));
  it('picking "no client" clears it', () => expect(expenseClientId(null, null, 'old')).toBeNull());
  it('nothing sent keeps what it was', () => expect(expenseClientId(null, undefined, 'old')).toBe('old'));
});

describe('expense filter by client', () => {
  const manager = { id: 'm', permissions: new Set([MANAGE]) };
  it('filters by client or by "no client"', () => {
    expect(expenseWhere(manager, { clientId: '6f1c2d3e-0000-4000-8000-000000000001' }).AND).toEqual([{ clientId: '6f1c2d3e-0000-4000-8000-000000000001' }]);
    expect(expenseWhere(manager, { clientId: 'none' }).AND).toEqual([{ clientId: null }]);
  });
  it('rejects a client filter that is not a uuid', () => {
    expect(() => expenseWhere(manager, { clientId: 'x' })).toThrow('Invalid filter');
  });
});
