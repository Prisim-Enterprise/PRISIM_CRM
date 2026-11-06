import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { PageQuery, paged, skipTake } from '../common/pagination';
import { localDayRange } from '../common/time';
import { LeadsModule } from '../leads/leads.controller';
import { LeadsService } from '../leads/leads.service';
import { isClosed } from '../leads/lead-status';

const FOLLOW_UP_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'other'];

class FollowUpQuery extends PageQuery {
  @IsOptional() @IsIn(['today', 'upcoming', 'overdue', 'completed', 'cancelled', 'pending', 'all']) view?: string;
  /** "me" or a user id; defaults to everyone in scope */
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsUUID() leadId?: string;
}

class CreateFollowUpDto {
  @IsUUID() leadId: string;
  @IsDateString() dueAt: string;
  @IsOptional() @IsIn(FOLLOW_UP_TYPES) type?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class NextActionDto {
  @IsDateString() dueAt: string;
  @IsOptional() @IsIn(FOLLOW_UP_TYPES) type?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class CompleteDto {
  @IsString() @MinLength(1) @MaxLength(100) outcome: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @ValidateNested() @Type(() => NextActionDto) next?: NextActionDto;
  /** Close the lead instead of scheduling a next action */
  @IsOptional() @IsIn(['CONVERTED', 'LOST', 'INVALID']) closeStatus?: 'CONVERTED' | 'LOST' | 'INVALID';
  @IsOptional() @IsString() @MaxLength(500) closeReason?: string;
  /** Mark lead as interested when keeping it open */
  @IsOptional() @IsIn(['INTERESTED', 'FOLLOW_UP_REQUIRED']) leadStatus?: 'INTERESTED' | 'FOLLOW_UP_REQUIRED';
}

class RescheduleDto {
  @IsDateString() dueAt: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class CancelDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

const include = {
  lead: { select: { id: true, fullName: true, phoneE164: true, status: true, campaignName: true } },
  owner: { select: { id: true, fullName: true } },
} satisfies Prisma.FollowUpInclude;

@Injectable()
export class FollowUpsService {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private audit: AuditService,
    private leads: LeadsService,
    private notifications: NotificationsService,
  ) {}

  private async scopeWhere(user: AuthUser, owner?: string): Promise<Prisma.FollowUpWhereInput> {
    const ids = await this.access.userIdsInScope(user, 'followups.view');
    if (owner === 'me') return { ownerId: user.id };
    if (owner) {
      if (ids !== null && !ids.includes(owner)) return { ownerId: '00000000-0000-0000-0000-000000000000' };
      return { ownerId: owner };
    }
    return ids === null ? {} : { ownerId: { in: ids } };
  }

  async list(user: AuthUser, q: FollowUpQuery) {
    const now = new Date();
    const { start, end } = localDayRange(now);
    const view: Prisma.FollowUpWhereInput = (() => {
      switch (q.view) {
        case 'today': return { status: 'PENDING', dueAt: { gte: start, lt: end } };
        case 'upcoming': return { status: 'PENDING', dueAt: { gte: end } };
        case 'overdue': return { status: 'PENDING', dueAt: { lt: now } };
        case 'completed': return { status: 'COMPLETED' };
        case 'cancelled': return { status: 'CANCELLED' };
        case 'pending': return { status: 'PENDING' };
        default: return {};
      }
    })();
    const where: Prisma.FollowUpWhereInput = {
      AND: [await this.scopeWhere(user, q.owner), view, q.leadId ? { leadId: q.leadId } : {}],
    };
    const orderBy: Prisma.FollowUpOrderByWithRelationInput = q.view === 'completed' ? { completedAt: 'desc' } : { dueAt: 'asc' };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.followUp.findMany({ where, orderBy, include, ...skipTake(q) }),
      this.prisma.followUp.count({ where }),
    ]);
    return paged(items.map((f) => ({ ...f, isOverdue: f.status === 'PENDING' && f.dueAt < now })), total, q);
  }

