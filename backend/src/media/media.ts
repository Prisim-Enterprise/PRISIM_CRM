import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { MediaExpenseCategory, MediaKind, MediaStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';

const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const opt = (max: number) => [IsOptional(), Transform(trimOrNull), ValidateIf((_: unknown, v: unknown) => v !== null), IsString(), MaxLength(max)];
const OptText = (max: number) => (target: object, key: string) => opt(max).forEach((d) => d(target, key));

class ItemQuery {
  @IsOptional() @IsEnum(MediaKind) kind?: MediaKind;
  @IsOptional() @IsEnum(MediaStatus) status?: MediaStatus;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() assignee?: string; // "me" | user id
  /** A client id, or "none" for Prisim's own work (no client). */
  @IsOptional() @Matches(/^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, { message: 'client must be a client id or "none"' }) client?: string;
}

class CreateItemDto {
  @IsEnum(MediaKind) kind: MediaKind;
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsDateString() scheduledAt: string;
  @IsOptional() @IsEnum(MediaStatus) status?: MediaStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() assigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @OptText(60) platform?: string | null;
  @OptText(300) location?: string | null;
  @OptText(500) models?: string | null;
  @OptText(1000) link?: string | null;
  @OptText(10000) notes?: string | null;
}

class UpdateItemDto {
  @IsOptional() @IsEnum(MediaKind) kind?: MediaKind;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @IsDateString() scheduledAt?: string;
  @IsOptional() @IsEnum(MediaStatus) status?: MediaStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() assigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @OptText(60) platform?: string | null;
  @OptText(300) location?: string | null;
  @OptText(500) models?: string | null;
  @OptText(1000) link?: string | null;
  @OptText(10000) notes?: string | null;
}

class ExpenseQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsEnum(MediaExpenseCategory) category?: MediaExpenseCategory;
  @IsOptional() @IsUUID() shootId?: string;
}

class ExpenseDto {
  @IsDateString() spentOn: string;
  @IsEnum(MediaExpenseCategory) category: MediaExpenseCategory;
  @IsString() @MinLength(1) @MaxLength(200) payee: string;
  @OptText(2000) description?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) amount: number;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() paidOn?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() shootId?: string | null;
}

class UpdateExpenseDto {
  @IsOptional() @IsDateString() spentOn?: string;
  @IsOptional() @IsEnum(MediaExpenseCategory) category?: MediaExpenseCategory;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) payee?: string;
  @OptText(2000) description?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) amount?: number;
  @IsOptional() @IsBoolean() paid?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() paidOn?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() shootId?: string | null;
}

const person = { select: { id: true, fullName: true } } as const;
const itemInclude = {
  assignee: person,
  createdBy: person,
  client: { select: { id: true, name: true } },
  _count: { select: { expenses: true } },
} satisfies Prisma.MediaItemInclude;

/** A calendar day, stored without a time. */
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const KIND_LABEL: Record<MediaKind, string> = { SHOOT: 'Shoot', REEL: 'Reel post', CONTENT: 'Content writing', IMAGE: 'Image post' };
/** Fields an assignee may change on their own entry. Everything else needs media.manage. */
const ASSIGNEE_FIELDS = ['status', 'link', 'notes'] as const;

@Injectable()
export class MediaService {
  constructor(private prisma: PrismaService, private audit: AuditService, private notifications: NotificationsService) {}

  private manages(u: AuthUser) { return u.permissions.has('media.manage'); }
  private seesAll(u: AuthUser) { return this.manages(u) || u.permissions.has('media.view.all'); }

  /** Without view-all, people see what is assigned to them or what they added. */
  private visible(u: AuthUser): Prisma.MediaItemWhereInput {
    return this.seesAll(u) ? {} : { OR: [{ assigneeId: u.id }, { createdById: u.id }] };
  }

  private async checkLinks(dto: { assigneeId?: string | null; clientId?: string | null }) {
    if (dto.assigneeId && !(await this.prisma.user.count({ where: { id: dto.assigneeId, isActive: true, deletedAt: null } }))) {
      throw new BadRequestException('That person is inactive or does not exist');
    }
    if (dto.clientId && !(await this.prisma.client.count({ where: { id: dto.clientId } }))) {
      throw new BadRequestException('That client does not exist');
    }
  }

  private decorate(u: AuthUser, i: Prisma.MediaItemGetPayload<{ include: typeof itemInclude }>) {
    const mine = i.assigneeId === u.id;
    return { ...i, permissions: { canManage: this.manages(u), canUpdate: this.manages(u) || mine } };
  }

  async list(u: AuthUser, q: ItemQuery) {
    const and: Prisma.MediaItemWhereInput[] = [this.visible(u)];
    if (q.kind) and.push({ kind: q.kind });
    if (q.status) and.push({ status: q.status });
    if (q.from) and.push({ scheduledAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ scheduledAt: { lt: new Date(q.to) } });
    if (q.assignee) and.push({ assigneeId: q.assignee === 'me' ? u.id : q.assignee });
    if (q.client) and.push({ clientId: q.client === 'none' ? null : q.client });
    const items = await this.prisma.mediaItem.findMany({ where: { AND: and }, include: itemInclude, orderBy: { scheduledAt: 'asc' }, take: 1000 });
    return items.map((i) => this.decorate(u, i));
  }

