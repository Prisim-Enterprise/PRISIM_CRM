import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { PostingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { localDateKey } from '../common/time';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const OptText = (max: number) => (target: object, key: string) =>
  [IsOptional(), Transform(trimOrNull), ValidateIf((_: unknown, v: unknown) => v !== null), IsString(), MaxLength(max)].forEach((d) => d(target, key));

class PeriodDto {
  @Matches(DATE, { message: 'leadStart must be a date' }) leadStart: string;
  @Matches(DATE, { message: 'leadEnd must be a date' }) leadEnd: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE) shootDate?: string | null;
  @OptText(2000) notes?: string | null;
  /** Adds an empty row for every day of the period. */
  @IsOptional() @IsBoolean() fillDays?: boolean;
}
class UpdatePeriodDto {
  @IsOptional() @Matches(DATE) leadStart?: string;
  @IsOptional() @Matches(DATE) leadEnd?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE) shootDate?: string | null;
  @OptText(2000) notes?: string | null;
}
class SlotDto {
  @Matches(DATE, { message: 'date must be a date' }) date: string;
  @OptText(300) video?: string | null;
  @IsOptional() @IsEnum(PostingStatus) videoStatus?: PostingStatus;
  @OptText(300) poster?: string | null;
  @IsOptional() @IsEnum(PostingStatus) posterStatus?: PostingStatus;
  @OptText(300) leads?: string | null;
}
class UpdateSlotDto {
  @IsOptional() @Matches(DATE) date?: string;
  @OptText(300) video?: string | null;
  @IsOptional() @IsEnum(PostingStatus) videoStatus?: PostingStatus;
  @OptText(300) poster?: string | null;
  @IsOptional() @IsEnum(PostingStatus) posterStatus?: PostingStatus;
  @OptText(300) leads?: string | null;
}

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const todayKey = () => localDateKey(new Date());
const MAX_DAYS = 400;
/** A real item, not a placeholder dash. */
export const named = (s?: string | null) => !!s && !/^[\s\-–—_.]*$/.test(s);
/** Still to do: marked Not yet, or planned (named) but not marked Done. */
export const pending = (text: string | null, status: PostingStatus) => status === 'NOT_YET' || (named(text) && status === 'NONE');

@Injectable()
export class PostingService {
  private log = new Logger('Posting');
  private lastRun = 0;
  constructor(private prisma: PrismaService, private audit: AuditService, private notifications: NotificationsService) {}

  private canEdit(u: AuthUser) { return u.permissions.has('clients.posting') || u.permissions.has('clients.manage'); }
  private canView(u: AuthUser) { return this.canEdit(u) || u.permissions.has('clients.view.all'); }
  private assertEdit(u: AuthUser) { if (!this.canEdit(u)) throw new ForbiddenException('You need the "Edit client posting calendars" permission'); }
  private assertView(u: AuthUser) { if (!this.canView(u)) throw new ForbiddenException('You do not have access to posting calendars'); }

