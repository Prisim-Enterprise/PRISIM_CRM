import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, IS_PUBLIC, REQUIRED_PERMS } from './current-user';

/** Global guard: verifies the JWT, loads the user's live roles/permissions, enforces @RequireAny. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Not signed in');

    let payload: { sub: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    if (payload.typ && payload.typ !== 'access') throw new UnauthorizedException('Invalid token');
    req.user = await this.loadUser(payload.sub);

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMS, targets);
    if (required?.length && !required.some((p) => (req.user as AuthUser).permissions.has(p))) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
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
