import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerQuery } from './dto';
import { AccountingSettingsService } from './settings.service';
import { day, invoiceInclude, iso, num, person, r2, shapeInvoice } from './shared';

/** The raw figures behind the accounting dashboard and reports. */
@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService, private cfg: AccountingSettingsService) {}

  async ledger(q: LedgerQuery) {
    const from = day(q.from), to = day(q.to);
    if (to < from) throw new BadRequestException('The end date is before the start date');
    if (to.getTime() - from.getTime() > 6 * 366 * 86400000) throw new BadRequestException('Pick a range of six years or less');
    const [expenses, projectPayments, invoicePayments, invoices, categories, s] = await Promise.all([
      this.prisma.acctExpense.findMany({
        where: { dateIncurred: { gte: from, lte: to }, status: { not: 'REJECTED' } },
        select: {
          id: true, amount: true, dateIncurred: true, status: true, paymentMethod: true, categoryId: true, vendorId: true, projectId: true,
          category: { select: { parentId: true } }, vendor: { select: { name: true } }, submittedBy: person,
          project: { select: { title: true, client: { select: { name: true } } } },
        },
      }),
      this.prisma.acctProjectPayment.findMany({ where: { paidOn: { gte: from, lte: to } }, select: { amount: true, paidOn: true, method: true, project: { select: { id: true, title: true, client: { select: { id: true, name: true } } } } } }),
      this.prisma.acctInvoicePayment.findMany({
        where: { paidOn: { gte: from, lte: to }, invoice: { cancelled: false } },
        select: { amount: true, paidOn: true, method: true, invoice: { select: { id: true, number: true, clientId: true, clientName: true } } },
      }),
      this.prisma.acctInvoice.findMany({ where: { cancelled: false }, include: invoiceInclude }),
      this.prisma.acctCategory.findMany({ select: { id: true, name: true, parentId: true, monthlyBudget: true, annualBudget: true, sortOrder: true, archived: true } }),
      this.cfg.settings(),
    ]);
    const shapedInvoices = invoices.map((i) => shapeInvoice(i, s));
    const overdue = shapedInvoices.filter((i) => i.status === 'overdue');
    return {
      fyStartMonth: s.fyStartMonth,
      expenses: expenses.map((e) => ({
        id: e.id, amount: num(e.amount), date: iso(e.dateIncurred)!, status: e.status, method: e.paymentMethod,
        categoryId: e.categoryId, topCategoryId: e.category ? e.category.parentId ?? e.categoryId : null,
        vendorId: e.vendorId, vendorName: e.vendor?.name ?? null, projectId: e.projectId,
        projectLabel: e.project ? `${e.project.client.name} · ${e.project.title}` : null,
        submitterId: e.submittedBy.id, submitterName: e.submittedBy.fullName,
      })),
      income: [
        ...projectPayments.map((p) => ({ amount: num(p.amount), date: iso(p.paidOn)!, method: p.method, clientId: p.project.client.id, clientName: p.project.client.name, source: `Project · ${p.project.title}` })),
        ...invoicePayments.map((p) => ({ amount: num(p.amount), date: iso(p.paidOn)!, method: p.method, clientId: p.invoice.clientId, clientName: p.invoice.clientName, source: `Invoice ${p.invoice.number}` })),
      ],
      invoices: {
        count: shapedInvoices.length,
        invoicedInRange: r2(shapedInvoices.filter((i) => i.date >= q.from.slice(0, 10) && i.date <= q.to.slice(0, 10)).reduce((a, i) => a + i.total, 0)),
        outstanding: r2(shapedInvoices.reduce((a, i) => a + i.balance, 0)),
        overdue: r2(overdue.reduce((a, i) => a + i.balance, 0)),
        overdueCount: overdue.length,
      },
      categories: categories.map((c) => ({ ...c, monthlyBudget: c.monthlyBudget == null ? null : num(c.monthlyBudget), annualBudget: c.annualBudget == null ? null : num(c.annualBudget) })),
    };
  }
}
