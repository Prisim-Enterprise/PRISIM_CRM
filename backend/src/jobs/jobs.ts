import { Controller, ForbiddenException, Headers, HttpCode, Logger, Module, Post } from '@nestjs/common';
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
import { JOBS_KEY, jobsDue } from './heartbeat';

/** On a long-running server @Cron does this work. Vercel functions sleep, so this endpoint is called instead. */
@Controller('internal')
export class JobsController {
  private log = new Logger('Jobs');
  constructor(
    private prisma: PrismaService, private followUps: FollowUpReminders, private tasks: TaskReminders, private sync: LeadSyncService,
    private messages: MessagesService, private posting: PostingService, private postingSheet: PostingSheetService,
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

@Module({ imports: [FollowUpsModule, TasksModule, IntegrationsModule, MessagesModule, PostingModule], controllers: [JobsController] })
export class JobsModule {}
