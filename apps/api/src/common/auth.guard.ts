import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, IS_PUBLIC, REQUIRED_PERMS } from './current-user';
import { verifiedPrimaryEmail, verifyClerkToken } from './clerk';

/** The web app shows a "no access" screen for this message. */
export const NO_ACCESS = 'This account has not been added to Prisim CRM. Ask your administrator.';

/** Global guard: verifies the Clerk session token, loads the user's live roles/permissions, enforces @RequireAny. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Not signed in');

    let clerkUserId: string;
    try {
      clerkUserId = await verifyClerkToken(token);
    } catch {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    req.user = await this.loadUser(await this.crmUserId(clerkUserId));

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMS, targets);
    if (required?.length && !required.some((p) => (req.user as AuthUser).permissions.has(p))) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
  }

  /**
   * Finds the CRM user for a Clerk account. The first sign-in links them by verified email.
   * A Clerk account alone gives no access: someone must have added this person to the CRM.
   */
  private async crmUserId(clerkUserId: string): Promise<string> {
    const linked = await this.prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (linked) return linked.id;
    const email = await verifiedPrimaryEmail(clerkUserId);
    const user = email ? await this.prisma.user.findUnique({ where: { email }, select: { id: true, clerkUserId: true } }) : null;
    if (!user || (user.clerkUserId && user.clerkUserId !== clerkUserId)) throw new ForbiddenException(NO_ACCESS);
    await this.prisma.user.update({ where: { id: user.id }, data: { clerkUserId } });
    return user.id;
  }

  async loadUser(id: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        ledTeams: { select: { id: true } },
        permissionOverrides: { include: { permission: { select: { key: true } } } },
      },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Account is inactive');
    // Effective permissions = role permissions + per-user grants - per-user denies.
    const permissions = new Set<string>();
    for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
    for (const o of user.permissionOverrides) if (o.effect === 'GRANT') permissions.add(o.permission.key);
    for (const o of user.permissionOverrides) if (o.effect === 'DENY') permissions.delete(o.permission.key);
    const teamIds = new Set(user.ledTeams.map((t) => t.id));
    if (user.teamId) teamIds.add(user.teamId);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      teamId: user.teamId,
      roleKeys: user.roles.map((r) => r.role.key),
      permissions,
      teamIds: [...teamIds],
    };
  }
}
