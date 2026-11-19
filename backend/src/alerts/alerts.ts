import { Body, Controller, Get, Injectable, Logger, Module, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, Max, Min } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { CLOSED_STATUSES } from '../leads/lead-status';
import { idleLabel, inWorkHours, latest, LEAD_RULES_KEY, LeadRules, mergeRules, staleAction } from './lead-rules';

class LeadRulesDto {
  @IsBoolean() firstFollowUpEnabled: boolean;
  @Type(() => Number) @IsInt() @Min(1) @Max(1440) firstFollowUpMinutes: number;
  @Type(() => Number) @IsNumber() @Min(0.25) @Max(168) nudgeAfterHours: number;
  @Type(() => Number) @IsNumber() @Min(0.25) @Max(720) escalateAfterHours: number;
  @Type(() => Number) @IsNumber() @Min(0.25) @Max(168) followUpEscalateHours: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(23) workStartHour: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(24) workEndHour: number;
}

@Injectable()
export class LeadRulesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async get(): Promise<LeadRules> {
    const row = await this.prisma.integrationConfig.findUnique({ where: { key: LEAD_RULES_KEY }, select: { config: true } });
    return mergeRules(row?.config);
  }

  async save(u: AuthUser, dto: LeadRulesDto) {
    const rules = mergeRules(dto);
    const config = rules as unknown as Prisma.InputJsonValue;
    await this.prisma.integrationConfig.upsert({ where: { key: LEAD_RULES_KEY }, create: { key: LEAD_RULES_KEY, enabled: true, config }, update: { config } });
    await this.audit.record({ actorId: u.id, action: 'lead_rules.updated', entityType: 'integration', after: rules as unknown as Record<string, unknown> });
    return rules;
  }
}

/**
 * Chases leads nobody is working: the owner first, then their team leader and the managers.
 * Safe to run from several places at once: each alert is claimed with a conditional update first.
 */
@Injectable()
export class LeadAlerts {
  private log = new Logger('LeadAlerts');
  constructor(private prisma: PrismaService, private notifications: NotificationsService, private rules: LeadRulesService) {}

  async run(now = new Date()) {
    try {
      const r = await this.rules.get();
      if (!inWorkHours(now, r)) return { skipped: 'outside work hours' };
      const ctx = { managers: await this.notifications.usersWithPermission('leads.assign.all'), leaders: new Map<string, string[]>() };
      const leads = await this.staleLeads(now, r, ctx);
      const followUps = await this.lateFollowUps(now, r, ctx);
      return { leads, followUps };
    } catch (e) {
      this.log.error(`Lead alerts failed: ${(e as Error).message}`);
      return { error: (e as Error).message };
    }
  }

  /** Team leaders of every team the person is in, cached for the run. */
  private async leadersOf(userId: string, ctx: { leaders: Map<string, string[]> }) {
    if (!ctx.leaders.has(userId)) {
      const teams = await this.prisma.team.findMany({
        where: { leaderId: { not: null }, OR: [{ members: { some: { id: userId } } }, { memberships: { some: { userId } } }] },
        select: { leaderId: true },
      });
      ctx.leaders.set(userId, teams.map((t) => t.leaderId!));
    }
    return ctx.leaders.get(userId)!;
  }

  private async bosses(ownerId: string, ctx: { managers: string[]; leaders: Map<string, string[]> }) {
    return [...new Set([...(await this.leadersOf(ownerId, ctx)), ...ctx.managers])].filter((id) => id !== ownerId);
  }

