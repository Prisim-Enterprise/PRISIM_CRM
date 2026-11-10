import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, IS_PUBLIC, REQUIRED_PERMS } from './current-user';
import { verifiedEmail, verifyAuthToken } from './supabase-auth';
import { DEFAULT_ROLES, PERMISSIONS } from './permissions';

/** The web app shows a "no access" screen for this message. */
export const NO_ACCESS = 'This account has not been added to Prisim CRM. Ask your administrator.';

/** Global guard: verifies the Supabase access token, loads the user's live roles/permissions, enforces @RequireAny. */
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

    let authUserId: string;
    try {
      authUserId = await verifyAuthToken(token);
    } catch {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    req.user = await this.loadUser(await this.crmUserId(authUserId));

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMS, targets);
    if (required?.length && !required.some((p) => (req.user as AuthUser).permissions.has(p))) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
  }

  /**
   * Finds the CRM user for a sign-in account. The first sign-in links them by verified email.
   * A sign-in account alone gives no access: someone must have added this person to the CRM.
   */
  private async crmUserId(authUserId: string): Promise<string> {
    const seedAdminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || null;
    const linked = await this.prisma.user.findUnique({ where: { authUserId }, select: { id: true, email: true } });
    if (linked) {
      // Recovery only: if no active Super Admin is left, the seed admin gets the role back.
      if (linked.email === seedAdminEmail && !(await this.hasActiveSuperAdmin())) {
        return this.bootstrapSuperAdmin(authUserId, linked.email);
      }
      return linked.id;
    }
    const email = await verifiedEmail(authUserId);
    const user = email ? await this.prisma.user.findUnique({ where: { email }, select: { id: true, authUserId: true } }) : null;
    // First install (or recovery): provision the seed admin only while there is no active Super Admin.
    // Otherwise they are treated like anyone else, so a demotion or removal sticks.
    if (email && email === seedAdminEmail && !(await this.hasActiveSuperAdmin())) {
      return this.bootstrapSuperAdmin(authUserId, email);
    }
    if (!user || (user.authUserId && user.authUserId !== authUserId)) throw new ForbiddenException(NO_ACCESS);
    await this.prisma.user.update({ where: { id: user.id }, data: { authUserId } });
    return user.id;
  }

  private async hasActiveSuperAdmin() {
    const count = await this.prisma.user.count({
      where: { isActive: true, deletedAt: null, roles: { some: { role: { key: 'super_admin' } } } },
    });
    return count > 0;
  }

  private async bootstrapSuperAdmin(authUserId: string, email: string): Promise<string> {
    const roleDefaults = DEFAULT_ROLES.find((role) => role.key === 'super_admin');
    if (!roleDefaults) throw new Error('Super Admin role defaults are missing');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true, authUserId: true } });
      if (existing?.authUserId && existing.authUserId !== authUserId) throw new ForbiddenException(NO_ACCESS);

      for (const [key, [group, description]] of Object.entries(PERMISSIONS)) {
        await tx.permission.upsert({
          where: { key },
          update: { group, description },
          create: { key, group, description },
        });
      }
      const permissions = await tx.permission.findMany({ where: { key: { in: roleDefaults.permissions } }, select: { id: true } });
      const role = await tx.role.upsert({
        where: { key: roleDefaults.key },
        update: { name: roleDefaults.name, description: roleDefaults.description, isSystem: true },
        create: { key: roleDefaults.key, name: roleDefaults.name, description: roleDefaults.description, isSystem: true },
      });
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
        skipDuplicates: true,
      });

      if (existing) {
        // Recovery also reactivates the account, otherwise the restored role would be useless.
        await tx.user.update({ where: { id: existing.id }, data: { authUserId, isActive: true } });
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: existing.id, roleId: role.id } },
          update: {},
          create: { userId: existing.id, roleId: role.id },
        });
        return existing.id;
      }

      const created = await tx.user.create({
        data: {
          email,
          fullName: process.env.SEED_ADMIN_NAME?.trim() || 'Super Admin',
          authUserId,
          roles: { create: { roleId: role.id } },
        },
        select: { id: true },
      });
      return created.id;
    });
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
