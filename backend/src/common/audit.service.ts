import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  private log = new Logger('Audit');
  constructor(private prisma: PrismaService) {}

  async record(params: {
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: params.actorId ?? null,
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: params.ip,
        },
      });
    } catch (e) {
      // Never fail a business operation because the audit write failed, but make it visible.
      this.log.error(`Failed to write audit log for ${params.action}: ${(e as Error).message}`);
    }
  }
}
