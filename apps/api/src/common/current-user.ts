import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from './permissions';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  teamId: string | null;
  roleKeys: string[];
  permissions: Set<string>;
  /** Teams this user leads or belongs to (used for "team" scope). */
  teamIds: string[];
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMS = 'requiredPerms';
/** Requires ANY of the given permissions. */
export const RequireAny = (...perms: PermissionKey[]) => SetMetadata(REQUIRED_PERMS, perms);
