import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
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
import { ClientsModule } from './clients/clients';

@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    JwtModule.registerAsync({
      global: true,
      useFactory: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
        return { secret, signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as never } };
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CommonModule,
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
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
