import { BadRequestException, Body, Controller, Get, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';

class UpdateMeDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

/** Clerk doesn't tell the CRM when a session starts, so a sign-in is recorded at most this often. */
const LOGIN_GAP_MS = 60 * 60_000;

/** The signed-in person's own profile. Sign-in and passwords themselves are handled by Clerk. */
@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const { lastLoginAt, ...profile } = await this.prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: {
        id: true, fullName: true, email: true, phone: true, timezone: true, teamId: true, lastLoginAt: true,
        team: { select: { id: true, name: true } },
      },
    });
    if (!lastLoginAt || Date.now() - lastLoginAt.getTime() > LOGIN_GAP_MS) {
      await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
      await this.audit.record({ actorId: u.id, action: 'auth.login', entityType: 'user', entityId: u.id });
    }
    return { ...profile, roles: [...u.roleKeys].sort(), permissions: [...u.permissions].sort(), teamIds: u.teamIds };
  }

  @Patch('me')
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateMeDto) {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) throw new BadRequestException('Phone number is not valid');
    await this.prisma.user.update({
      where: { id: u.id },
      data: { ...(dto.phone !== undefined ? { phone } : {}), ...(dto.timezone ? { timezone: dto.timezone } : {}) },
    });
    return { ok: true };
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
