import { BadRequestException, Controller, Get, Injectable, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { APP_TZ, localDateKey, parseLocalDate } from '../common/time';

class MonthQuery {
  @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must look like 2026-11' }) month?: string;
}

interface PersonRow {
  userId: string; name: string; teams: string[];
  tasksAssigned: number; tasksCompleted: number; onTime: number; late: number; overdueOpen: number; avgDaysToComplete: number | null;
  callsMade: number; followUpsCompleted: number; leadsConverted: number; clientWorkDone: number; seoUpdates: number; mediaDone: number;
}
interface TaskRow {
  taskId: string; key: string; title: string; priority: string; people: string[]; teams: string[];
  createdAt: Date; dueAt: Date | null; completedAt: Date; onTime: boolean;
}

const NUMERIC = ['tasksAssigned', 'tasksCompleted', 'onTime', 'late', 'overdueOpen', 'callsMade', 'followUpsCompleted', 'leadsConverted', 'clientWorkDone', 'seoUpdates', 'mediaDone'] as const;
type Counts = Record<(typeof NUMERIC)[number], number>;
const NO_TEAM = 'No team';

/** The month as YYYY-MM in the business timezone. */
const monthKey = (d = new Date()) => localDateKey(d).slice(0, 7);
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

@Injectable()
export class MonthlyReportService {
  constructor(private prisma: PrismaService, private access: AccessService) {}

  async build(user: AuthUser, month = monthKey()) {
    const from = parseLocalDate(`${month}-01`);
    const to = parseLocalDate(`${nextMonth(month)}-01`);
    if (from > new Date()) throw new BadRequestException('That month has not started yet');
    const inMonth = { gte: from, lt: to };
    const scope = this.access.scope(user, 'reports.view');
    const ids = await this.access.userIdsInScope(user, 'reports.view');
    const only = ids === null ? {} : { in: ids };

    const people = await this.prisma.user.findMany({
      where: { deletedAt: null, email: { not: 'system@prisim.internal' }, ...(ids === null ? {} : { id: only }) },
      select: {
        id: true, fullName: true, isActive: true, team: { select: { name: true } },
        teamMemberships: { select: { team: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { fullName: 'asc' },
    });
    const uids = people.map((p) => p.id);
    // Everyone counts in each team they belong to.
    const teamsOf = new Map(people.map((p) => [p.id, p.teamMemberships.length ? p.teamMemberships.map((m) => m.team.name) : p.team ? [p.team.name] : []]));

    const [done, assigned, overdue, calls, followUps, converted, clientWork, seo, media] = await Promise.all([
      // Finished this month. A shared task counts for each person on it.
      this.prisma.task.findMany({
        where: { status: 'DONE', completedAt: inMonth, assignees: { some: { userId: { in: uids } } } },
        select: { id: true, number: true, title: true, priority: true, createdAt: true, dueAt: true, completedAt: true, assignees: { select: { userId: true, user: { select: { fullName: true } } }, orderBy: { createdAt: 'asc' } } },
        orderBy: { completedAt: 'asc' },
      }),
      this.prisma.taskAssignee.groupBy({ by: ['userId'], where: { userId: { in: uids }, task: { createdAt: inMonth } }, _count: true }),
      // Due by the end of the month and not finished by then.
      this.prisma.taskAssignee.groupBy({
        by: ['userId'],
        where: { userId: { in: uids }, task: { createdAt: { lt: to }, dueAt: { lt: to }, OR: [{ completedAt: null }, { completedAt: { gte: to } }] } },
        _count: true,
      }),
      this.prisma.callLog.groupBy({ by: ['userId'], where: { userId: { in: uids }, createdAt: inMonth }, _count: true }),
      this.prisma.followUp.groupBy({ by: ['ownerId'], where: { ownerId: { in: uids }, status: 'COMPLETED', completedAt: inMonth }, _count: true }),
      this.prisma.leadStatusHistory.groupBy({ by: ['actorId'], where: { actorId: { in: uids }, toStatus: 'CONVERTED', createdAt: inMonth }, _count: true }),
      this.prisma.clientWork.findMany({ where: { status: 'DONE', completedAt: inMonth }, select: { assignees: { select: { userId: true } } } }),
      this.prisma.seoUpdate.groupBy({ by: ['authorId'], where: { authorId: { in: uids }, workDate: inMonth }, _count: true }),
      this.prisma.mediaItem.groupBy({ by: ['assigneeId'], where: { assigneeId: { in: uids }, status: 'DONE', scheduledAt: inMonth }, _count: true }),
    ]);

    const count = <T extends { _count: number }>(rows: T[], key: keyof T, id: string) => rows.find((r) => r[key] === id)?._count ?? 0;
    const onTime = (t: { dueAt: Date | null; completedAt: Date | null }) => !t.dueAt || t.completedAt! <= t.dueAt;

    const rows: PersonRow[] = people.map((p) => {
      const mine = done.filter((t) => t.assignees.some((a) => a.userId === p.id));
      const days = mine.map((t) => (t.completedAt!.getTime() - t.createdAt.getTime()) / 86_400_000);
      return {
        userId: p.id, name: p.fullName, teams: teamsOf.get(p.id) ?? [],
        tasksAssigned: count(assigned, 'userId', p.id),
        tasksCompleted: mine.length,
        onTime: mine.filter(onTime).length,
        late: mine.filter((t) => !onTime(t)).length,
        overdueOpen: count(overdue, 'userId', p.id),
        avgDaysToComplete: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
        callsMade: count(calls, 'userId', p.id),
        followUpsCompleted: count(followUps, 'ownerId', p.id),
        leadsConverted: count(converted, 'actorId', p.id),
        clientWorkDone: clientWork.filter((w) => w.assignees.some((a) => a.userId === p.id)).length,
        seoUpdates: count(seo, 'authorId', p.id),
        mediaDone: count(media, 'assigneeId', p.id),
      };
    })
      // Leave out inactive people with nothing to show for the month.
      .filter((r, i) => people[i].isActive || NUMERIC.some((k) => r[k] > 0));

    const sum = (list: PersonRow[]) => Object.fromEntries(NUMERIC.map((k) => [k, list.reduce((a, r) => a + r[k], 0)])) as Counts;
    const all = sum(rows);
    const teamNames = [...new Set(rows.flatMap((r) => (r.teams.length ? r.teams : [NO_TEAM])))].sort((a, b) => (a === NO_TEAM ? 1 : b === NO_TEAM ? -1 : a.localeCompare(b)));
    const teams = teamNames.map((name) => {
      const members = rows.filter((r) => (r.teams.length ? r.teams.includes(name) : name === NO_TEAM));
      // A shared task finished by two people in the same team counts once for the team.
      const teamTasks = done.filter((t) => t.assignees.some((a) => members.some((m) => m.userId === a.userId)));
      return {
        name, members: members.map((m) => m.name), ...sum(members),
        tasksCompleted: teamTasks.length, onTime: teamTasks.filter(onTime).length, late: teamTasks.filter((t) => !onTime(t)).length,
      };
    });

    const tasks: TaskRow[] = done.map((t) => ({
      taskId: t.id, key: `PRS-${t.number}`, title: t.title, priority: t.priority,
      people: t.assignees.filter((a) => uids.includes(a.userId)).map((a) => a.user.fullName),
      teams: [...new Set(t.assignees.flatMap((a) => teamsOf.get(a.userId) ?? []))],
      createdAt: t.createdAt, dueAt: t.dueAt, completedAt: t.completedAt!, onTime: onTime(t),
    }));
    const totalDone = tasks.length;
    const summary = {
      tasksAssigned: await this.prisma.task.count({ where: { createdAt: inMonth, ...(ids === null ? {} : { assignees: { some: { userId: only } } }) } }),
      tasksCompleted: totalDone,
      onTime: tasks.filter((t) => t.onTime).length,
      late: tasks.filter((t) => !t.onTime).length,
      onTimeRate: totalDone ? tasks.filter((t) => t.onTime).length / totalDone : null,
      callsMade: all.callsMade, followUpsCompleted: all.followUpsCompleted, leadsConverted: all.leadsConverted,
      clientWorkDone: all.clientWorkDone, seoUpdates: all.seoUpdates, mediaDone: all.mediaDone,
      people: rows.length,
    };
    const final = to <= new Date();
    return { month, from, to, timezone: APP_TZ, scope, final, generatedAt: new Date(), summary, people: rows, teams, tasks };
  }

  async csv(user: AuthUser, month?: string) {
    const r = await this.build(user, month);
    const q = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Quote everything, and stop spreadsheet formulas in names or titles.
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const line = (...cells: unknown[]) => cells.map(q).join(',');
    const date = (d: Date | null) => (d ? localDateKey(d) : '');
    const monthName = new Date(`${r.month}-15T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const cols = ['Tasks assigned', 'Tasks completed', 'On time', 'Late', 'Overdue at month end', 'Calls made', 'Follow-ups done', 'Leads converted', 'Client work done', 'SEO updates', 'Media done'];
    const vals = (x: Record<string, unknown>) => ['tasksAssigned', 'tasksCompleted', 'onTime', 'late', 'overdueOpen', 'callsMade', 'followUpsCompleted', 'leadsConverted', 'clientWorkDone', 'seoUpdates', 'mediaDone'].map((k) => x[k] ?? '');
    const out = [
      line(`Prisim CRM monthly report: ${monthName}`),
      line(r.final ? 'Final (the month has ended)' : `In progress (month not finished), generated ${r.generatedAt.toISOString()}`),
      '',
      line('Summary'),
      line('Tasks assigned', 'Tasks completed', 'On time', 'Late', 'On-time rate', 'Calls made', 'Follow-ups done', 'Leads converted', 'Client work done', 'SEO updates', 'Media done'),
      line(r.summary.tasksAssigned, r.summary.tasksCompleted, r.summary.onTime, r.summary.late, r.summary.onTimeRate === null ? '' : `${Math.round(r.summary.onTimeRate * 100)}%`,
        r.summary.callsMade, r.summary.followUpsCompleted, r.summary.leadsConverted, r.summary.clientWorkDone, r.summary.seoUpdates, r.summary.mediaDone),
      '',
      line('By team'),
      line('Team', 'Members', ...cols),
      ...r.teams.map((t) => line(t.name, t.members.join('; '), ...vals(t as unknown as Record<string, unknown>))),
      '',
      line('By person'),
      line('Name', 'Teams', ...cols, 'Avg days to complete'),
      ...r.people.map((p) => line(p.name, p.teams.join('; ') || NO_TEAM, ...vals(p as unknown as Record<string, unknown>), p.avgDaysToComplete ?? '')),
      '',
      line('Tasks completed'),
      line('Task', 'Title', 'Done by', 'Teams', 'Priority', 'Created', 'Due', 'Completed', 'On time'),
      ...r.tasks.map((t) => line(t.key, t.title, t.people.join('; '), t.teams.join('; '), t.priority, date(t.createdAt), date(t.dueAt), date(t.completedAt), t.onTime ? 'Yes' : 'Late')),
    ];
    return { name: `prisim-monthly-report-${r.month}.csv`, body: '﻿' + out.join('\r\n') + '\r\n' };
  }
}

@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports/monthly')
// Organisation-wide: Super Admin and Admin only.
@RequireAny('reports.view.all')
export class MonthlyReportController {
  constructor(private svc: MonthlyReportService) {}

  @Get() get(@CurrentUser() u: AuthUser, @Query() q: MonthQuery) { return this.svc.build(u, q.month); }

  @Get('download')
  async download(@CurrentUser() u: AuthUser, @Query() q: MonthQuery, @Res() res: Response) {
    const { name, body } = await this.svc.csv(u, q.month);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  }
}