  async forClient(u: AuthUser, clientId: string) {
    this.assertView(u);
    if (!(await this.prisma.client.count({ where: { id: clientId } }))) throw new NotFoundException('Client not found');
    const periods = await this.prisma.postingPeriod.findMany({
      where: { clientId }, orderBy: { leadStart: 'desc' },
      include: { slots: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }, createdBy: { select: { id: true, fullName: true } } },
    });
    return { today: todayKey(), canEdit: this.canEdit(u), periods };
  }

  async createPeriod(u: AuthUser, clientId: string, dto: PeriodDto) {
    this.assertEdit(u);
    if (!(await this.prisma.client.count({ where: { id: clientId } }))) throw new NotFoundException('Client not found');
    const start = day(dto.leadStart), end = day(dto.leadEnd);
    if (end < start) throw new BadRequestException('The lead end date is before the start date');
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days > MAX_DAYS) throw new BadRequestException('A lead period can be up to about a year');
    const p = await this.prisma.postingPeriod.create({
      data: {
        clientId, leadStart: start, leadEnd: end, shootDate: dto.shootDate ? day(dto.shootDate) : null, notes: dto.notes, createdById: u.id,
        slots: dto.fillDays ? { create: Array.from({ length: days }, (_, i) => ({ date: new Date(start.getTime() + i * 86_400_000) })) } : undefined,
      },
      include: { slots: true },
    });
    await this.audit.record({ actorId: u.id, action: 'posting.period.created', entityType: 'posting_period', entityId: p.id, after: { clientId, leadStart: dto.leadStart, leadEnd: dto.leadEnd, rows: p.slots.length } });
    return p;
  }

  async updatePeriod(u: AuthUser, id: string, dto: UpdatePeriodDto) {
    this.assertEdit(u);
    const before = await this.prisma.postingPeriod.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Lead period not found');
    const start = dto.leadStart ? day(dto.leadStart) : before.leadStart, end = dto.leadEnd ? day(dto.leadEnd) : before.leadEnd;
    if (end < start) throw new BadRequestException('The lead end date is before the start date');
    const p = await this.prisma.postingPeriod.update({
      where: { id },
      data: { leadStart: start, leadEnd: end, shootDate: dto.shootDate === undefined ? undefined : dto.shootDate ? day(dto.shootDate) : null, notes: dto.notes },
    });
    await this.audit.record({ actorId: u.id, action: 'posting.period.updated', entityType: 'posting_period', entityId: id, before, after: p });
    return p;
  }

  async removePeriod(u: AuthUser, id: string) {
    this.assertEdit(u);
    const p = await this.prisma.postingPeriod.findUnique({ where: { id }, include: { _count: { select: { slots: true } } } });
    if (!p) throw new NotFoundException('Lead period not found');
    await this.prisma.postingPeriod.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'posting.period.deleted', entityType: 'posting_period', entityId: id, before: { clientId: p.clientId, leadStart: p.leadStart, leadEnd: p.leadEnd, rows: p._count.slots } });
    return { deleted: true };
  }

  async addSlot(u: AuthUser, periodId: string, dto: SlotDto) {
    this.assertEdit(u);
    if (!(await this.prisma.postingPeriod.count({ where: { id: periodId } }))) throw new NotFoundException('Lead period not found');
    return this.prisma.postingSlot.create({
      data: { periodId, date: day(dto.date), video: dto.video, videoStatus: dto.videoStatus, poster: dto.poster, posterStatus: dto.posterStatus, leads: dto.leads },
    });
  }

  async updateSlot(u: AuthUser, id: string, dto: UpdateSlotDto) {
    this.assertEdit(u);
    const before = await this.prisma.postingSlot.findUnique({ where: { id }, include: { period: { select: { clientId: true } } } });
    if (!before) throw new NotFoundException('Row not found');
    const s = await this.prisma.postingSlot.update({
      where: { id },
      data: {
        date: dto.date ? day(dto.date) : undefined, video: dto.video, videoStatus: dto.videoStatus, poster: dto.poster, posterStatus: dto.posterStatus, leads: dto.leads,
        // A new date gets its own reminder.
        ...(dto.date && dto.date !== before.date.toISOString().slice(0, 10) ? { reminderSentOn: null } : {}),
      },
    });
    const keys = ['date', 'video', 'videoStatus', 'poster', 'posterStatus', 'leads'] as const;
    const changed = Object.fromEntries(keys.filter((k) => String(before[k]) !== String(s[k])).map((k) => [k, { from: before[k], to: s[k] }]));
    if (Object.keys(changed).length) await this.audit.record({ actorId: u.id, action: 'posting.row.updated', entityType: 'posting_slot', entityId: id, after: { clientId: before.period.clientId, ...changed } });
    return s;
  }

  async removeSlot(u: AuthUser, id: string) {
    this.assertEdit(u);
    if (!(await this.prisma.postingSlot.count({ where: { id } }))) throw new NotFoundException('Row not found');
    await this.prisma.postingSlot.delete({ where: { id } });
    return { deleted: true };
  }

  /** Things scheduled for today, and anything from the last two weeks still not done. */
  async due(u: AuthUser) {
    this.assertView(u);
    await this.remind().catch((e) => this.log.error(`Posting reminders failed: ${(e as Error).message}`));
    const today = day(todayKey());
    const slots = await this.prisma.postingSlot.findMany({
      where: { date: { gte: new Date(today.getTime() - 14 * 86_400_000), lte: today }, OR: [{ videoStatus: { not: 'DONE' } }, { posterStatus: { not: 'DONE' } }] },
      include: { period: { select: { client: { select: { id: true, name: true } } } } },
      orderBy: [{ date: 'asc' }],
    });
    const items = slots.flatMap((s) => {
      const out: { slotId: string; clientId: string; client: string; date: string; kind: 'video' | 'poster'; item: string | null; overdue: boolean }[] = [];
      const base = { slotId: s.id, clientId: s.period.client.id, client: s.period.client.name, date: s.date.toISOString().slice(0, 10), overdue: s.date < today };
      if (pending(s.video, s.videoStatus)) out.push({ ...base, kind: 'video', item: named(s.video) ? s.video : null });
      if (pending(s.poster, s.posterStatus)) out.push({ ...base, kind: 'poster', item: named(s.poster) ? s.poster : null });
      return out;
    });
    return { today: todayKey(), items };
  }

  /**
   * Reminds people who look after posting calendars about today's unfinished reels and posters,
   * and once more the day after if still not done. One notification per client per day.
   * Runs from the scheduler, /internal/tick and (at most every 10 minutes) when the due list is read.
   */
  async remind(force = false) {
    if (!force && Date.now() - this.lastRun < 10 * 60_000) return { sent: 0 };
    this.lastRun = Date.now();
    const today = day(todayKey());
    const yesterday = new Date(today.getTime() - 86_400_000);
    const slots = await this.prisma.postingSlot.findMany({
      where: { date: { gte: yesterday, lte: today }, OR: [{ reminderSentOn: null }, { reminderSentOn: { lt: today } }] },
      include: { period: { select: { client: { select: { id: true, name: true } } } } },
    });
    const due = slots.filter((s) => pending(s.video, s.videoStatus) || pending(s.poster, s.posterStatus));
    if (!due.length) return { sent: 0 };
    const people = [...new Set([...(await this.notifications.usersWithPermission('clients.posting')), ...(await this.notifications.usersWithPermission('clients.manage'))])];
    const groups = new Map<string, typeof due>();
    for (const s of due) {
      const k = `${s.period.client.id}|${s.date.toISOString().slice(0, 10)}`;
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const list of groups.values()) {
      const s0 = list[0];
      const isToday = s0.date.getTime() === today.getTime();
      const what = list.flatMap((s) => [
        ...(pending(s.video, s.videoStatus) ? [named(s.video) ? s.video! : 'Reel / video'] : []),
        ...(pending(s.poster, s.posterStatus) ? [named(s.poster) ? s.poster! : 'AI poster'] : []),
      ]);
      await this.notifications.notifyMany(people, {
        type: 'posting.reminder',
        title: `${isToday ? 'Today' : 'Overdue since yesterday'}, ${s0.period.client.name}: ${what.join(', ')}`,
        body: isToday ? 'Scheduled for today and not done yet.' : 'Was scheduled for yesterday and is still not done.',
        link: `/clients/${s0.period.client.id}?tab=posting`,
      });
    }
    await this.prisma.postingSlot.updateMany({ where: { id: { in: due.map((s) => s.id) } }, data: { reminderSentOn: today } });
    this.log.log(`Posting reminders: ${groups.size} sent`);
    return { sent: groups.size };
  }
}

