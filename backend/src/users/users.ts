import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { PERMISSIONS } from '../common/permissions';
import { normalizePhone } from '../common/phone';
import { authIdByEmail, createSignIn, removeSignIn, sendInvitation, setPassword } from '../common/supabase-auth';
import { CLOSED_STATUSES } from '../leads/lead-status';

class CreateUserDto {
  @IsString() @MinLength(2) fullName: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsUUID() teamId?: string | null;
  @IsArray() @IsString({ each: true }) roleKeys: string[];
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsUUID() teamId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) roleKeys?: string[];
  @IsOptional() @IsString() timezone?: string;
}

class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(72) password: string;
}

class UserPermissionsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) grants: string[];
  @IsArray() @ArrayUnique() @IsString({ each: true }) denies: string[];
}

class TeamDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() leaderId?: string | null;
}

class UpdateTeamDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  /** Leave out to keep the current leader; null removes the leader. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() leaderId?: string | null;
}

class RoleDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
}

class RolePermissionsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}

const userSelect = {
  id: true, fullName: true, email: true, phone: true, isActive: true, timezone: true, lastLoginAt: true, createdAt: true,
  teamId: true, team: { select: { id: true, name: true } },
  roles: { select: { role: { select: { key: true, name: true } } } },
  _count: { select: { permissionOverrides: true } },
} satisfies Prisma.UserSelect;

/** Also loads role permissions, to check the actor outranks the account they act on. */
const targetSelect = {
  ...userSelect,
  roles: { select: { role: { select: { key: true, name: true, permissions: { select: { permission: { select: { key: true } } } } } } } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  private log = new Logger('Users');
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async rolesFor(keys: string[], actor: AuthUser) {
    const roles = await this.prisma.role.findMany({
      where: { key: { in: keys } },
      include: { permissions: { select: { permission: { select: { key: true } } } } },
    });
    if (roles.length !== new Set(keys).size) throw new BadRequestException('Unknown role');
    // Only users who can manage roles may grant Super Admin.
    if (roles.some((r) => r.key === 'super_admin') && !actor.permissions.has('roles.manage')) {
      throw new ForbiddenException('Only a Super Admin can grant the Super Admin role');
    }
    // Nobody can hand out a permission they don't have themselves, or they could escalate through a custom role.
    const beyond = roles.filter((r) => r.permissions.some((p) => !actor.permissions.has(p.permission.key)));
    if (beyond.length) {
      throw new ForbiddenException(`You can't assign ${beyond.map((r) => r.name).join(', ')}: it includes permissions you don't have`);
    }
    return roles;
  }

  /** A person may only act on accounts whose roles carry no permission they lack themselves. */
  private assertOutranks(target: { roles: { role: { key: string; permissions?: { permission: { key: string } }[] } }[] }, actor: AuthUser, what: string) {
    if (target.roles.some((r) => r.role.key === 'super_admin') && !actor.permissions.has('roles.manage')) {
      throw new ForbiddenException(`Only a Super Admin can ${what} a Super Admin account`);
    }
    if (target.roles.some((r) => r.role.permissions?.some((p) => !actor.permissions.has(p.permission.key)))) {
      throw new ForbiddenException(`You can't ${what} this account: their role has permissions you don't have`);
    }
  }

  /** Blocks any change that would leave the CRM without an active Super Admin. */
  private async assertNotLastSuperAdmin(id: string) {
    const others = await this.prisma.user.count({
      where: { id: { not: id }, isActive: true, deletedAt: null, roles: { some: { role: { key: 'super_admin' } } } },
    });
    if (!others) throw new BadRequestException('This is the last active Super Admin. Make someone else a Super Admin first.');
  }

  private async assertTeamExists(teamId: string | null | undefined) {
    if (teamId && !(await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }))) {
      throw new BadRequestException('Team not found');
    }
  }

  async create(dto: CreateUserDto, actor: AuthUser) {
    const email = dto.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('A user with this email already exists');
    const roles = await this.rolesFor(dto.roleKeys, actor);
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) throw new BadRequestException('Phone number is not valid');
    await this.assertTeamExists(dto.teamId);
    const user = await this.prisma.user.create({
      data: {
        fullName: dto.fullName.trim(), email, phone, teamId: dto.teamId ?? null,
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: userSelect,
    });
    await this.audit.record({ actorId: actor.id, action: 'user.created', entityType: 'user', entityId: user.id, after: { email, roles: dto.roleKeys } });
    return { ...user, inviteSent: await this.invite(email) };
  }

  /** The user exists even if the email fails, so a failed invite is reported, not thrown. */
  private async invite(email: string) {
    try {
      await sendInvitation(email);
      return true;
    } catch (e) {
      this.log.error(`Invitation email failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Loads a user an admin may act on. Only a Super Admin may act on a Super Admin. */
  private async target(id: string, actor: AuthUser, what = 'change') {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { ...targetSelect, authUserId: true } });
    if (!target) throw new NotFoundException('User not found');
    this.assertOutranks(target, actor, what);
    return target;
  }

  async resetPassword(id: string, password: string, actor: AuthUser) {
    const target = await this.target(id, actor);
    // Works before they have accepted an invitation, so nobody depends on email reaching them.
    const authId = target.authUserId ?? (await authIdByEmail(target.email));
    const problem = authId ? await setPassword(authId, password) : await createSignIn(target.email, password);
    if (problem) throw new BadRequestException(problem);
    await this.audit.record({ actorId: actor.id, action: 'user.password_reset', entityType: 'user', entityId: id });
    return { ok: true };
  }

  /**
   * Removes a person from the CRM. The row stays so past calls and leads keep their name;
   * they vanish from lists, lose all access, and their open work is released.
   */
  async remove(id: string, actor: AuthUser) {
    if (id === actor.id) throw new BadRequestException('You cannot delete your own account');
    const target = await this.target(id, actor, 'delete');
    if (target.email === 'system@prisim.internal') throw new BadRequestException('This account cannot be deleted');
    if (target.isActive && target.roles.some((r) => r.role.key === 'super_admin')) await this.assertNotLastSuperAdmin(id);
    const reason = `${target.fullName} was removed from the CRM`;
    const released = await this.prisma.$transaction(async (tx) => {
      const leads = await tx.lead.findMany({ where: { assignedUserId: id, status: { notIn: CLOSED_STATUSES } }, select: { id: true, status: true } });
      const leadIds = leads.map((l) => l.id);
      await tx.lead.updateMany({ where: { id: { in: leadIds } }, data: { assignedUserId: null, status: 'UNASSIGNED' } });
      await tx.leadStatusHistory.createMany({ data: leads.map((l) => ({ leadId: l.id, fromStatus: l.status, toStatus: 'UNASSIGNED' as const, actorId: actor.id, reason })) });
      await tx.leadAssignment.updateMany({ where: { userId: id, endedAt: null }, data: { endedAt: new Date() } });
      const followUps = await tx.followUp.updateMany({ where: { ownerId: id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: reason } });
      const tasks = await tx.task.updateMany({ where: { assigneeId: id, status: { not: 'DONE' } }, data: { assigneeId: null } });
      await tx.clientWorkAssignee.deleteMany({ where: { userId: id } });
      await tx.feedback.updateMany({ where: { assignedAdminId: id, status: { notIn: ['RESOLVED', 'CLOSED'] } }, data: { assignedAdminId: null } });
      await tx.team.updateMany({ where: { leaderId: id }, data: { leaderId: null } });
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userPermission.deleteMany({ where: { userId: id } });
      await tx.user.update({
        where: { id },
        // Frees the email so the same person can be added again later.
        data: { deletedAt: new Date(), isActive: false, email: `deleted-${id}@prisim.internal`, phone: null, teamId: null, authUserId: null },
      });
      return { leads: leads.length, followUps: followUps.count, tasks: tasks.count };
    });
    let signInRemoved = true;
    try {
      await removeSignIn(target.authUserId, target.email);
    } catch (e) {
      signInRemoved = false; // The CRM already refuses this account, so this only leaves an unused login.
      this.log.error(`Could not remove the sign-in account: ${(e as Error).message}`);
    }
    await this.audit.record({ actorId: actor.id, action: 'user.deleted', entityType: 'user', entityId: id, before: { fullName: target.fullName, email: target.email }, after: released });
    return { ok: true, released, signInRemoved };
  }

  async resendInvite(id: string, actor: AuthUser) {
    const target = await this.target(id, actor);
    if (!(await this.invite(target.email))) throw new BadRequestException('The email could not be sent. Use Reset password to set their password instead.');
    await this.audit.record({ actorId: actor.id, action: 'user.invited', entityType: 'user', entityId: id });
    return { ok: true };
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: targetSelect });
    if (!target) throw new NotFoundException('User not found');
    this.assertOutranks(target, actor, 'edit');
    if (id === actor.id && dto.isActive === false) throw new BadRequestException('You cannot deactivate your own account');
    // Deactivating or demoting a Super Admin must leave at least one active Super Admin.
    const isSuper = target.isActive && target.roles.some((r) => r.role.key === 'super_admin');
    const losesSuper = dto.isActive === false || (dto.roleKeys !== undefined && !dto.roleKeys.includes('super_admin'));
    if (isSuper && losesSuper) await this.assertNotLastSuperAdmin(id);
    await this.assertTeamExists(dto.teamId);
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: userSelect });
    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.email !== undefined) {
      data.email = dto.email.toLowerCase().trim();
      // The old sign-in must lose access; the new email links on its first sign-in.
      if (data.email !== before.email) data.authUserId = null;
    }
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.teamId !== undefined) data.team = dto.teamId ? { connect: { id: dto.teamId } } : { disconnect: true };
    if (dto.phone !== undefined) {
      const phone = dto.phone ? normalizePhone(dto.phone) : null;
      if (dto.phone && !phone) throw new BadRequestException('Phone number is not valid');
      data.phone = phone;
    }
    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.roleKeys) {
        const roles = await this.rolesFor(dto.roleKeys, actor);
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      return tx.user.update({ where: { id }, data, select: userSelect });
    });
    await this.audit.record({ actorId: actor.id, action: 'user.updated', entityType: 'user', entityId: id, before, after: user });
    return user;
  }
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private users: UsersService, private audit: AuditService) {}

  /** Lightweight directory used by pickers (assign lead, assign task). Available to everyone. */
  @Get('directory')
  directory() {
    return this.prisma.user.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, fullName: true, teamId: true, roles: { select: { role: { select: { key: true } } } } },
      orderBy: { fullName: 'asc' },
    });
  }

  @Get()
  @RequireAny('users.view', 'users.manage')
  list(@Query('search') search?: string, @Query('teamId') teamId?: string) {
    return this.prisma.user.findMany({
      where: {
        email: { not: 'system@prisim.internal' },
        deletedAt: null,
        ...(teamId ? { teamId } : {}),
        ...(search ? { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      select: userSelect,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
    });
  }

  @Post()
  @RequireAny('users.manage')
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.create(dto, actor);
  }

  @Patch(':id')
  @RequireAny('users.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.update(id, dto, actor);
  }

  /** A user's permissions broken down: from roles, per-user grants/denies, and the effective result. */
  @Get(':id/permissions')
  @RequireAny('roles.manage', 'users.manage')
  async getPermissions(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, fullName: true, email: true,
        roles: { select: { role: { select: { key: true, name: true, permissions: { select: { permission: { select: { key: true } } } } } } } },
        permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const fromRoles = [...new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)))].sort();
    const grants = user.permissionOverrides.filter((o) => o.effect === 'GRANT').map((o) => o.permission.key).sort();
    const denies = user.permissionOverrides.filter((o) => o.effect === 'DENY').map((o) => o.permission.key).sort();
    const effective = [...new Set([...fromRoles, ...grants])].filter((k) => !denies.includes(k)).sort();
    return {
      user: { id: user.id, fullName: user.fullName, email: user.email },
      roles: user.roles.map((r) => ({ key: r.role.key, name: r.role.name })),
      fromRoles, grants, denies, effective,
    };
  }

  @Put(':id/permissions')
  @RequireAny('roles.manage')
  async setPermissions(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UserPermissionsDto, @CurrentUser() actor: AuthUser) {
    if (id === actor.id) throw new BadRequestException("You can't change your own permissions. Ask another Super Admin.");
    if (dto.grants.some((g) => dto.denies.includes(g))) throw new BadRequestException('A permission cannot be both allowed and denied');
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } } } });
    if (!user) throw new NotFoundException('User not found');
    const keys = [...dto.grants, ...dto.denies];
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    if (perms.length !== keys.length) throw new BadRequestException('Unknown permission');
    const idOf = new Map(perms.map((p) => [p.key, p.id]));
    await this.prisma.$transaction([
      this.prisma.userPermission.deleteMany({ where: { userId: id } }),
      this.prisma.userPermission.createMany({
        data: [
          ...dto.grants.map((k) => ({ userId: id, permissionId: idOf.get(k)!, effect: 'GRANT' as const })),
          ...dto.denies.map((k) => ({ userId: id, permissionId: idOf.get(k)!, effect: 'DENY' as const })),
        ],
      }),
    ]);
    const before = {
      grants: user.permissionOverrides.filter((o) => o.effect === 'GRANT').map((o) => o.permission.key),
      denies: user.permissionOverrides.filter((o) => o.effect === 'DENY').map((o) => o.permission.key),
    };
    await this.audit.record({ actorId: actor.id, action: 'user.permissions_changed', entityType: 'user', entityId: id, before, after: dto });
    return this.getPermissions(id);
  }

  @Post(':id/reset-password')
  @RequireAny('users.manage')
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto, @CurrentUser() actor: AuthUser) {
    return this.users.resetPassword(id, dto.password, actor);
  }

  @Delete(':id')
  @RequireAny('users.manage')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.remove(id, actor);
  }

  @Post(':id/invite')
  @RequireAny('users.manage')
  invite(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.resendInvite(id, actor);
  }
}

@ApiTags('Teams')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async assertLeader(leaderId: string | null | undefined) {
    if (!leaderId) return;
    const leader = await this.prisma.user.findFirst({ where: { id: leaderId, isActive: true, deletedAt: null }, select: { id: true } });
    if (!leader) throw new BadRequestException('The team leader must be an active user');
  }

  private async existing(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  @Get()
  list() {
    return this.prisma.team.findMany({
      include: { leader: { select: { id: true, fullName: true } }, _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  @RequireAny('teams.manage')
  async create(@Body() dto: TeamDto, @CurrentUser() actor: AuthUser) {
    await this.assertLeader(dto.leaderId);
    const team = await this.prisma.team.create({ data: { name: dto.name.trim(), leaderId: dto.leaderId ?? null } });
    await this.audit.record({ actorId: actor.id, action: 'team.created', entityType: 'team', entityId: team.id, after: team });
    return team;
  }

  @Patch(':id')
  @RequireAny('teams.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeamDto, @CurrentUser() actor: AuthUser) {
    const before = await this.existing(id);
    await this.assertLeader(dto.leaderId);
    const team = await this.prisma.team.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.leaderId !== undefined ? { leaderId: dto.leaderId } : {}),
      },
    });
    await this.audit.record({ actorId: actor.id, action: 'team.updated', entityType: 'team', entityId: id, before, after: team });
    return team;
  }

  @Delete(':id')
  @RequireAny('teams.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    await this.existing(id);
    await this.prisma.$transaction([
      this.prisma.user.updateMany({ where: { teamId: id }, data: { teamId: null } }),
      this.prisma.task.updateMany({ where: { teamId: id }, data: { teamId: null } }),
      this.prisma.team.delete({ where: { id } }),
    ]);
    await this.audit.record({ actorId: actor.id, action: 'team.deleted', entityType: 'team', entityId: id });
    return { ok: true };
  }
}

@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get()
  async list() {
    const roles = await this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem,
      userCount: r._count.users, permissions: r.permissions.map((p) => p.permission.key),
    }));
  }

  @Get('permissions')
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, [group, description]]) => ({ key, group, description }));
  }

  @Post()
  @RequireAny('roles.manage')
  async create(@Body() dto: RoleDto, @CurrentUser() actor: AuthUser) {
    const key = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) throw new BadRequestException('The role name needs at least one letter or number');
    if (await this.prisma.role.findUnique({ where: { key } })) throw new ConflictException('A role with this name exists');
    const role = await this.prisma.role.create({ data: { key, name: dto.name, description: dto.description } });
    await this.audit.record({ actorId: actor.id, action: 'role.created', entityType: 'role', entityId: role.id, after: role });
    return role;
  }

  @Put(':id/permissions')
  @RequireAny('roles.manage')
  async setPermissions(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RolePermissionsDto, @CurrentUser() actor: AuthUser) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.key === 'super_admin') throw new BadRequestException('Super Admin always has every permission');
    const perms = await this.prisma.permission.findMany({ where: { key: { in: dto.permissions } } });
    if (perms.length !== dto.permissions.length) throw new BadRequestException('Unknown permission');
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })) }),
    ]);
    await this.audit.record({
      actorId: actor.id, action: 'role.permissions_changed', entityType: 'role', entityId: id,
      before: role.permissions.map((p) => p.permission.key), after: dto.permissions,
    });
    return { ok: true };
  }

  @Delete(':id')
  @RequireAny('roles.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new BadRequestException('Built-in roles cannot be deleted');
    if (role._count.users) throw new BadRequestException('Remove this role from all users first');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record({ actorId: actor.id, action: 'role.deleted', entityType: 'role', entityId: id, before: role });
    return { ok: true };
  }
}

@Module({ providers: [UsersService], controllers: [UsersController, TeamsController, RolesController] })
export class UsersModule {}
