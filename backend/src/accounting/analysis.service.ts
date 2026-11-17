import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalysisQuery, ProjectQuery } from './dto';
import { AccountingSettingsService } from './settings.service';
import { InvoicesService } from './invoices.service';
import { ProjectsService } from './projects.service';
import { analyseClients, AnalysisInput, spendByCategory } from './analysis';
import { day, expenseInclude, invoiceInclude, iso, num, shapeExpense, shapeInvoice } from './shared';

/** Client-wise and whole-business analysis for the accounting dashboard. */
@Injectable()
export class AnalysisService {
  constructor(private prisma: PrismaService, private cfg: AccountingSettingsService, private projects: ProjectsService, private invoices: InvoicesService) {}

  private range(q: AnalysisQuery) {
    const from = day(q.from), to = day(q.to);
    if (to < from) throw new BadRequestException('The end date is before the start date');
    if (to.getTime() - from.getTime() > 11 * 366 * 86400000) throw new BadRequestException('Pick a range of ten years or less');
    return { from, to };
  }

  /** Everything the analysis needs, for every client or just one. */
  private async load(q: AnalysisQuery, clientId?: string): Promise<AnalysisInput> {
    const { from, to } = this.range(q);
    const one = <T extends object>(where: T) => (clientId ? where : {});
    const [clients, projects, projectPayments, invoicePayments, invoices, expenses, s] = await Promise.all([
      this.prisma.client.findMany({ where: one({ id: clientId }), select: { id: true, name: true, status: true } }),
      this.prisma.acctProject.findMany({ where: one({ clientId }), select: { clientId: true, status: true } }),
      this.prisma.acctProjectPayment.findMany({
        where: { paidOn: { gte: from, lte: to }, ...one({ project: { clientId } }) },
        select: { amount: true, paidOn: true, project: { select: { clientId: true, client: { select: { name: true } } } } },
      }),
      this.prisma.acctInvoicePayment.findMany({
        where: { paidOn: { gte: from, lte: to }, invoice: { cancelled: false, ...one({ clientId }) } },
        select: { amount: true, paidOn: true, invoice: { select: { clientId: true, clientName: true } } },
      }),
      this.prisma.acctInvoice.findMany({ where: { cancelled: false, ...one({ clientId }) }, include: invoiceInclude }),
      this.prisma.acctExpense.findMany({
        where: { status: { in: ['APPROVED', 'PAID'] }, dateIncurred: { gte: from, lte: to }, ...one({ clientId }) },
        select: { amount: true, dateIncurred: true, clientId: true, category: { select: { name: true, parent: { select: { name: true } } } } },
      }),
      this.cfg.settings(),
    ]);
    return {
      clients: clients.map((c) => ({ ...c, status: String(c.status) })),
      projects: projects.map((p) => ({ clientId: p.clientId, status: p.status })),
      income: [
        ...projectPayments.map((p) => ({ clientId: p.project.clientId, clientName: p.project.client.name, amount: num(p.amount), date: iso(p.paidOn)! })),
        ...invoicePayments.map((p) => ({ clientId: p.invoice.clientId, clientName: p.invoice.clientName, amount: num(p.amount), date: iso(p.paidOn)! })),
      ],
      expenses: expenses.map((e) => ({
        clientId: e.clientId, amount: num(e.amount), date: iso(e.dateIncurred)!,
        category: e.category ? (e.category.parent ? e.category.parent.name : e.category.name) : 'Uncategorized',
      })),
      invoices: invoices.map((i) => {
        const x = shapeInvoice(i, s);
        return { clientId: i.clientId, clientName: i.clientName, date: x.date, total: x.total, balance: x.balance, status: x.status };
      }),
    };
  }

  async clients(q: AnalysisQuery) {
    return { from: q.from.slice(0, 10), to: q.to.slice(0, 10), ...analyseClients(await this.load(q), q.from, q.to) };
  }

  async client(id: string, q: AnalysisQuery) {
    const client = await this.prisma.client.findUnique({ where: { id }, select: { id: true, name: true, status: true, contactName: true, phone: true, email: true } });
    if (!client) throw new NotFoundException('Client not found');
    const input = await this.load(q, id);
    const a = analyseClients(input, q.from, q.to);
    const { from, to } = this.range(q);
    const [projects, invoices, expenses] = await Promise.all([
      this.projects.listProjects({ clientId: id } as ProjectQuery),
      this.invoices.listInvoices({ clientId: id }),
      this.prisma.acctExpense.findMany({
        where: { clientId: id, dateIncurred: { gte: from, lte: to } }, include: expenseInclude, orderBy: [{ dateIncurred: 'desc' }, { createdAt: 'desc' }], take: 200,
      }),
    ]);
    const row = a.clients.find((c) => c.clientId === id) ?? null;
    return {
      from: q.from.slice(0, 10), to: q.to.slice(0, 10), client, summary: row, months: a.months,
      categories: spendByCategory(input.expenses.filter((e) => e.clientId === id)),
      projects, invoices, expenses: expenses.map(shapeExpense),
    };
  }
}