  async summary(user: AuthUser, owner?: string) {
    const now = new Date();
    const { start, end } = localDayRange(now);
    const base = await this.scopeWhere(user, owner);
    const count = (w: Prisma.FollowUpWhereInput) => this.prisma.followUp.count({ where: { AND: [base, w] } });
    const [dueToday, overdue, upcoming, completedToday] = await Promise.all([
      count({ status: 'PENDING', dueAt: { gte: start, lt: end } }),
      count({ status: 'PENDING', dueAt: { lt: now } }),
      count({ status: 'PENDING', dueAt: { gte: end } }),
      count({ status: 'COMPLETED', completedAt: { gte: start, lt: end } }),
    ]);
    return { dueToday, overdue, upcoming, completedToday };
  }

  async create(user: AuthUser, dto: CreateFollowUpDto) {
    const lead = await this.leads.getLeadForEdit(user, dto.leadId);
    if (isClosed(lead.status)) throw new BadRequestException('Reopen the lead before scheduling a follow-up');
    const dueAt = new Date(dto.dueAt);
    const f = await this.prisma.$transaction(async (tx) => {
      const created = await tx.followUp.create({
        data: {
          leadId: lead.id, ownerId: lead.assignedUserId ?? user.id, createdById: user.id,
          dueAt, type: dto.type ?? 'call', note: dto.note,
        },
        include,
      });
      await this.leads.advance(tx, lead.id, 'FOLLOW_UP_REQUIRED', user.id, 'Follow-up scheduled');
      return created;
    });
    if (f.ownerId !== user.id) {
      await this.notifications.notify(f.ownerId, {
        type: 'followup.created', title: `Follow-up scheduled: ${f.lead.fullName}`, body: `By ${user.fullName}`, link: `/leads/${lead.id}`,
      });
    }
    return f;
  }

  private async getForEdit(user: AuthUser, id: string) {
    const f = await this.prisma.followUp.findUnique({ where: { id }, include: { lead: true } });
    if (!f) throw new NotFoundException('Follow-up not found');
    // Owner of the follow-up, or anyone who can edit the lead.
    if (f.ownerId !== user.id) await this.leads.getLeadForEdit(user, f.leadId);
    return f;
  }

  /**
   * Completing a follow-up never closes the lead by itself: the user must either
   * schedule the next action or explicitly close the lead with a reason.
   */
  async complete(user: AuthUser, id: string, dto: CompleteDto) {
    const f = await this.getForEdit(user, id);
    if (f.status !== 'PENDING') throw new BadRequestException('This follow-up is already closed');
    const leadOpen = !isClosed(f.lead.status);
    if (leadOpen && !dto.next && !dto.closeStatus) {
      throw new BadRequestException('Schedule the next follow-up or close the lead with a reason');
    }
    if (dto.closeStatus && dto.closeStatus !== 'CONVERTED' && !dto.closeReason?.trim()) {
      throw new BadRequestException('A reason is required to close the lead');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.followUp.update({
        where: { id }, data: { status: 'COMPLETED', outcome: dto.outcome, completedAt: new Date() },
      });
      if (dto.notes?.trim()) {
        await tx.leadNote.create({ data: { leadId: f.leadId, authorId: user.id, body: `[Follow-up: ${dto.outcome}] ${dto.notes.trim()}` } });
      }
      if (dto.closeStatus && leadOpen) {
        await this.leads.setStatus(tx, f.lead, dto.closeStatus, user.id, dto.closeReason ?? 'Closed from follow-up');
        await tx.followUp.updateMany({ where: { leadId: f.leadId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: `Lead closed as ${dto.closeStatus}` } });
      } else if (dto.next) {
        await tx.followUp.create({
          data: {
            leadId: f.leadId, ownerId: f.lead.assignedUserId ?? f.ownerId, createdById: user.id,
            dueAt: new Date(dto.next.dueAt), type: dto.next.type ?? 'call', note: dto.next.note,
          },
        });
        if (dto.leadStatus) await this.leads.advance(tx, f.leadId, dto.leadStatus, user.id, `Follow-up outcome: ${dto.outcome}`);
      }
    });
    await this.audit.record({ actorId: user.id, action: 'followup.completed', entityType: 'follow_up', entityId: id, after: dto });
    return { ok: true };
  }

  async reschedule(user: AuthUser, id: string, dto: RescheduleDto) {
    const f = await this.getForEdit(user, id);
    if (f.status !== 'PENDING') throw new BadRequestException('Only pending follow-ups can be rescheduled');
    const toDueAt = new Date(dto.dueAt);
    await this.prisma.$transaction([
      this.prisma.followUpReschedule.create({ data: { followUpId: id, fromDueAt: f.dueAt, toDueAt, reason: dto.reason, actorId: user.id } }),
      this.prisma.followUp.update({
        where: { id }, data: { dueAt: toDueAt, rescheduleCount: { increment: 1 }, reminderSentAt: null, overdueNotified: false },
      }),
    ]);
    return { ok: true };
  }

  async cancel(user: AuthUser, id: string, reason: string) {
    const f = await this.getForEdit(user, id);
    if (f.status !== 'PENDING') throw new BadRequestException('Only pending follow-ups can be cancelled');
    await this.prisma.followUp.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason } });
    await this.audit.record({ actorId: user.id, action: 'followup.cancelled', entityType: 'follow_up', entityId: id, after: { reason } });
    return { ok: true };
  }
}