  /** Counts for the top of the page: the next 7 days by kind, and anything past its date that isn't done. */
  async summary(u: AuthUser) {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 86_400_000);
    const open = { notIn: ['DONE', 'CANCELLED'] as MediaStatus[] };
    const where = this.visible(u);
    const [upcoming, overdue, mine] = await Promise.all([
      this.prisma.mediaItem.groupBy({ by: ['kind'], where: { AND: [where, { scheduledAt: { gte: now, lt: week }, status: open }] }, _count: true }),
      this.prisma.mediaItem.count({ where: { AND: [where, { scheduledAt: { lt: now }, status: open }] } }),
      this.prisma.mediaItem.count({ where: { assigneeId: u.id, status: open } }),
    ]);
    const thisWeek = Object.fromEntries(Object.keys(KIND_LABEL).map((k) => [k, upcoming.find((g) => g.kind === k)?._count ?? 0]));
    return { thisWeek, overdue, mine };
  }

  async create(u: AuthUser, dto: CreateItemDto) {
    await this.checkLinks(dto);
    const i = await this.prisma.mediaItem.create({
      data: {
        kind: dto.kind, title: dto.title.trim(), scheduledAt: new Date(dto.scheduledAt), status: dto.status ?? 'PLANNED',
        assigneeId: dto.assigneeId ?? null, clientId: dto.clientId ?? null, platform: dto.platform, location: dto.location,
        models: dto.models, link: dto.link, notes: dto.notes, createdById: u.id,
      },
      include: itemInclude,
    });
    await this.audit.record({ actorId: u.id, action: 'media.created', entityType: 'media', entityId: i.id, after: { kind: i.kind, title: i.title, scheduledAt: i.scheduledAt } });
    if (i.assigneeId && i.assigneeId !== u.id) await this.tellAssignee(i);
    return this.decorate(u, i);
  }

  private tellAssignee(i: { id: string; kind: MediaKind; title: string; scheduledAt: Date; assigneeId: string | null }) {
    const when = i.scheduledAt.toLocaleString('en-IN', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return this.notifications.notify(i.assigneeId, {
      type: 'media.assigned', title: `${KIND_LABEL[i.kind]} assigned to you: ${i.title}`, body: `Scheduled for ${when}`, link: `/media?item=${i.id}`,
    });
  }

  async update(u: AuthUser, id: string, dto: UpdateItemDto) {
    const before = await this.prisma.mediaItem.findFirst({ where: { AND: [{ id }, this.visible(u)] } });
    if (!before) throw new NotFoundException('Schedule entry not found');
    if (!this.manages(u)) {
      if (before.assigneeId !== u.id) throw new ForbiddenException('Only the person assigned, or a media manager, can update this');
      const extra = Object.keys(dto).filter((k) => (dto as Record<string, unknown>)[k] !== undefined && !(ASSIGNEE_FIELDS as readonly string[]).includes(k));
      if (extra.length) throw new ForbiddenException('You can update the status, link and notes. Ask a media manager to change the rest.');
    }
    await this.checkLinks(dto);
    const i = await this.prisma.mediaItem.update({
      where: { id },
      data: {
        kind: dto.kind, title: dto.title?.trim(), scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined, status: dto.status,
        assigneeId: dto.assigneeId, clientId: dto.clientId, platform: dto.platform, location: dto.location, models: dto.models, link: dto.link, notes: dto.notes,
      },
      include: itemInclude,
    });
    const keys = ['kind', 'title', 'scheduledAt', 'status', 'assigneeId', 'clientId', 'platform', 'location', 'models', 'link', 'notes'] as const;
    const changed = Object.fromEntries(keys.filter((k) => String(before[k]) !== String(i[k])).map((k) => [k, { from: before[k], to: i[k] }]));
    if (Object.keys(changed).length) await this.audit.record({ actorId: u.id, action: 'media.updated', entityType: 'media', entityId: id, after: changed });
    if (i.assigneeId && i.assigneeId !== before.assigneeId && i.assigneeId !== u.id) await this.tellAssignee(i);
    return this.decorate(u, i);
  }

  async remove(u: AuthUser, id: string) {
    const i = await this.prisma.mediaItem.findUnique({ where: { id } });
    if (!i) throw new NotFoundException('Schedule entry not found');
    await this.prisma.mediaItem.delete({ where: { id } }); // Expenses stay, without the shoot link.
    await this.audit.record({ actorId: u.id, action: 'media.deleted', entityType: 'media', entityId: id, before: { kind: i.kind, title: i.title, scheduledAt: i.scheduledAt } });
    return { deleted: true };
  }

  // ───── Expenses ─────

  private async checkShoot(shootId?: string | null) {
    if (shootId && !(await this.prisma.mediaItem.count({ where: { id: shootId, kind: 'SHOOT' } }))) throw new BadRequestException('That shoot does not exist');
  }

  async expenses(q: ExpenseQuery) {
    const where: Prisma.MediaExpenseWhereInput = {
      ...(q.category ? { category: q.category } : {}),
      ...(q.shootId ? { shootId: q.shootId } : {}),
      ...(q.from || q.to ? { spentOn: { ...(q.from ? { gte: day(q.from) } : {}), ...(q.to ? { lt: day(q.to) } : {}) } } : {}),
    };
    const rows = await this.prisma.mediaExpense.findMany({
      where, include: { shoot: { select: { id: true, title: true, scheduledAt: true } }, createdBy: person },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }], take: 2000,
    });
    const items = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
    const sum = (f: (r: (typeof items)[number]) => boolean) => Math.round(items.filter(f).reduce((a, r) => a + r.amount, 0) * 100) / 100;
    const byCategory = Object.fromEntries(Object.values(MediaExpenseCategory).map((c) => [c, sum((r) => r.category === c)]));
    return { items, totals: { total: sum(() => true), paid: sum((r) => r.paid), unpaid: sum((r) => !r.paid), byCategory } };
  }

  async createExpense(u: AuthUser, dto: ExpenseDto) {
    await this.checkShoot(dto.shootId);
    const paid = dto.paid ?? false;
    const e = await this.prisma.mediaExpense.create({
      data: {
        spentOn: day(dto.spentOn), category: dto.category, payee: dto.payee.trim(), description: dto.description, amount: dto.amount,
        paid, paidOn: paid ? (dto.paidOn ? day(dto.paidOn) : day(new Date().toISOString())) : null, shootId: dto.shootId ?? null, createdById: u.id,
      },
    });
    await this.audit.record({ actorId: u.id, action: 'media.expense.created', entityType: 'media_expense', entityId: e.id, after: { payee: e.payee, amount: dto.amount, category: e.category } });
    return { ...e, amount: Number(e.amount) };
  }

  async updateExpense(u: AuthUser, id: string, dto: UpdateExpenseDto) {
    const before = await this.prisma.mediaExpense.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Expense not found');
    await this.checkShoot(dto.shootId);
    const paidOn = dto.paid === false ? null
      : dto.paidOn !== undefined ? (dto.paidOn ? day(dto.paidOn) : null)
        : dto.paid === true && !before.paid ? day(new Date().toISOString()) : undefined;
    const e = await this.prisma.mediaExpense.update({
      where: { id },
      data: {
        spentOn: dto.spentOn ? day(dto.spentOn) : undefined, category: dto.category, payee: dto.payee?.trim(), description: dto.description,
        amount: dto.amount, paid: dto.paid, paidOn, shootId: dto.shootId,
      },
    });
    const keys = ['spentOn', 'category', 'payee', 'description', 'amount', 'paid', 'paidOn', 'shootId'] as const;
    const changed = Object.fromEntries(keys.filter((k) => String(before[k]) !== String(e[k])).map((k) => [k, { from: before[k], to: e[k] }]));
    if (Object.keys(changed).length) await this.audit.record({ actorId: u.id, action: 'media.expense.updated', entityType: 'media_expense', entityId: id, after: changed });
    return { ...e, amount: Number(e.amount) };
  }

  async removeExpense(u: AuthUser, id: string) {
    const e = await this.prisma.mediaExpense.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Expense not found');
    await this.prisma.mediaExpense.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'media.expense.deleted', entityType: 'media_expense', entityId: id, before: { payee: e.payee, amount: Number(e.amount), category: e.category } });
    return { deleted: true };
  }
}

