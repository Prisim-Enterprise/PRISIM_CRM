import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf,
} from 'class-validator';
import { Prisma, SeoStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';

const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const OptText = (max: number) => (target: object, key: string) =>
  [IsOptional(), Transform(trimOrNull), ValidateIf((_: unknown, v: unknown) => v !== null), IsString(), MaxLength(max)].forEach((d) => d(target, key));

class AccountDto {
  @IsUUID() clientId: string;
  @OptText(500) website?: string | null;
  @OptText(5000) scope?: string | null;
  @IsOptional() @IsEnum(SeoStatus) status?: SeoStatus;
  @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) assigneeIds: string[];
}

class UpdateAccountDto {
  @OptText(500) website?: string | null;
  @OptText(5000) scope?: string | null;
  @IsOptional() @IsEnum(SeoStatus) status?: SeoStatus;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) assigneeIds?: string[];
}

class UpdatesQuery {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsUUID() authorId?: string;
  @IsOptional() @IsDateString() from?: string; // work date, inclusive
  @IsOptional() @IsDateString() to?: string; // work date, inclusive
}

class PostUpdateDto {
  @IsUUID() accountId: string;
  @IsOptional() @IsDateString() workDate?: string;
  @IsString() @MinLength(2) @MaxLength(10000) body: string;
  @OptText(1000) link?: string | null;
}

class EditUpdateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(10000) body?: string;
  @OptText(1000) link?: string | null;
}

const person = { select: { id: true, fullName: true } } as const;
const accountInclude = {
  client: { select: { id: true, name: true, company: true } },
  assignees: { include: { user: person }, orderBy: { createdAt: 'asc' } },
  _count: { select: { updates: true } },
} satisfies Prisma.SeoAccountInclude;
const updateInclude = {
  author: person,
  account: { select: { id: true, website: true, client: { select: { id: true, name: true } } } },
} satisfies Prisma.SeoUpdateInclude;