/** Reminder engine: notifies owners 15 minutes before a follow-up and once when it becomes overdue. */
@Injectable()
export class FollowUpReminders {
  private log = new Logger('FollowUpReminders');
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    try {
      const now = new Date();
      const soon = new Date(now.getTime() + 15 * 60_000);
      const upcoming = await this.prisma.followUp.findMany({
        where: { status: 'PENDING', reminderSentAt: null, dueAt: { gte: now, lte: soon } },
        include: { lead: { select: { id: true, fullName: true } } }, take: 500,
      });
      for (const f of upcoming) {
        await this.notifications.notify(f.ownerId, {
          type: 'followup.reminder', title: `Follow-up due soon: ${f.lead.fullName}`,
          body: `${f.type} at ${f.dueAt.toISOString()}`, link: `/leads/${f.lead.id}`,
        });
        await this.prisma.followUp.update({ where: { id: f.id }, data: { reminderSentAt: now } });
      }
      const overdue = await this.prisma.followUp.findMany({
        where: { status: 'PENDING', overdueNotified: false, dueAt: { lt: now } },
        include: { lead: { select: { id: true, fullName: true } } }, take: 500,
      });
      for (const f of overdue) {
        await this.notifications.notify(f.ownerId, {
          type: 'followup.overdue', title: `Overdue follow-up: ${f.lead.fullName}`, link: `/leads/${f.lead.id}`,
        });
        await this.prisma.followUp.update({ where: { id: f.id }, data: { overdueNotified: true } });
      }
    } catch (e) {
      this.log.error(`Reminder run failed: ${(e as Error).message}`);
    }
  }
}

@ApiTags('Follow-ups')
@ApiBearerAuth()
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private svc: FollowUpsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: FollowUpQuery) {
    return this.svc.list(user, q);
  }

  @Get('today')
  today(@CurrentUser() user: AuthUser, @Query() q: FollowUpQuery) {
    return this.svc.list(user, { ...q, view: 'today' });
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query('owner') owner?: string) {
    return this.svc.summary(user, owner);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFollowUpDto) {
    return this.svc.create(user, dto);
  }

  @Post(':id/complete')
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteDto) {
    return this.svc.complete(user, id, dto);
  }

  @Post(':id/reschedule')
  reschedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    return this.svc.reschedule(user, id, dto);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.svc.cancel(user, id, dto.reason);
  }
}

@Module({ imports: [LeadsModule], providers: [FollowUpsService, FollowUpReminders], exports: [FollowUpReminders], controllers: [FollowUpsController] })
export class FollowUpsModule {}