  private async staleLeads(now: Date, r: LeadRules, ctx: { managers: string[]; leaders: Map<string, string[]> }) {
    const cutoff = new Date(now.getTime() - r.nudgeAfterHours * 3_600_000);
    const leads = await this.prisma.lead.findMany({
      where: { assignedUserId: { not: null }, status: { notIn: CLOSED_STATUSES }, assignments: { some: { endedAt: null, assignedAt: { lte: cutoff } } } },
      select: {
        id: true, fullName: true, assignedUserId: true, nudgedAt: true, escalatedAt: true, lastContactedAt: true,
        assignedUser: { select: { fullName: true } },
        assignments: { where: { endedAt: null }, orderBy: { assignedAt: 'desc' }, take: 1, select: { assignedAt: true } },
      },
      take: 2000,
    });
    if (!leads.length) return { nudged: 0, escalated: 0 };
    const ids = leads.map((l) => l.id);
    // Only the owner's own work counts: a manager reassigning or changing status doesn't.
    const [notes, calls, statuses, done] = await Promise.all([
      this.prisma.leadNote.groupBy({ by: ['leadId', 'authorId'], where: { leadId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.callLog.groupBy({ by: ['leadId', 'userId'], where: { leadId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.leadStatusHistory.groupBy({ by: ['leadId', 'actorId'], where: { leadId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.followUp.groupBy({ by: ['leadId', 'ownerId'], where: { leadId: { in: ids }, status: 'COMPLETED' }, _max: { completedAt: true } }),
    ]);
    const key = (leadId: string, userId: string | null) => `${leadId}|${userId}`;
    const noteAt = new Map(notes.map((x) => [key(x.leadId, x.authorId), x._max.createdAt]));
    const callAt = new Map(calls.map((x) => [key(x.leadId, x.userId), x._max.createdAt]));
    const statusAt = new Map(statuses.map((x) => [key(x.leadId, x.actorId), x._max.createdAt]));
    const doneAt = new Map(done.map((x) => [key(x.leadId, x.ownerId), x._max.completedAt]));

    let nudged = 0, escalated = 0;
    for (const l of leads) {
      const owner = l.assignedUserId!;
      const k = key(l.id, owner);
      const last = latest(l.assignments[0]?.assignedAt, l.lastContactedAt, noteAt.get(k), callAt.get(k), statusAt.get(k), doneAt.get(k));
      if (!last) continue;
      const action = staleAction(last, l.nudgedAt, l.escalatedAt, now, r);
      if (!action) continue;
      const idle = idleLabel(last, now);
      const link = `/leads/${l.id}`;
      const notYet = { OR: [{ [action === 'escalate' ? 'escalatedAt' : 'nudgedAt']: null }, { [action === 'escalate' ? 'escalatedAt' : 'nudgedAt']: { lt: last } }] };
      const claimed = await this.prisma.lead.updateMany({
        where: { id: l.id, ...notYet } as Prisma.LeadWhereInput,
        data: action === 'escalate' ? { escalatedAt: now, nudgedAt: now } : { nudgedAt: now },
      });
      if (claimed.count !== 1) continue; // another run got there first
      if (action === 'nudge') {
        await this.notifications.notify(owner, { type: 'lead.stale', title: `No action on ${l.fullName} for ${idle}`, body: 'Call them, add a note or update the status.', link });
        nudged++;
      } else {
        await this.notifications.notify(owner, { type: 'lead.stale', title: `Still no action on ${l.fullName} (${idle})`, body: 'Your team leader and managers have been told.', link });
        await this.notifications.notifyMany(await this.bosses(owner, ctx), {
          type: 'lead.escalated', title: `${l.assignedUser?.fullName ?? 'Someone'} hasn't worked ${l.fullName} for ${idle}`, body: 'Assigned lead with no calls, notes or updates.', link,
        });
        escalated++;
      }
    }
    return { nudged, escalated };
  }

  private async lateFollowUps(now: Date, r: LeadRules, ctx: { managers: string[]; leaders: Map<string, string[]> }) {
    const late = await this.prisma.followUp.findMany({
      where: { status: 'PENDING', escalatedAt: null, dueAt: { lt: new Date(now.getTime() - r.followUpEscalateHours * 3_600_000) }, lead: { status: { notIn: CLOSED_STATUSES } } },
      select: { id: true, ownerId: true, dueAt: true, owner: { select: { fullName: true } }, lead: { select: { id: true, fullName: true } } },
      take: 500,
    });
    let escalated = 0;
    for (const f of late) {
      const claimed = await this.prisma.followUp.updateMany({ where: { id: f.id, escalatedAt: null }, data: { escalatedAt: now } });
      if (claimed.count !== 1) continue;
      await this.notifications.notifyMany(await this.bosses(f.ownerId, ctx), {
        type: 'followup.escalated', title: `${f.owner.fullName}'s follow-up with ${f.lead.fullName} is ${idleLabel(f.dueAt, now)} overdue`, link: `/leads/${f.lead.id}`,
      });
      escalated++;
    }
    return { escalated };
  }
}

@ApiTags('Lead alerts')
@ApiBearerAuth()
@Controller('lead-rules')
export class LeadRulesController {
  constructor(private rules: LeadRulesService) {}
  @Get() @RequireAny('integrations.manage', 'leads.assign.all') get() { return this.rules.get(); }
  @Put() @RequireAny('integrations.manage') save(@CurrentUser() u: AuthUser, @Body() dto: LeadRulesDto) { return this.rules.save(u, dto); }
}

@Module({ providers: [LeadRulesService, LeadAlerts], controllers: [LeadRulesController], exports: [LeadRulesService, LeadAlerts] })
export class AlertsModule {}