/** Today's date where the team works, as a date-only value. */
const today = () => new Date(new Date().toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }) + 'T00:00:00.000Z');
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class SeoService {
  constructor(private prisma: PrismaService, private audit: AuditService, private notifications: NotificationsService) {}

  private manages(u: AuthUser) { return u.permissions.has('seo.manage'); }
  private seesAll(u: AuthUser) { return this.manages(u) || u.permissions.has('seo.view.all'); }
  /** Without view-all, people see the SEO clients they handle (and every update on those). */
  private visible(u: AuthUser): Prisma.SeoAccountWhereInput {
    return this.seesAll(u) ? {} : { assignees: { some: { userId: u.id } } };
  }

  private async activeUsers(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.user.count({ where: { id: { in: unique }, isActive: true, deletedAt: null } });
    if (found !== unique.length) throw new BadRequestException('One or more people are inactive or do not exist');
    return unique;
  }

  async accounts(u: AuthUser) {
    const accounts = await this.prisma.seoAccount.findMany({
      where: this.visible(u), include: accountInclude, orderBy: [{ status: 'asc' }, { client: { name: 'asc' } }],
    });
    const ids = accounts.map((a) => a.id);
    const [last, todays] = await Promise.all([
      this.prisma.seoUpdate.findMany({ where: { accountId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['accountId'], include: { author: person } }),
      this.prisma.seoUpdate.groupBy({ by: ['accountId'], where: { accountId: { in: ids }, workDate: today() }, _count: true }),
    ]);
    return accounts.map((a) => {
      const l = last.find((x) => x.accountId === a.id);
      return {
        ...a,
        lastUpdate: l ? { at: l.createdAt, by: l.author, workDate: l.workDate } : null,
        updatesToday: todays.find((t) => t.accountId === a.id)?._count ?? 0,
        permissions: { canManage: this.manages(u), canPost: this.manages(u) || a.assignees.some((x) => x.userId === u.id) },
      };
    });
  }

  async createAccount(u: AuthUser, dto: AccountDto) {
    if (!(await this.prisma.client.count({ where: { id: dto.clientId } }))) throw new BadRequestException('That client does not exist');
    const people = await this.activeUsers(dto.assigneeIds);
    const a = await this.prisma.seoAccount.create({
      data: {
        clientId: dto.clientId, website: dto.website, scope: dto.scope, status: dto.status ?? 'ACTIVE', createdById: u.id,
        assignees: { create: people.map((userId) => ({ userId })) },
      },
      include: accountInclude,
    });
    await this.audit.record({ actorId: u.id, action: 'seo.account.created', entityType: 'seo_account', entityId: a.id, after: { client: a.client.name, website: a.website, assignees: people } });
    await this.tellAssigned(u, a.id, a.client.name, people);
    return a;
  }

  private tellAssigned(u: AuthUser, accountId: string, client: string, userIds: string[]) {
    return this.notifications.notifyMany(userIds.filter((id) => id !== u.id), {
      type: 'seo.assigned', title: `You're handling SEO for ${client}`, body: 'Post your daily SEO updates for this client on the SEO page.', link: `/seo?account=${accountId}`,
    });
  }

  async updateAccount(u: AuthUser, id: string, dto: UpdateAccountDto) {
    const before = await this.prisma.seoAccount.findUnique({ where: { id }, include: { assignees: true, client: true } });
    if (!before) throw new NotFoundException('SEO client not found');
    const people = dto.assigneeIds ? await this.activeUsers(dto.assigneeIds) : undefined;
    const a = await this.prisma.$transaction(async (tx) => {
      if (people) {
        await tx.seoAssignee.deleteMany({ where: { accountId: id, userId: { notIn: people } } });
        await tx.seoAssignee.createMany({ data: people.map((userId) => ({ accountId: id, userId })), skipDuplicates: true });
      }
      return tx.seoAccount.update({ where: { id }, data: { website: dto.website, scope: dto.scope, status: dto.status }, include: accountInclude });
    });
    const oldPeople = before.assignees.map((x) => x.userId);
    const changed: Record<string, unknown> = {};
    for (const k of ['website', 'scope', 'status'] as const) if (dto[k] !== undefined && before[k] !== a[k]) changed[k] = { from: before[k], to: a[k] };
    if (people && (people.length !== oldPeople.length || people.some((p) => !oldPeople.includes(p)))) changed.assignees = { from: oldPeople, to: people };
    if (Object.keys(changed).length) await this.audit.record({ actorId: u.id, action: 'seo.account.updated', entityType: 'seo_account', entityId: id, after: changed });
    if (people) await this.tellAssigned(u, id, before.client.name, people.filter((p) => !oldPeople.includes(p)));
    return a;
  }

  async removeAccount(u: AuthUser, id: string) {
    const a = await this.prisma.seoAccount.findUnique({ where: { id }, include: { client: true, _count: { select: { updates: true } } } });
    if (!a) throw new NotFoundException('SEO client not found');
    await this.prisma.seoAccount.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'seo.account.deleted', entityType: 'seo_account', entityId: id, before: { client: a.client.name, website: a.website, updates: a._count.updates } });
    return { deleted: true };
  }

  // ───── Daily updates ─────

  async updates(u: AuthUser, q: UpdatesQuery) {
    const where: Prisma.SeoUpdateWhereInput = {
      account: this.visible(u),
      ...(q.accountId ? { accountId: q.accountId } : {}),
      ...(q.authorId ? { authorId: q.authorId } : {}),
      ...(q.from || q.to ? { workDate: { ...(q.from ? { gte: day(q.from) } : {}), ...(q.to ? { lte: day(q.to) } : {}) } } : {}),
    };
    const rows = await this.prisma.seoUpdate.findMany({ where, include: updateInclude, orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
    return rows.map((r) => ({ ...r, permissions: { canEdit: r.authorId === u.id, canDelete: r.authorId === u.id || this.manages(u) } }));
  }

  async postUpdate(u: AuthUser, dto: PostUpdateDto) {
    const a = await this.prisma.seoAccount.findFirst({ where: { AND: [{ id: dto.accountId }, this.visible(u)] }, include: { assignees: true } });
    if (!a) throw new NotFoundException('SEO client not found');
    if (!this.manages(u) && !a.assignees.some((x) => x.userId === u.id)) throw new ForbiddenException('Only the people handling this client can post updates');
    const workDate = dto.workDate ? day(dto.workDate) : today();
    if (workDate > today()) throw new BadRequestException('Updates are for work already done, so the date cannot be in the future');
    const r = await this.prisma.seoUpdate.create({
      data: { accountId: a.id, authorId: u.id, workDate, body: dto.body.trim(), link: dto.link }, include: updateInclude,
    });
    await this.audit.record({ actorId: u.id, action: 'seo.update.posted', entityType: 'seo_update', entityId: r.id, after: { client: r.account.client.name, workDate: r.workDate } });
    return r;
  }

  async editUpdate(u: AuthUser, id: string, dto: EditUpdateDto) {
    const before = await this.prisma.seoUpdate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Update not found');
    if (before.authorId !== u.id) throw new ForbiddenException('Only the person who posted an update can edit it');
    const r = await this.prisma.seoUpdate.update({ where: { id }, data: { body: dto.body?.trim(), link: dto.link }, include: updateInclude });
    // Admins see when a note was changed after posting, and what it said before.
    await this.audit.record({ actorId: u.id, action: 'seo.update.edited', entityType: 'seo_update', entityId: id, before: { body: before.body, link: before.link }, after: { body: r.body, link: r.link } });
    return r;
  }

  async removeUpdate(u: AuthUser, id: string) {
    const r = await this.prisma.seoUpdate.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Update not found');
    if (r.authorId !== u.id && !this.manages(u)) throw new ForbiddenException('Only the person who posted it, or an admin, can delete an update');
    await this.prisma.seoUpdate.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'seo.update.deleted', entityType: 'seo_update', entityId: id, before: { authorId: r.authorId, workDate: r.workDate, body: r.body } });
    return { deleted: true };
  }
}

@ApiTags('SEO')
@ApiBearerAuth()
@Controller('seo')
export class SeoController {
  constructor(private svc: SeoService) {}

  @Get('accounts') accounts(@CurrentUser() u: AuthUser) { return this.svc.accounts(u); }
  @Post('accounts') @RequireAny('seo.manage') createAccount(@CurrentUser() u: AuthUser, @Body() dto: AccountDto) { return this.svc.createAccount(u, dto); }
  @Patch('accounts/:id') @RequireAny('seo.manage') updateAccount(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAccountDto) { return this.svc.updateAccount(u, id, dto); }
  @Delete('accounts/:id') @RequireAny('seo.manage') removeAccount(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeAccount(u, id); }

  @Get('updates') updates(@CurrentUser() u: AuthUser, @Query() q: UpdatesQuery) { return this.svc.updates(u, q); }
  @Post('updates') postUpdate(@CurrentUser() u: AuthUser, @Body() dto: PostUpdateDto) { return this.svc.postUpdate(u, dto); }
  @Patch('updates/:id') editUpdate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EditUpdateDto) { return this.svc.editUpdate(u, id, dto); }
  @Delete('updates/:id') removeUpdate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeUpdate(u, id); }
}

@Module({ providers: [SeoService], controllers: [SeoController] })
export class SeoModule {}
