import { Controller, ForbiddenException, Headers, HttpCode, Injectable, Logger, Module, OnModuleInit, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Public } from '../common/current-user';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpReminders, FollowUpsModule } from '../follow-ups/follow-ups';
import { IntegrationsModule, LeadSyncService } from '../integrations/integrations';
import { TaskReminders, TasksModule } from '../tasks/tasks';
import { MessagesModule, MessagesService } from '../messages/messages';
import { PostingModule, PostingService } from '../clients/posting';
import { PostingSheetService } from '../clients/posting-sheet';
import { NotificationsService } from '../notifications/notifications';
import { AlertsModule, LeadAlerts } from '../alerts/alerts';
import { JOBS_KEY, jobsDue, QUICK_JOBS_EVERY_MS, QUICK_JOBS_KEY } from './heartbeat';

/**
 * Reminders and lead/task alerts: quick database checks. They run on every tick, and also when
 * someone checks their alerts, at most once a minute across everyone, so they keep working even
 * if the external scheduler stops. (Sheet syncs and other slow jobs stay on the scheduler.)
 */
@Injectable()
export class QuickJobs implements OnModuleInit {
  private log = new Logger('QuickJobs');
  constructor(private prisma: PrismaService, private notifications: NotificationsService, private followUps: FollowUpReminders, private tasks: TaskReminders, private leadAlerts: LeadAlerts) {}

  onModuleInit() { this.notifications.onPoll(() => this.runIfDue()); }

  /** Claims the next run with one conditional update, so two people checking at once can't both run it. */
  async runIfDue() {
    await this.prisma.integrationConfig.upsert({ where: { key: QUICK_JOBS_KEY }, create: { key: QUICK_JOBS_KEY, enabled: true }, update: {} });
    const claimed = await this.prisma.$executeRaw`
      UPDATE "integration_configs" SET "state" = jsonb_build_object('lastRunAt', to_jsonb(now())), "updatedAt" = now()
      WHERE "key" = ${QUICK_JOBS_KEY}
        AND ("state"->>'lastRunAt' IS NULL OR ("state"->>'lastRunAt')::timestamptz < now() - make_interval(secs => ${QUICK_JOBS_EVERY_MS / 1000}))`;
    if (claimed !== 1) return false;
    await this.run();
    return true;
  }

  async run() {
    const jobs = [this.followUps.run(), this.leadAlerts.run(), this.tasks.overdue()];
    const results = await Promise.allSettled(jobs);
    results.forEach((r) => { if (r.status === 'rejected') this.log.error(String((r.reason as Error)?.message ?? r.reason)); });
  }
}

/** On a long-running server @Cron does this work. Vercel functions sleep, so this endpoint is called instead. */
@Controller('internal')
export class JobsController {
  private log = new Logger('Jobs');
  constructor(
    private prisma: PrismaService, private followUps: FollowUpReminders, private tasks: TaskReminders, private sync: LeadSyncService,
    private messages: MessagesService, private posting: PostingService, private postingSheet: PostingSheetService, private leadAlerts: LeadAlerts,
  ) {}

  @Public()
  @SkipThrottle()
  @Post('tick')
  @HttpCode(200)
  async tick(@Headers('x-cron-secret') secret?: string) {
    const a = Buffer.from(String(secret ?? ''));
    const b = Buffer.from(process.env.CRON_SECRET ?? '');
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException();
    const now = new Date();
    const run: Record<string, () => Promise<unknown>> = {
      followUps: () => this.followUps.run(),
      leadAlerts: () => this.leadAlerts.run(),
      leadSync: () => this.sync.scheduled(),
      overdueTasks: () => this.tasks.overdue(),
      purgeMessages: () => this.messages.purge(),
      postingCalendar: () => this.postingSheet.sync().then(() => this.posting.remind()),
      reconcile: () => this.sync.reconcile(),
    };
    const names = jobsDue(now);
    // allSettled: one failing job must not hide the others or stop the heartbeat.
    const results = await Promise.allSettled(names.map((n) => run[n]()));
    const failed = names.filter((_, i) => results[i].status === 'rejected');
    results.forEach((r, i) => { if (r.status === 'rejected') this.log.error(`${names[i]} failed: ${(r.reason as Error)?.message ?? r.reason}`); });
    const state = { lastTickAt: now.toISOString(), failed, ...(failed.length ? { lastFailureAt: now.toISOString() } : {}) } as Prisma.InputJsonValue;
    await this.prisma.integrationConfig.upsert({ where: { key: JOBS_KEY }, create: { key: JOBS_KEY, enabled: true, state }, update: { state } })
      .catch((e: Error) => this.log.error(`heartbeat not saved: ${e.message}`));
    return { ok: failed.length === 0, ran: names, failed };
  }
}

@Module({ imports: [FollowUpsModule, TasksModule, IntegrationsModule, MessagesModule, PostingModule, AlertsModule], controllers: [JobsController], providers: [QuickJobs] })
export class JobsModule {}
