import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { AcctExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { AuthUser } from '../common/current-user';
import { CategoryDto, DeleteManyDto, ExpenseDto, ExpenseQuery, MonthQuery, ReviewDto, UpdateCategoryDto, UpdateExpenseDto } from './dto';
import { AccountingSettingsService } from './settings.service';
import {
  assertCanSubmit, assertClientExists, csv, day, expenseInclude, expenseOrder, expenseWhere, iso, isManager, MAX_RECEIPT_BYTES,
  expenseClientId, normalizeTags, num, RECEIPT_TYPES, reviewFields, shapeExpense, today,
} from './shared';

/** Expenses, their receipts, and the categories / budgets they are filed under. */
@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService, private audit: AuditService, private storage: StorageService, private cfg: AccountingSettingsService) {}

  // ── Lookups for forms ──
  async lookups(u: AuthUser) {
    assertCanSubmit(u);
    const [categories, vendors, projects, clients] = await Promise.all([
      this.prisma.acctCategory.findMany({ where: { archived: false }, select: { id: true, name: true, parentId: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.acctVendor.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.acctProject.findMany({
        where: { status: { not: 'CANCELLED' } }, select: { id: true, title: true, status: true, clientId: true, client: { select: { name: true } } }, orderBy: { createdAt: 'desc' },
      }),
      this.prisma.client.findMany({ select: { id: true, name: true, status: true }, orderBy: [{ status: 'asc' }, { name: 'asc' }] }),
    ]);
    const tags = isManager(u)
      ? await this.prisma.$queryRaw<{ tag: string }[]>`SELECT DISTINCT unnest("tags") AS tag FROM "acct_expenses" ORDER BY 1 LIMIT 300`
      : [];
    return {
      categories, vendors, clients, tags: tags.map((t) => t.tag),
      projects: projects.map((p) => ({ id: p.id, title: p.title, status: p.status, clientId: p.clientId, clientName: p.client.name })),
      canManage: isManager(u),
    };
  }

  // ── Categories & budgets ──
  async categories(q: MonthQuery) {
    const s = await this.cfg.settings();
    const month = q.month ?? today().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const monthFrom = day(`${month}-01`);
    const monthTo = new Date(Date.UTC(y, m, 1));
    const fyYear = m >= s.fyStartMonth ? y : y - 1;
    const fyFrom = new Date(Date.UTC(fyYear, s.fyStartMonth - 1, 1));
    const fyTo = new Date(Date.UTC(fyYear + 1, s.fyStartMonth - 1, 1));
    const settled = { in: ['APPROVED', 'PAID'] as AcctExpenseStatus[] };
    const [cats, monthSpend, yearSpend, counts] = await Promise.all([
      this.prisma.acctCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], where: { status: settled, dateIncurred: { gte: monthFrom, lt: monthTo } }, _sum: { amount: true } }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], where: { status: settled, dateIncurred: { gte: fyFrom, lt: fyTo } }, _sum: { amount: true } }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], _count: true }),
    ]);
    const mm = new Map(monthSpend.map((r) => [r.categoryId, num(r._sum.amount)]));
    const yy = new Map(yearSpend.map((r) => [r.categoryId, num(r._sum.amount)]));
    const cc = new Map(counts.map((r) => [r.categoryId, r._count]));
    return {
      month, fiscalYear: { from: iso(fyFrom), to: iso(new Date(fyTo.getTime() - 86400000)) },
      uncategorized: { month: mm.get(null) ?? 0, year: yy.get(null) ?? 0 },
      categories: cats.map((c) => ({
        id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder, archived: c.archived,
        monthlyBudget: c.monthlyBudget == null ? null : num(c.monthlyBudget), annualBudget: c.annualBudget == null ? null : num(c.annualBudget),
        spentMonth: mm.get(c.id) ?? 0, spentYear: yy.get(c.id) ?? 0, expenseCount: cc.get(c.id) ?? 0,
      })),
    };
  }

  private async assertUniqueCategory(name: string, parentId: string | null, exceptId?: string) {
    const clash = await this.prisma.acctCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, parentId, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new ConflictException(`"${name}" already exists here`);
  }

  async createCategory(u: AuthUser, dto: CategoryDto) {
    const name = dto.name.trim();
    const parentId = dto.parentId ?? null;
    if (parentId) {
      const parent = await this.prisma.acctCategory.findUnique({ where: { id: parentId } });
      if (!parent) throw new BadRequestException('That parent category does not exist');
      if (parent.parentId) throw new BadRequestException('Subcategories cannot have their own subcategories');
    }
    await this.assertUniqueCategory(name, parentId);
    const c = await this.prisma.acctCategory.create({
      data: { name, parentId, monthlyBudget: dto.monthlyBudget ?? null, annualBudget: dto.annualBudget ?? null, sortOrder: dto.sortOrder ?? 0, archived: dto.archived ?? false },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.category_created', entityType: 'acct_category', entityId: c.id, after: { name } });
    return c;
  }

  async updateCategory(u: AuthUser, id: string, dto: UpdateCategoryDto) {
    const before = await this.prisma.acctCategory.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Category not found');
    if (dto.name) await this.assertUniqueCategory(dto.name.trim(), before.parentId, id);
    const c = await this.prisma.acctCategory.update({
      where: { id },
      data: { name: dto.name?.trim(), monthlyBudget: dto.monthlyBudget, annualBudget: dto.annualBudget, sortOrder: dto.sortOrder, archived: dto.archived },
    });
    await this.audit.record({
      actorId: u.id, action: 'accounting.category_updated', entityType: 'acct_category', entityId: id,
      before: { name: before.name, monthlyBudget: before.monthlyBudget, annualBudget: before.annualBudget, archived: before.archived },
      after: { name: c.name, monthlyBudget: c.monthlyBudget, annualBudget: c.annualBudget, archived: c.archived },
    });
    return c;
  }

  async removeCategory(u: AuthUser, id: string) {
    const c = await this.prisma.acctCategory.findUnique({ where: { id }, include: { _count: { select: { children: true, expenses: true } } } });
    if (!c) throw new NotFoundException('Category not found');
    if (c._count.children) throw new BadRequestException('Remove or move its subcategories first');
    if (c._count.expenses) throw new BadRequestException(`${c._count.expenses} expense(s) use this category. Archive it instead, so they keep their category.`);
    await this.prisma.acctCategory.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.category_deleted', entityType: 'acct_category', entityId: id, before: { name: c.name } });
    return { deleted: true };
  }

  // ── Expenses ──
  async listExpenses(u: AuthUser, q: ExpenseQuery) {
    assertCanSubmit(u);
    const where = expenseWhere(u, q);
    const pageSize = q.pageSize ?? 50;
    const page = q.page ?? 1;
    const [items, total, sum, pending] = await Promise.all([
      this.prisma.acctExpense.findMany({ where, include: expenseInclude, orderBy: expenseOrder(q.sort), skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.acctExpense.count({ where }),
      this.prisma.acctExpense.aggregate({ where, _sum: { amount: true } }),
      this.prisma.acctExpense.aggregate({ where: { status: 'PENDING', ...(isManager(u) ? {} : { submittedById: u.id }) }, _sum: { amount: true }, _count: true }),
    ]);
    return {
      items: items.map(shapeExpense), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      sum: num(sum._sum.amount), pending: { count: pending._count, amount: num(pending._sum.amount) },
    };
  }

  async exportExpenses(u: AuthUser, q: ExpenseQuery) {
    assertCanSubmit(u);
    const rows = await this.prisma.acctExpense.findMany({ where: expenseWhere(u, q), include: expenseInclude, orderBy: expenseOrder(q.sort), take: 20000 });
    const body = csv([
      ['Date', 'Amount (INR)', 'Status', 'Category', 'Vendor / payee', 'Client', 'Project', 'Payment method', 'Description', 'Tags', 'Date paid', 'Submitted by', 'Reviewed by', 'Review comment', 'Receipt'],
      ...rows.map((r) => {
        const e = shapeExpense(r);
        return [e.dateIncurred, e.amount.toFixed(2), e.status, e.categoryLabel ?? '', e.vendor?.name ?? '', e.client?.name ?? e.project?.client.name ?? '', e.project?.title ?? '',
          e.paymentMethod, e.description ?? '', e.tags.join('; '), e.datePaid ?? '', e.submittedBy.fullName, e.reviewedBy?.fullName ?? '', e.reviewComment ?? '', e.hasReceipt ? 'yes' : ''];
      }),
    ]);
    return { name: `prisim-expenses-${today()}.csv`, body };
  }

  private async vendorId(name: string | null | undefined): Promise<string | null | undefined> {
    if (name === undefined) return undefined;
    const n = (name ?? '').trim().replace(/\s+/g, ' ');
    if (!n) return null;
    const found = await this.prisma.acctVendor.findFirst({ where: { name: { equals: n, mode: 'insensitive' } } });
    if (found) return found.id;
    try { return (await this.prisma.acctVendor.create({ data: { name: n } })).id; }
    catch { return (await this.prisma.acctVendor.findFirstOrThrow({ where: { name: { equals: n, mode: 'insensitive' } } })).id; }
  }

  private async checkRefs(dto: { categoryId?: string | null; clientId?: string | null }) {
    if (dto.categoryId && !(await this.prisma.acctCategory.count({ where: { id: dto.categoryId } }))) throw new BadRequestException('That category does not exist');
    await assertClientExists(this.prisma, dto.clientId);
  }

  /** The client of a project (and a 400 if the project doesn't exist). */
  private async projectClient(projectId: string | null | undefined): Promise<string | null> {
    if (!projectId) return null;
    const p = await this.prisma.acctProject.findUnique({ where: { id: projectId }, select: { clientId: true } });
    if (!p) throw new BadRequestException('That project does not exist');
    return p.clientId;
  }

  async createExpense(u: AuthUser, dto: ExpenseDto) {
    assertCanSubmit(u);
    await this.checkRefs(dto);
    const manager = isManager(u);
    const status = manager ? dto.status ?? 'APPROVED' : 'PENDING';
    const datePaid = dto.datePaid ? day(dto.datePaid) : null;
    const e = await this.prisma.acctExpense.create({
      data: {
        amount: dto.amount, dateIncurred: day(dto.dateIncurred), datePaid, categoryId: dto.categoryId ?? null, vendorId: (await this.vendorId(dto.vendorName)) ?? null,
        projectId: dto.projectId ?? null, clientId: expenseClientId(await this.projectClient(dto.projectId), dto.clientId ?? null),
        paymentMethod: dto.paymentMethod ?? 'BANK_TRANSFER', description: dto.description?.trim() || null,
        tags: normalizeTags(dto.tags ?? []), submittedById: u.id,
        status: 'PENDING', ...reviewFields(u.id, status, 'PENDING', datePaid), reviewComment: manager ? dto.reviewComment?.trim() || null : null,
      },
      include: expenseInclude,
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.expense_created', entityType: 'acct_expense', entityId: e.id, after: { amount: num(e.amount), status: e.status } });
    return shapeExpense(e);
  }

  /** Managers can touch any expense; others only their own, and only while it is pending. */
  private async ownExpense(u: AuthUser, id: string) {
    const e = await this.prisma.acctExpense.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Expense not found');
    if (!isManager(u)) {
      if (e.submittedById !== u.id) throw new NotFoundException('Expense not found');
      if (e.status !== 'PENDING') throw new ForbiddenException('Only pending expenses can be changed. Ask an accounts manager.');
    }
    return e;
  }

  async updateExpense(u: AuthUser, id: string, dto: UpdateExpenseDto) {
    assertCanSubmit(u);
    const before = await this.ownExpense(u, id);
    await this.checkRefs(dto);
    const manager = isManager(u);
    const datePaid = dto.datePaid === undefined ? before.datePaid : dto.datePaid ? day(dto.datePaid) : null;
    const e = await this.prisma.acctExpense.update({
      where: { id },
      data: {
        amount: dto.amount, dateIncurred: dto.dateIncurred ? day(dto.dateIncurred) : undefined,
        datePaid: dto.datePaid === undefined ? undefined : datePaid, categoryId: dto.categoryId, vendorId: await this.vendorId(dto.vendorName),
        projectId: dto.projectId, paymentMethod: dto.paymentMethod,
        clientId: expenseClientId(await this.projectClient(dto.projectId === undefined ? before.projectId : dto.projectId), dto.clientId, before.clientId),
        description: dto.description === undefined ? undefined : dto.description?.trim() || null,
        tags: dto.tags ? normalizeTags(dto.tags) : undefined,
        ...(manager ? reviewFields(u.id, dto.status, before.status, datePaid) : {}),
        ...(manager && dto.reviewComment !== undefined ? { reviewComment: dto.reviewComment?.trim() || null } : {}),
      },
      include: expenseInclude,
    });
    await this.audit.record({
      actorId: u.id, action: 'accounting.expense_updated', entityType: 'acct_expense', entityId: id,
      before: { amount: num(before.amount), status: before.status }, after: { amount: num(e.amount), status: e.status },
    });
    return shapeExpense(e);
  }

  async reviewExpenses(u: AuthUser, dto: ReviewDto) {
    const rows = await this.prisma.acctExpense.findMany({ where: { id: { in: dto.ids } }, select: { id: true, status: true, datePaid: true } });
    const comment = dto.comment?.trim() || null;
    await this.prisma.$transaction(rows.map((r) => this.prisma.acctExpense.update({
      where: { id: r.id },
      data: { ...reviewFields(u.id, dto.status, r.status, r.datePaid), ...(dto.comment !== undefined ? { reviewComment: comment } : {}) },
    })));
    await this.audit.record({ actorId: u.id, action: 'accounting.expenses_reviewed', entityType: 'acct_expense', after: { count: rows.length, status: dto.status, comment } });
    return { updated: rows.length };
  }

  async removeExpense(u: AuthUser, id: string) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    await this.prisma.acctExpense.delete({ where: { id } });
    if (e.receiptKey) await this.storage.remove(e.receiptKey).catch(() => undefined);
    await this.audit.record({ actorId: u.id, action: 'accounting.expense_deleted', entityType: 'acct_expense', entityId: id, before: { amount: num(e.amount), status: e.status, date: iso(e.dateIncurred) } });
    return { deleted: true };
  }

  async removeExpenses(u: AuthUser, dto: DeleteManyDto) {
    const rows = await this.prisma.acctExpense.findMany({ where: { id: { in: dto.ids } }, select: { id: true, receiptKey: true } });
    await this.prisma.acctExpense.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    await Promise.all(rows.map((r) => (r.receiptKey ? this.storage.remove(r.receiptKey).catch(() => undefined) : undefined)));
    await this.audit.record({ actorId: u.id, action: 'accounting.expenses_deleted', entityType: 'acct_expense', after: { count: rows.length } });
    return { deleted: rows.length };
  }

  // ── Receipts ──
  async attachReceipt(u: AuthUser, id: string, file?: Express.Multer.File) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException('Receipts can be up to 10 MB');
    if (!RECEIPT_TYPES.includes(file.mimetype)) throw new BadRequestException('Receipts can be a photo (PNG, JPG, WebP, HEIC) or a PDF');
    const key = await this.storage.save('receipts', file.buffer, file.originalname, file.mimetype);
    try {
      await this.prisma.acctExpense.update({ where: { id }, data: { receiptKey: key, receiptName: file.originalname.slice(0, 200), receiptType: file.mimetype } });
    } catch (err) {
      await this.storage.remove(key).catch(() => undefined);
      throw err;
    }
    if (e.receiptKey) await this.storage.remove(e.receiptKey).catch(() => undefined);
    return { hasReceipt: true, receiptName: file.originalname };
  }

  async removeReceipt(u: AuthUser, id: string) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    if (!e.receiptKey) return { hasReceipt: false };
    await this.prisma.acctExpense.update({ where: { id }, data: { receiptKey: null, receiptName: null, receiptType: null } });
    await this.storage.remove(e.receiptKey).catch(() => undefined);
    return { hasReceipt: false };
  }

  async receipt(u: AuthUser, id: string, res: Response) {
    assertCanSubmit(u);
    const e = await this.prisma.acctExpense.findUnique({ where: { id } });
    if (!e?.receiptKey || (!isManager(u) && e.submittedById !== u.id)) throw new NotFoundException('Receipt not found');
    return this.storage.send(res, e.receiptKey, e.receiptType ?? 'application/octet-stream', undefined, e.receiptName ?? 'receipt');
  }
}
