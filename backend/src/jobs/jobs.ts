import { Controller, ForbiddenException, Headers, HttpCode, Module, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/current-user';
import { FollowUpReminders, FollowUpsModule } from '../follow-ups/follow-ups';
import { IntegrationsModule, LeadSyncService } from '../integrations/integrations';
import { TaskReminders, TasksModule } from '../tasks/tasks';

/** On a long-running server @Cron does this work. Vercel functions sleep, so this endpoint is called instead. */
@Controller('internal')
export class JobsController {
  constructor(private followUps: FollowUpReminders, private tasks: TaskReminders, private sync: LeadSyncService) {}

  @Public()
  @SkipThrottle()
  @Post('tick')
  @HttpCode(200)
  async tick(@Headers('x-cron-secret') secret?: string) {
    const a = Buffer.from(String(secret ?? ''));
    const b = Buffer.from(process.env.CRON_SECRET ?? '');
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException();
    const now = new Date();
    const jobs = [this.followUps.run(), this.sync.scheduled()];
    if (now.getUTCMinutes() % 10 === 0) jobs.push(this.tasks.overdue());
    if (now.getUTCHours() === 21 && now.getUTCMinutes() === 0) jobs.push(this.sync.reconcile()); // 02:30 IST
    await Promise.all(jobs);
    return { ok: true };
  }
}

@Module({ imports: [FollowUpsModule, TasksModule, IntegrationsModule], controllers: [JobsController] })
export class JobsModule {}
