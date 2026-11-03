import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user';

export type Scope = 'all' | 'team' | 'own';

/**
 * Resolves data scopes (all / team / own) from permissions. Every list query and
 * every write on a protected record goes through here. Hiding a button in the UI
 * is never treated as a security control.
 */
@Injectable()
export class AccessService {
  constructor(private prisma: PrismaService) {}

  scope(user: AuthUser, area: string): Scope {
    if (user.permissions.has(`${area}.all`)) return 'all';
    if (user.permissions.has(`${area}.team`)) return 'team';
    return 'own';
  }

  /** User ids in the teams this user leads/belongs to (includes self). */
  async teamMemberIds(user: AuthUser): Promise<string[]> {
    if (!user.teamIds.length) return [user.id];
    const members = await this.prisma.user.findMany({
      where: { teamId: { in: user.teamIds } },
      select: { id: true },
    });
    return [...new Set([user.id, ...members.map((m) => m.id)])];
  }

  /** Returns null for unrestricted, otherwise the list of user ids in scope. */
  async userIdsInScope(user: AuthUser, area: string): Promise<string[] | null> {
    const s = this.scope(user, area);
    if (s === 'all') return null;
    if (s === 'team') return this.teamMemberIds(user);
    return [user.id];
  }

  async canActOnOwner(user: AuthUser, area: string, ownerId: string | null): Promise<boolean> {
    const ids = await this.userIdsInScope(user, area);
    if (ids === null) return true;
    return ownerId !== null && ids.includes(ownerId);
  }

  async assertCanActOnOwner(user: AuthUser, area: string, ownerId: string | null, msg = 'You do not have access to this record') {
    if (!(await this.canActOnOwner(user, area, ownerId))) throw new ForbiddenException(msg);
  }
}
