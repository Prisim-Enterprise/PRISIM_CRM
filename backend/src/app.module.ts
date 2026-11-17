import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { JOBS_KEY, tickHealth } from './jobs/heartbeat';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { CommonModule } from './common/common.module';
import { AuthGuard } from './common/auth.guard';
import { Public } from './common/current-user';
import { NotificationsModule } from './notifications/notifications';
import { UsersModule } from './users/users';
import { LeadsModule } from './leads/leads.controller';
import { FollowUpsModule } from './follow-ups/follow-ups';
import { CallsModule } from './calls/calls';
import { TasksModule } from './tasks/tasks';
import { FeedbackModule } from './feedback/feedback';
import { ReportsModule } from './reports/reports';
import { IntegrationsModule } from './integrations/integrations';
import { JobsModule } from './jobs/jobs';
import { ClientsModule } from './clients/clients';
import { MediaModule } from './media/media';
import { SeoModule } from './seo/seo';
import { MessagesModule } from './messages/messages';
import { PostingModule } from './clients/posting';
import { QuotationsModule } from './quotations/quotations';
import { AccountingModule } from './accounting/accounting';
import { AuthModule } from './auth/auth';

@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    const now = new Date();
    if (!process.env.VERCEL) return { status: 'ok', time: now.toISOString() };
    // On Vercel, reminders and syncs only run when the external scheduler calls /internal/tick.
    // Report a stalled scheduler as 503 so an uptime monitor raises the alarm.
    const row = await this.prisma.integrationConfig.findUnique({ where: { key: JOBS_KEY }, select: { state: true } });
    const jobs = tickHealth((row?.state as { lastTickAt?: string } | null)?.lastTickAt, now);
    if (jobs !== 'ok') throw new ServiceUnavailableException({ status: 'degraded', jobs, time: now.toISOString() });
    return { status: 'ok', jobs, time: now.toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    // Vercel functions sleep between requests, so /internal/tick runs these jobs there instead.
    ...(process.env.VERCEL ? [] : [ScheduleModule.forRoot()]),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    NotificationsModule,
    UsersModule,
    LeadsModule,
    FollowUpsModule,
    CallsModule,
    TasksModule,
    FeedbackModule,
    ReportsModule,
    IntegrationsModule,
    ClientsModule,
    MediaModule,
    SeoModule,
    MessagesModule,
    PostingModule,
    QuotationsModule,
    AccountingModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
