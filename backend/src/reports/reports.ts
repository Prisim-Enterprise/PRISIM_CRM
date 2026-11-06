import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { addDays, localDateKey, localDayRange, parseLocalDate, startOfLocalDay } from '../common/time';
import { CONNECTED_OUTCOMES } from '../leads/lead-status';

class ReportQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsString() campaign?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @Matches(/^\d{1,3}$/) limit?: string;
}

const CLOSED = ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'] as const;

/**
 * Metric definitions (documented so numbers reconcile with records):
 * - Leads in period: leads created (CRM createdAt) within the date range.
 * - Converted / Lost: leads whose status changed to CONVERTED / LOST within the range.
 * - Conversion rate: of the leads created in the range, the share now CONVERTED (cohort rate).
 * - Connected call: outcome is a two-way conversation (connected, interested, callback,
 *   not interested, converted) or a provider call that completed with talk time > 0.
 * - Overdue follow-up: pending and due time is in the past (right now).
 * - All "today" values use the business timezone (APP_TIMEZONE).
 */
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private access: AccessService) {}

  private async scopeUserIds(user: AuthUser, q: ReportQuery): Promise<{ ids: string[] | null; scope: string }> {
    const scope = this.access.scope(user, 'reports.view');
    let ids = await this.access.userIdsInScope(user, 'reports.view');
    if (q.teamId) {
      const members = (await this.prisma.user.findMany({ where: { teamId: q.teamId }, select: { id: true } })).map((m) => m.id);
      ids = ids === null ? members : ids.filter((id) => members.includes(id));
    }
    if (q.userId) ids = ids === null || ids.includes(q.userId) ? [q.userId] : [];
    return { ids, scope };
  }

  private range(q: ReportQuery) {
    const today = startOfLocalDay();
    const from = q.from ? parseLocalDate(q.from) : addDays(today, -29);
    const to = q.to ? addDays(parseLocalDate(q.to), 1) : addDays(today, 1);
    return { from, to };
  }

  async dashboard(user: AuthUser, q: ReportQuery) {
    const { ids, scope } = await this.scopeUserIds(user, q);
    const { from, to } = this.range(q);
    const now = new Date();
    const today = localDayRange(now);

    const leadScope: Prisma.LeadWhereInput = {
      ...(ids === null ? {} : { assignedUserId: { in: ids } }),
      ...(q.campaign ? { campaignName: q.campaign } : {}),
      ...(q.source ? { source: { key: q.source } } : {}),
    };
    const inRange = { gte: from, lt: to };
    const userScope = ids === null ? {} : { in: ids };
    const callWhere: Prisma.CallLogWhereInput = { createdAt: inRange, ...(ids === null ? {} : { userId: userScope }), ...(q.campaign || q.source ? { lead: leadScope } : {}) };
    const fuScope: Prisma.FollowUpWhereInput = ids === null ? {} : { ownerId: userScope };
    const taskScope: Prisma.TaskWhereInput = ids === null ? {} : { assigneeId: userScope };

    const connectedWhere: Prisma.CallLogWhereInput = {
      ...callWhere,
      OR: [{ outcome: { in: CONNECTED_OUTCOMES } }, { outcome: null, provider: { not: 'manual' }, status: 'COMPLETED', durationSeconds: { gt: 0 } }],
    };

    const [
      leadsTotal, newToday, assigned, unassigned, convertedInRange, lostInRange, cohortConverted,
      callsMade, connectedCalls, talk, followUpsToday, overdueFollowUps, followUpsCompleted,
      pendingTasks, overdueTasks, openFeedback,
    ] = await Promise.all([
      this.prisma.lead.count({ where: { ...leadScope, createdAt: inRange } }),
      this.prisma.lead.count({ where: { ...leadScope, createdAt: { gte: today.start, lt: today.end } } }),
      this.prisma.lead.count({ where: { ...leadScope, assignedUserId: ids === null ? { not: null } : userScope, status: { notIn: [...CLOSED] } } }),
      scope === 'all' && !q.userId && !q.teamId
        ? this.prisma.lead.count({ where: { ...leadScope, assignedUserId: null, status: { notIn: [...CLOSED] } } })
        : Promise.resolve(null),
      this.prisma.leadStatusHistory.count({ where: { toStatus: 'CONVERTED', createdAt: inRange, lead: leadScope } }),
      this.prisma.leadStatusHistory.count({ where: { toStatus: 'LOST', createdAt: inRange, lead: leadScope } }),
      this.prisma.lead.count({ where: { ...leadScope, createdAt: inRange, status: 'CONVERTED' } }),
      this.prisma.callLog.count({ where: callWhere }),
      this.prisma.callLog.count({ where: connectedWhere }),
      this.prisma.callLog.aggregate({ where: callWhere, _sum: { durationSeconds: true } }),
      this.prisma.followUp.count({ where: { ...fuScope, status: 'PENDING', dueAt: { gte: today.start, lt: today.end } } }),
      this.prisma.followUp.count({ where: { ...fuScope, status: 'PENDING', dueAt: { lt: now } } }),
      this.prisma.followUp.count({ where: { ...fuScope, status: 'COMPLETED', completedAt: inRange } }),
      this.prisma.task.count({ where: { ...taskScope, status: { not: 'DONE' } } }),
      this.prisma.task.count({ where: { ...taskScope, status: { not: 'DONE' }, dueAt: { lt: now } } }),
      user.permissions.has('feedback.view.all')
        ? this.prisma.feedback.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'] } } })
        : Promise.resolve(null),
    ]);

    // Charts
    const [leadDates, callRows, statusGroups, campaignGroups, campaignConverted, outcomeGroups, sourceGroups, sourceToday, sourceConverted, sources] = await Promise.all([
      this.prisma.lead.findMany({ where: { ...leadScope, createdAt: inRange }, select: { createdAt: true } }),
      this.prisma.callLog.findMany({ where: callWhere, select: { createdAt: true, outcome: true, status: true, durationSeconds: true, provider: true } }),
      this.prisma.lead.groupBy({ by: ['status'], where: { ...leadScope, createdAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['campaignName'], where: { ...leadScope, createdAt: inRange }, _count: true, orderBy: { _count: { campaignName: 'desc' } }, take: 12 }),
      this.prisma.lead.groupBy({ by: ['campaignName'], where: { ...leadScope, createdAt: inRange, status: 'CONVERTED' }, _count: true }),
      this.prisma.callLog.groupBy({ by: ['outcome'], where: callWhere, _count: true }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...leadScope, createdAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...leadScope, createdAt: { gte: today.start, lt: today.end } }, _count: true }),
      this.prisma.lead.groupBy({ by: ['sourceId'], where: { ...leadScope, createdAt: inRange, status: 'CONVERTED' }, _count: true }),
      this.prisma.leadSource.findMany({ select: { id: true, key: true, name: true } }),
    ]);

    const days: string[] = [];
    for (let d = from; d < to; d = addDays(d, 1)) days.push(localDateKey(d));
    const byDay = new Map(days.map((d) => [d, { date: d, leads: 0, calls: 0, connected: 0 }]));
    for (const l of leadDates) { const k = byDay.get(localDateKey(l.createdAt)); if (k) k.leads++; }
    for (const c of callRows) {
      const k = byDay.get(localDateKey(c.createdAt));
      if (!k) continue;
      k.calls++;
      if ((c.outcome && CONNECTED_OUTCOMES.includes(c.outcome)) || (!c.outcome && c.provider !== 'manual' && c.status === 'COMPLETED' && (c.durationSeconds ?? 0) > 0)) k.connected++;
    }

    return {
      range: { from: localDateKey(from), to: localDateKey(addDays(to, -1)) },
      scope,
      metrics: {
        leadsTotal, newToday, assigned, unassigned,
        converted: convertedInRange, lost: lostInRange,
        conversionRate: leadsTotal ? cohortConverted / leadsTotal : 0,
        callsMade, connectedCalls, talkTimeSeconds: talk._sum.durationSeconds ?? 0,
        followUpsToday, overdueFollowUps, followUpsCompleted,
        pendingTasks, overdueTasks, openFeedback,
      },
      charts: {
        daily: [...byDay.values()],
        leadsByStatus: statusGroups.map((g) => ({ status: g.status, count: g._count })),
        campaigns: campaignGroups.map((g) => ({
          campaign: g.campaignName ?? '(none)', leads: g._count,
          converted: campaignConverted.find((c) => c.campaignName === g.campaignName)?._count ?? 0,
        })),
        callOutcomes: outcomeGroups.map((g) => ({ outcome: g.outcome ?? 'NOT_RECORDED', count: g._count })),
        leadsBySource: sourceGroups
          .map((g) => {
            const src = sources.find((x) => x.id === g.sourceId);
            return {
              key: src?.key ?? 'unknown', name: src?.name ?? 'Unknown', leads: g._count,
              today: sourceToday.find((t) => t.sourceId === g.sourceId)?._count ?? 0,
              converted: sourceConverted.find((t) => t.sourceId === g.sourceId)?._count ?? 0,
            };
          })
          .sort((a, b) => b.leads - a.leads),
      },
    };
  }

  /**
   * Recent activity across the CRM: lead updates, notes, calls, follow-ups, tasks,
   * feedback and client work. Admins see everyone; others see their scope (own/team).
   */
  async activity(user: AuthUser, q: ReportQuery) {
    const { ids } = await this.scopeUserIds(user, q);
    const take = Math.min(Math.max(Number(q.limit) || 40, 1), 200);
    const by = (field: string) => (ids === null ? {} : { [field]: { in: ids } });
    const actor = { select: { id: true, fullName: true } } as const;
    const lead = { select: { id: true, fullName: true } } as const;
    const label = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/_/g, ' ');

    const [statuses, notes, calls, followUps, assignments, taskActs, feedback, clientUpdates] = await Promise.all([
      this.prisma.leadStatusHistory.findMany({ where: { actorId: ids === null ? { not: null } : { in: ids } }, include: { actor, lead }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.leadNote.findMany({ where: by('authorId'), include: { author: actor, lead }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.callLog.findMany({ where: by('userId'), include: { user: actor, lead }, orderBy: { createdAt: 'desc' }, take }),
      this.prisma.followUp.findMany({ where: by('ownerId'), include: { owner: actor, createdBy: actor, lead }, orderBy: { updatedAt: 'desc' }, take }),
      this.prisma.leadAssignment.findMany({ where: { assignedById: ids === null ? { not: null } : { in: ids } }, include: { assignedBy: actor, user: actor, lead }, orderBy: { assignedAt: 'desc' }, take }),
      this.prisma.taskActivity.findMany({ where: { actorId: ids === null ? { not: null } : { in: ids } }, include: { actor, task: { select: { id: true, number: true, title: true } } }, orderBy: { createdAt: 'desc' }, take }),
      // Anonymous feedback is never attributed, and only admins who can see all feedback get it.
      user.permissions.has('feedback.view.all')
        ? this.prisma.feedback.findMany({ include: { submittedBy: actor }, orderBy: { createdAt: 'desc' }, take })
        : Promise.resolve([]),
      this.prisma.clientWorkUpdate.findMany({
        where: user.permissions.has('clients.view.all') || user.permissions.has('clients.manage') ? by('authorId') : { authorId: user.id },
        include: { author: actor, work: { select: { id: true, title: true, client: { select: { id: true, name: true } } } } },
        orderBy: { createdAt: 'desc' }, take,
      }),
    ]);

    type Item = { id: string; at: Date; kind: string; actor: { id: string; fullName: string } | null; text: string; detail?: string | null; link: string };
    const items: Item[] = [
      ...statuses.map((h) => ({
        id: `st-${h.id}`, at: h.createdAt, kind: 'lead', actor: h.actor,
        text: `moved ${h.lead.fullName} ${h.fromStatus ? `from ${label(h.fromStatus)} ` : ''}to ${label(h.toStatus)}`, detail: h.reason, link: `/leads/${h.lead.id}`,
      })),
      ...notes.map((n) => ({ id: `nt-${n.id}`, at: n.createdAt, kind: 'note', actor: n.author, text: `added a note on ${n.lead.fullName}`, detail: n.body.slice(0, 160), link: `/leads/${n.lead.id}` })),
      ...calls.map((c) => ({
        id: `cl-${c.id}`, at: c.createdAt, kind: 'call', actor: c.user,
        text: `called ${c.lead.fullName}${c.outcome ? ` (${label(c.outcome)})` : c.status !== 'COMPLETED' ? ` (${label(c.status)})` : ''}${c.durationSeconds ? `, ${Math.floor(c.durationSeconds / 60)}m ${c.durationSeconds % 60}s` : ''}`,
        detail: c.notes, link: `/leads/${c.lead.id}`,
      })),
      ...followUps.map((f) => f.status === 'COMPLETED'
        ? { id: `fu-${f.id}`, at: f.completedAt ?? f.updatedAt, kind: 'followup', actor: f.owner, text: `completed a ${f.type} follow-up with ${f.lead.fullName}`, detail: f.outcome, link: `/leads/${f.lead.id}` }
        : f.status === 'CANCELLED'
          ? { id: `fu-${f.id}`, at: f.updatedAt, kind: 'followup', actor: f.owner, text: `cancelled a follow-up with ${f.lead.fullName}`, detail: f.cancelReason, link: `/leads/${f.lead.id}` }
          : { id: `fu-${f.id}`, at: f.createdAt, kind: 'followup', actor: f.createdBy, text: `scheduled a ${f.type} follow-up with ${f.lead.fullName}${f.createdBy.id !== f.owner.id ? ` for ${f.owner.fullName}` : ''}`, detail: f.note, link: `/leads/${f.lead.id}` }),
      ...assignments.map((a) => ({ id: `as-${a.id}`, at: a.assignedAt, kind: 'lead', actor: a.assignedBy, text: `assigned ${a.lead.fullName} to ${a.user.fullName}`, detail: a.reason, link: `/leads/${a.lead.id}` })),
      ...taskActs.map((t) => {
        const d = (t.detail ?? {}) as Record<string, unknown>;
        const what = t.action === 'status_changed' ? `moved PRS-${t.task.number} to ${label(String(d.to))}`
          : t.action === 'created' ? `created task PRS-${t.task.number}`
            : t.action === 'review_approved' ? `approved PRS-${t.task.number}`
              : t.action === 'review_rejected' ? `requested changes on PRS-${t.task.number}`
                : t.action === 'attachment_added' ? `attached a file to PRS-${t.task.number}`
                  : `updated PRS-${t.task.number}`;
        return { id: `ta-${t.id}`, at: t.createdAt, kind: 'task', actor: t.actor, text: what, detail: t.task.title, link: `/tasks?open=${t.task.id}` };
      }),
      ...feedback.map((f) => ({
        id: `fb-${f.id}`, at: f.createdAt, kind: 'feedback', actor: f.isAnonymous ? null : f.submittedBy,
        text: `${f.isAnonymous ? 'Anonymous ' : ''}submitted ${f.kind === 'QUERY' ? 'a query' : 'feedback'}: ${f.subject}`, detail: f.category, link: `/feedback/${f.id}`,
      })),
      ...clientUpdates.map((u) => ({
        id: `cw-${u.id}`, at: u.createdAt, kind: 'client', actor: u.author,
        text: `${u.toStatus ? `marked "${u.work.title}" ${label(u.toStatus)}` : `updated "${u.work.title}"`} for ${u.work.client.name}`,
        detail: u.body, link: `/clients/${u.work.client.id}?work=${u.work.id}`,
      })),
    ];
    return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
  }

  /** Per-employee activity. Shown alongside lead volume so comparisons stay fair. */
  async employees(user: AuthUser, q: ReportQuery) {
    const { ids } = await this.scopeUserIds(user, q);
    const { from, to } = this.range(q);
    const now = new Date();
    const inRange = { gte: from, lt: to };
    const users = await this.prisma.user.findMany({
      where: { isActive: true, ...(ids === null ? {} : { id: { in: ids } }) },
      select: { id: true, fullName: true, team: { select: { name: true } } },
      orderBy: { fullName: 'asc' },
    });
    const uids = users.map((u) => u.id);
    const [assignedInRange, openLeads, calls, connected, talk, fuDone, fuMissed, converted, tasksDone, tasksOverdue] = await Promise.all([
      this.prisma.leadAssignment.groupBy({ by: ['userId'], where: { userId: { in: uids }, assignedAt: inRange }, _count: true }),
      this.prisma.lead.groupBy({ by: ['assignedUserId'], where: { assignedUserId: { in: uids }, status: { notIn: [...CLOSED] } }, _count: true }),
      this.prisma.callLog.groupBy({ by: ['userId'], where: { userId: { in: uids }, createdAt: inRange }, _count: true }),
      this.prisma.callLog.groupBy({ by: ['userId'], where: { userId: { in: uids }, createdAt: inRange, outcome: { in: CONNECTED_OUTCOMES } }, _count: true }),
      this.prisma.callLog.groupBy({ by: ['userId'], where: { userId: { in: uids }, createdAt: inRange }, _sum: { durationSeconds: true } }),
      this.prisma.followUp.groupBy({ by: ['ownerId'], where: { ownerId: { in: uids }, status: 'COMPLETED', completedAt: inRange }, _count: true }),
      this.prisma.followUp.groupBy({ by: ['ownerId'], where: { ownerId: { in: uids }, status: 'PENDING', dueAt: { lt: now } }, _count: true }),
      this.prisma.leadStatusHistory.groupBy({ by: ['actorId'], where: { actorId: { in: uids }, toStatus: 'CONVERTED', createdAt: inRange }, _count: true }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: { assigneeId: { in: uids }, status: 'DONE', completedAt: inRange }, _count: true }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: { assigneeId: { in: uids }, status: { not: 'DONE' }, dueAt: { lt: now } }, _count: true }),
    ]);
    const pick = <T extends { _count: number }>(arr: T[], key: keyof T, id: string) => arr.find((r) => r[key] === id)?._count ?? 0;
    return users.map((u) => {
      const callsMade = pick(calls, 'userId', u.id);
      const leadsAssigned = pick(assignedInRange, 'userId', u.id);
      const conv = pick(converted, 'actorId', u.id);
      return {
        userId: u.id, name: u.fullName, team: u.team?.name ?? null,
        leadsAssigned, openLeads: pick(openLeads, 'assignedUserId', u.id),
        callsMade, connectedCalls: pick(connected, 'userId', u.id),
        talkTimeSeconds: talk.find((t) => t.userId === u.id)?._sum.durationSeconds ?? 0,
        followUpsCompleted: pick(fuDone, 'ownerId', u.id), missedFollowUps: pick(fuMissed, 'ownerId', u.id),
        converted: conv, conversionPerAssigned: leadsAssigned ? conv / leadsAssigned : null,
        tasksCompleted: pick(tasksDone, 'assigneeId', u.id), overdueTasks: pick(tasksOverdue, 'assigneeId', u.id),
      };
    });
  }
}

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('dashboard') dashboard(@CurrentUser() u: AuthUser, @Query() q: ReportQuery) { return this.reports.dashboard(u, q); }
  @Get('activity') activity(@CurrentUser() u: AuthUser, @Query() q: ReportQuery) { return this.reports.activity(u, q); }
  @Get('employees') employees(@CurrentUser() u: AuthUser, @Query() q: ReportQuery) { return this.reports.employees(u, q); }
}

@Module({ providers: [ReportsService], controllers: [ReportsController] })
export class ReportsModule {}
