import { Controller, Get, Global, Injectable, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser } from '../common/current-user';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async notify(userId: string | null | undefined, n: { type: string; title: string; body?: string; link?: string }) {
    if (!userId) return;
    await this.prisma.notification.create({ data: { userId, ...n } });
  }

  async notifyMany(userIds: string[], n: { type: string; title: string; body?: string; link?: string }) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    await this.prisma.notification.createMany({ data: ids.map((userId) => ({ userId, ...n })) });
  }

  /** All active users holding a given permission (e.g. who gets new-feedback alerts). */
  async usersWithPermission(key: string): Promise<string[]> {
    // Same rule as the auth guard: via a role or a per-user grant, and not denied for that user.
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { roles: { some: { role: { permissions: { some: { permission: { key } } } } } } },
          { permissionOverrides: { some: { effect: 'GRANT', permission: { key } } } },
        ],
        NOT: { permissionOverrides: { some: { effect: 'DENY', permission: { key } } } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) {
    const where = { userId: user.id, ...(unread === 'true' ? { readAt: null } : {}) };
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { items, unreadCount };
  }

  @Post(':id/read')
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
    return { ok: true };
  }

  @Post('read-all')
  async readAll(@CurrentUser() user: AuthUser) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
}

@Global()
@Module({ providers: [NotificationsService], controllers: [NotificationsController], exports: [NotificationsService] })
export class NotificationsModule {}
