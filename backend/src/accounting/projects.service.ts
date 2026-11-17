import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/current-user';
import { PaymentDto, ProjectDto, ProjectQuery, UpdateProjectDto } from './dto';
import { AccountingSettingsService } from './settings.service';
import {
  assertClientExists, ClientDetails, day, expenseInclude, InvoiceItem, invoiceInclude, invoiceTotals, iso, num, person, projectFigures,
  ProjectMoney, r2, shapeExpense, shapeInvoice,
} from './shared';

/** Client projects: what was quoted, received (direct or through invoices) and spent. */
@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private cfg: AccountingSettingsService) {}

  private async projectMoney(ids: string[]) {
    if (!ids.length) return new Map<string, ProjectMoney>();
    const [pp, ip, spent, inv] = await Promise.all([
      this.prisma.acctProjectPayment.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _sum: { amount: true }, _max: { paidOn: true }, _count: true }),
      this.prisma.acctInvoicePayment.findMany({ where: { invoice: { projectId: { in: ids }, cancelled: false } }, select: { amount: true, paidOn: true, invoice: { select: { projectId: true } } } }),
      this.prisma.acctExpense.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: { in: ['APPROVED', 'PAID'] } }, _sum: { amount: true } }),
      this.prisma.acctInvoice.findMany({ where: { projectId: { in: ids }, cancelled: false }, select: { projectId: true, items: true, discount: true, gstRate: true, clientDetails: true } }),
    ]);
    const s = await this.cfg.settings();
    const out = new Map<string, ProjectMoney>(ids.map((id) => [id, { received: 0, spent: 0, invoiced: 0, lastPayment: null, paymentCount: 0 }]));
    for (const r of pp) {
      const o = out.get(r.projectId)!;
      o.received += num(r._sum.amount); o.paymentCount += r._count; o.lastPayment = iso(r._max.paidOn);
    }
    for (const r of ip) {
      const o = out.get(r.invoice.projectId!)!;
      o.received += num(r.amount); o.paymentCount += 1;
      const d = iso(r.paidOn)!;
      if (!o.lastPayment || d > o.lastPayment) o.lastPayment = d;
    }
    for (const r of spent) out.get(r.projectId!)!.spent = num(r._sum.amount);
    for (const r of inv) {
      out.get(r.projectId!)!.invoiced += invoiceTotals({ items: r.items as InvoiceItem[], discount: num(r.discount), gstRate: num(r.gstRate), clientDetails: r.clientDetails as ClientDetails }, s.stateCode, 0).total;
    }
    for (const o of out.values()) { o.received = r2(o.received); o.spent = r2(o.spent); o.invoiced = r2(o.invoiced); }
    return out;
  }

  private shapeProject<T extends { quotedAmount: Prisma.Decimal | null; meetingDate: Date | null; shootStart: Date | null; shootEnd: Date | null }>(p: T, money: ProjectMoney) {
    const quoted = p.quotedAmount == null ? null : num(p.quotedAmount);
    return {
      ...p, quotedAmount: quoted, meetingDate: iso(p.meetingDate), shootStart: iso(p.shootStart), shootEnd: iso(p.shootEnd), ...money,
      ...projectFigures(quoted, money),
    };
  }

  async listProjects(q: ProjectQuery) {
    const s = q.search?.trim();
    const rows = await this.prisma.acctProject.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}), ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(s ? { OR: [{ title: { contains: s, mode: 'insensitive' } }, { client: { name: { contains: s, mode: 'insensitive' } } }] } : {}),
      },
      include: { client: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const money = await this.projectMoney(rows.map((r) => r.id));
    return rows.map((r) => this.shapeProject(r, money.get(r.id)!));
  }

  async getProject(id: string) {
    const p = await this.prisma.acctProject.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, contactName: true, phone: true, email: true } },
        createdBy: person,
        payments: { orderBy: { paidOn: 'asc' } },
        expenses: { include: expenseInclude, orderBy: { dateIncurred: 'desc' } },
        invoices: { include: invoiceInclude, orderBy: { date: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    const money = (await this.projectMoney([id])).get(id)!;
    const s = await this.cfg.settings();
    const { payments, expenses, invoices, ...rest } = p;
    return {
      ...this.shapeProject(rest, money),
      payments: payments.map((x) => ({ ...x, amount: num(x.amount), paidOn: iso(x.paidOn)! })),
      expenses: expenses.map(shapeExpense),
      invoices: invoices.map((i) => shapeInvoice(i, s)),
    };
  }

  private checkShoot(start?: string | null, end?: string | null) {
    if (start && end && end < start) throw new BadRequestException('The shoot cannot end before it starts');
  }

  async createProject(u: AuthUser, dto: ProjectDto) {
    await assertClientExists(this.prisma, dto.clientId);
    this.checkShoot(dto.shootStart, dto.shootEnd);
    const p = await this.prisma.acctProject.create({
      data: {
        clientId: dto.clientId, title: dto.title.trim(), meetingDate: dto.meetingDate ? day(dto.meetingDate) : null,
        shootStart: dto.shootStart ? day(dto.shootStart) : null, shootEnd: dto.shootEnd ? day(dto.shootEnd) : null,
        quotedAmount: dto.quotedAmount ?? null, status: dto.status ?? 'ACTIVE', notes: dto.notes?.trim() || null, createdById: u.id,
      },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_created', entityType: 'acct_project', entityId: p.id, after: { title: p.title } });
    return this.getProject(p.id);
  }

  async updateProject(u: AuthUser, id: string, dto: UpdateProjectDto) {
    const before = await this.prisma.acctProject.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Project not found');
    await assertClientExists(this.prisma, dto.clientId);
    const d = (v: string | null | undefined) => (v === undefined ? undefined : v ? day(v) : null);
    this.checkShoot(dto.shootStart === undefined ? iso(before.shootStart) : dto.shootStart, dto.shootEnd === undefined ? iso(before.shootEnd) : dto.shootEnd);
    await this.prisma.acctProject.update({
      where: { id },
      data: {
        clientId: dto.clientId, title: dto.title?.trim(), meetingDate: d(dto.meetingDate), shootStart: d(dto.shootStart), shootEnd: d(dto.shootEnd),
        quotedAmount: dto.quotedAmount, status: dto.status, notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
      },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_updated', entityType: 'acct_project', entityId: id, before: { title: before.title, status: before.status }, after: dto });
    return this.getProject(id);
  }

  async removeProject(u: AuthUser, id: string) {
    const p = await this.prisma.acctProject.findUnique({ where: { id }, include: { _count: { select: { payments: true, invoices: true } } } });
    if (!p) throw new NotFoundException('Project not found');
    if (p._count.invoices) throw new BadRequestException('This project has invoices. Cancel it instead (Status → Cancelled).');
    await this.prisma.acctProject.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_deleted', entityType: 'acct_project', entityId: id, before: { title: p.title, payments: p._count.payments } });
    return { deleted: true };
  }

  async addProjectPayment(u: AuthUser, id: string, dto: PaymentDto) {
    if (!(await this.prisma.acctProject.count({ where: { id } }))) throw new NotFoundException('Project not found');
    const pay = await this.prisma.acctProjectPayment.create({
      data: { projectId: id, amount: dto.amount, paidOn: day(dto.paidOn), method: dto.method ?? 'BANK_TRANSFER', note: dto.note?.trim() || null },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_payment_added', entityType: 'acct_project', entityId: id, after: { amount: dto.amount, paidOn: dto.paidOn } });
    return { ...pay, amount: num(pay.amount), paidOn: iso(pay.paidOn) };
  }

  async removeProjectPayment(u: AuthUser, id: string) {
    const pay = await this.prisma.acctProjectPayment.findUnique({ where: { id } });
    if (!pay) throw new NotFoundException('Payment not found');
    await this.prisma.acctProjectPayment.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_payment_removed', entityType: 'acct_project', entityId: pay.projectId, before: { amount: num(pay.amount), paidOn: iso(pay.paidOn) } });
    return { deleted: true };
  }
}
