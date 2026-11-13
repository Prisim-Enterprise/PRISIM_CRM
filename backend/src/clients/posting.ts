import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query,
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
import { PostingSheetService } from './posting-sheet';

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
class SheetDto {
  @IsString() @MaxLength(500) url: string;
}
class RangeQuery {
  @Matches(DATE, { message: 'from must be a date' }) from: string;
  @Matches(DATE, { message: 'to must be a date' }) to: string;
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
  constructor(
    private prisma: PrismaService, private audit: AuditService, private notifications: NotificationsService, private sheet: PostingSheetService,
  ) {}

  /** Pulls the Google Sheet in if it's connected and the last sync is over a minute old. */
  private async fresh() {
    await this.sheet.sync().catch((e) => this.log.error(`Sheet sync failed: ${(e as Error).message}`));
  }

  /** Lead periods that come from the Google Sheet are edited there, not in the CRM. */
  private async assertNotFromSheet(periodId: string) {
    if ((await this.sheet.linkedPeriodIds()).has(periodId)) {
      throw new BadRequestException('This calendar comes from the Google Sheet. Change it in the sheet; the CRM picks it up within a minute, or use Sync now.');
    }
  }

  sheetStatus(u: AuthUser) { this.assertView(u); return this.sheet.status(); }
  async syncSheet(u: AuthUser) { this.assertView(u); return this.sheet.sync(true); }
  connectSheet(u: AuthUser, url: string) { this.assertEdit(u); return this.sheet.connect(u.id, url); }
  disconnectSheet(u: AuthUser) { this.assertEdit(u); return this.sheet.disconnect(u.id); }

  private canEdit(u: AuthUser) { return u.permissions.has('clients.posting') || u.permissions.has('clients.manage'); }
  private canView(u: AuthUser) { return this.canEdit(u) || u.permissions.has('clients.view.all'); }
  private assertEdit(u: AuthUser) { if (!this.canEdit(u)) throw new ForbiddenException('You need the "Edit client posting calendars" permission'); }
  private assertView(u: AuthUser) { if (!this.canView(u)) throw new ForbiddenException('You do not have access to posting calendars'); }