@Injectable()
export class PostingReminders {
  constructor(private posting: PostingService) {}
  /** 09:30 India time every day (04:00 UTC). On Vercel, /internal/tick and the due list do this instead. */
  @Cron('0 4 * * *')
  run() { return this.posting.remind(true); }
}

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class PostingController {
  constructor(private svc: PostingService) {}

  @Get('clients/:id/posting') forClient(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.forClient(u, id); }
  @Post('clients/:id/posting/periods') createPeriod(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PeriodDto) { return this.svc.createPeriod(u, id, dto); }
  @Get('posting/due') due(@CurrentUser() u: AuthUser) { return this.svc.due(u); }
  @Patch('posting/periods/:id') updatePeriod(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePeriodDto) { return this.svc.updatePeriod(u, id, dto); }
  @Delete('posting/periods/:id') removePeriod(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removePeriod(u, id); }
  @Post('posting/periods/:id/rows') addSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SlotDto) { return this.svc.addSlot(u, id, dto); }
  @Patch('posting/rows/:id') updateSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSlotDto) { return this.svc.updateSlot(u, id, dto); }
  @Delete('posting/rows/:id') removeSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeSlot(u, id); }
}

@Module({ providers: [PostingService, PostingReminders], controllers: [PostingController], exports: [PostingService] })
export class PostingModule {}