@ApiTags('Media')
@ApiBearerAuth()
@Controller()
export class MediaController {
  constructor(private svc: MediaService) {}

  @Get('media') list(@CurrentUser() u: AuthUser, @Query() q: ItemQuery) { return this.svc.list(u, q); }
  @Get('media/summary') summary(@CurrentUser() u: AuthUser) { return this.svc.summary(u); }
  @Post('media') @RequireAny('media.manage') create(@CurrentUser() u: AuthUser, @Body() dto: CreateItemDto) { return this.svc.create(u, dto); }
  @Patch('media/:id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateItemDto) { return this.svc.update(u, id, dto); }
  @Delete('media/:id') @RequireAny('media.manage') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }

  @Get('media-expenses') @RequireAny('media.expenses') expenses(@Query() q: ExpenseQuery) { return this.svc.expenses(q); }
  @Post('media-expenses') @RequireAny('media.expenses') createExpense(@CurrentUser() u: AuthUser, @Body() dto: ExpenseDto) { return this.svc.createExpense(u, dto); }
  @Patch('media-expenses/:id') @RequireAny('media.expenses') updateExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto) { return this.svc.updateExpense(u, id, dto); }
  @Delete('media-expenses/:id') @RequireAny('media.expenses') removeExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeExpense(u, id); }
}

@Module({ providers: [MediaService], controllers: [MediaController] })
export class MediaModule {}