  async forClient(u: AuthUser, clientId: string) {
    this.assertView(u);
    if (!(await this.prisma.client.count({ where: { id: clientId } }))) throw new NotFoundException('Client not found');
    await this.fresh();
    const linked = await this.sheet.linkedPeriodIds();
    const sheet = await this.sheet.status();
    const periods = await this.prisma.postingPeriod.findMany({
      where: { clientId }, orderBy: { leadStart: 'desc' },
      include: { slots: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }, createdBy: { select: { id: true, fullName: true } } },
    });
    return {
      today: todayKey(), canEdit: this.canEdit(u), sheetUrl: sheet.connected ? sheet.url : null, lastSyncAt: sheet.lastSyncAt,
      periods: periods.map((p) => ({ ...p, fromSheet: linked.has(p.id), sheetTab: sheet.tabs.find((t) => t.periodId === p.id)?.name ?? null })),
    };
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
    await this.assertNotFromSheet(id);
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
    await this.assertNotFromSheet(id);
    const p = await this.prisma.postingPeriod.findUnique({ where: { id }, include: { _count: { select: { slots: true } } } });
    if (!p) throw new NotFoundException('Lead period not found');
    await this.prisma.postingPeriod.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'posting.period.deleted', entityType: 'posting_period', entityId: id, before: { clientId: p.clientId, leadStart: p.leadStart, leadEnd: p.leadEnd, rows: p._count.slots } });
    return { deleted: true };
  }

  async addSlot(u: AuthUser, periodId: string, dto: SlotDto) {
    this.assertEdit(u);
    await this.assertNotFromSheet(periodId);
    if (!(await this.prisma.postingPeriod.count({ where: { id: periodId } }))) throw new NotFoundException('Lead period not found');
    return this.prisma.postingSlot.create({
      data: { periodId, date: day(dto.date), video: dto.video, videoStatus: dto.videoStatus, poster: dto.poster, posterStatus: dto.posterStatus, leads: dto.leads },
    });
  }

  async updateSlot(u: AuthUser, id: string, dto: UpdateSlotDto) {
    this.assertEdit(u);
    const before = await this.prisma.postingSlot.findUnique({ where: { id }, include: { period: { select: { clientId: true } } } });
    if (!before) throw new NotFoundException('Row not found');
    await this.assertNotFromSheet(before.periodId);
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
    const s = await this.prisma.postingSlot.findUnique({ where: { id }, select: { periodId: true } });
    if (!s) throw new NotFoundException('Row not found');
    await this.assertNotFromSheet(s.periodId);
    await this.prisma.postingSlot.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Everything from the posting calendars between two dates, for the Media calendar:
   * lead starts and ends, shoot dates, and each reel/video and AI poster with its status.
   */
  async calendar(u: AuthUser, q: RangeQuery) {
    this.assertView(u);
    await this.fresh();
    const from = day(q.from), to = day(q.to);
    if (to < from || to.getTime() - from.getTime() > 62 * 86_400_000) throw new BadRequestException('Pick a range of up to about two months');
    const client = { select: { id: true, name: true } };
    const [periods, slots] = await Promise.all([
      this.prisma.postingPeriod.findMany({
        where: { OR: [{ leadStart: { gte: from, lte: to } }, { leadEnd: { gte: from, lte: to } }, { shootDate: { gte: from, lte: to } }] },
        include: { client },
      }),
      this.prisma.postingSlot.findMany({ where: { date: { gte: from, lte: to } }, include: { period: { select: { client } } }, orderBy: { date: 'asc' } }),
    ]);
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const inRange = (d: Date | null) => !!d && d >= from && d <= to;
    type Ev = { date: string; type: 'LEAD_START' | 'LEAD_END' | 'SHOOT' | 'VIDEO' | 'POSTER'; clientId: string; client: string; label: string | null; status: PostingStatus | null; slotId?: string };
    const events: Ev[] = [];
    for (const p of periods) {
      const base = { clientId: p.client.id, client: p.client.name, label: null, status: null };
      if (inRange(p.leadStart)) events.push({ ...base, date: key(p.leadStart), type: 'LEAD_START' });
      if (inRange(p.leadEnd)) events.push({ ...base, date: key(p.leadEnd), type: 'LEAD_END' });
      if (inRange(p.shootDate)) events.push({ ...base, date: key(p.shootDate!), type: 'SHOOT' });
    }
    for (const s of slots) {
      const base = { date: key(s.date), clientId: s.period.client.id, client: s.period.client.name, slotId: s.id };
      if (named(s.video) || s.videoStatus !== 'NONE') events.push({ ...base, type: 'VIDEO', label: named(s.video) ? s.video : null, status: s.videoStatus });
      if (named(s.poster) || s.posterStatus !== 'NONE') events.push({ ...base, type: 'POSTER', label: named(s.poster) ? s.poster : null, status: s.posterStatus });
    }
    return { today: todayKey(), canEdit: this.canEdit(u), events };
  }

  /**
   * One row per client that has a posting calendar: their current lead period (or the latest),
   * shoot date, how many reels and posters are done, and what's due today or overdue.
   */
  async overview(u: AuthUser) {
    this.assertView(u);
    await this.fresh();
    const today = day(todayKey());
    const periods = await this.prisma.postingPeriod.findMany({
      include: { client: { select: { id: true, name: true, status: true } }, slots: true },
      orderBy: { leadStart: 'desc' },
    });
    const byClient = new Map<string, typeof periods>();
    for (const p of periods) byClient.set(p.clientId, [...(byClient.get(p.clientId) ?? []), p]);
    const rows = [...byClient.values()].map((list) => {
      const p = list.find((x) => x.leadStart <= today && x.leadEnd >= today) ?? list[0];
      const v = p.slots.filter((s) => named(s.video) || s.videoStatus !== 'NONE');
      const po = p.slots.filter((s) => named(s.poster) || s.posterStatus !== 'NONE');
      const open = (s: (typeof p.slots)[number]) => (pending(s.video, s.videoStatus) ? 1 : 0) + (pending(s.poster, s.posterStatus) ? 1 : 0);
      const next = p.slots.filter((s) => s.date > today && open(s)).sort((a, b) => a.date.getTime() - b.date.getTime())[0];
      return {
        clientId: p.client.id, client: p.client.name, clientStatus: p.client.status, periods: list.length,
        periodId: p.id, leadStart: p.leadStart, leadEnd: p.leadEnd, shootDate: p.shootDate,
        current: p.leadStart <= today && p.leadEnd >= today,
        videos: v.length, videosDone: v.filter((s) => s.videoStatus === 'DONE').length,
        posters: po.length, postersDone: po.filter((s) => s.posterStatus === 'DONE').length,
        dueToday: p.slots.filter((s) => s.date.getTime() === today.getTime()).reduce((a, s) => a + open(s), 0),
        overdue: p.slots.filter((s) => s.date < today).reduce((a, s) => a + open(s), 0),
        nextDate: next?.date ?? null,
      };
    });
    rows.sort((a, b) => Number(b.current) - Number(a.current) || b.overdue - a.overdue || a.client.localeCompare(b.client));
    return { today: todayKey(), canEdit: this.canEdit(u), rows };
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
        link: `/media?tab=posting&client=${s0.period.client.id}`,
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
  @Get('posting/overview') overview(@CurrentUser() u: AuthUser) { return this.svc.overview(u); }
  @Get('posting/sheet') sheetStatus(@CurrentUser() u: AuthUser) { return this.svc.sheetStatus(u); }
  @Post('posting/sheet') connectSheet(@CurrentUser() u: AuthUser, @Body() dto: SheetDto) { return this.svc.connectSheet(u, dto.url); }
  @Post('posting/sheet/sync') syncSheet(@CurrentUser() u: AuthUser) { return this.svc.syncSheet(u); }
  @Delete('posting/sheet') disconnectSheet(@CurrentUser() u: AuthUser) { return this.svc.disconnectSheet(u); }
  @Get('posting/calendar') calendar(@CurrentUser() u: AuthUser, @Query() q: RangeQuery) { return this.svc.calendar(u, q); }
  @Patch('posting/periods/:id') updatePeriod(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePeriodDto) { return this.svc.updatePeriod(u, id, dto); }
  @Delete('posting/periods/:id') removePeriod(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removePeriod(u, id); }
  @Post('posting/periods/:id/rows') addSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SlotDto) { return this.svc.addSlot(u, id, dto); }
  @Patch('posting/rows/:id') updateSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSlotDto) { return this.svc.updateSlot(u, id, dto); }
  @Delete('posting/rows/:id') removeSlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeSlot(u, id); }
}

@Module({ providers: [PostingService, PostingReminders, PostingSheetService], controllers: [PostingController], exports: [PostingService, PostingSheetService] })
export class PostingModule {}

