import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, NO_ACCESS } from './auth.guard';
import { IS_PUBLIC, REQUIRED_PERMS } from './current-user';
import { PrismaService } from '../prisma/prisma.service';
import { verifiedEmail, verifyAuthToken } from './supabase-auth';

jest.mock('./supabase-auth', () => ({ verifyAuthToken: jest.fn(), verifiedEmail: jest.fn() }));
const verify = verifyAuthToken as jest.Mock;
const email = verifiedEmail as jest.Mock;

const perm = (key: string) => ({ permission: { key } });
const dbUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1', fullName: 'Asha', email: 'asha@x.com', teamId: 't1', isActive: true,
  roles: [{ role: { key: 'employee', permissions: [perm('leads.view.all'), perm('calls.view.team')] } }],
  ledTeams: [{ id: 't2' }], teamMemberships: [{ teamId: 't1' }, { teamId: 't3' }],
  permissionOverrides: [{ effect: 'GRANT', permission: { key: 'accounting.expenses.submit' } }, { effect: 'DENY', permission: { key: 'leads.view.all' } }],
  ...over,
});

function setup(meta: Record<string, unknown> = {}, prismaOver: Record<string, unknown> = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => (where.authUserId === 'auth-1' ? { id: 'u1', email: 'asha@x.com' } : where.id === 'u1' ? dbUser() : null)),
      count: jest.fn().mockResolvedValue(1),
      update: jest.fn(),
    },
    ...prismaOver,
  } as unknown as PrismaService;
  const reflector = { getAllAndOverride: jest.fn((key: string) => meta[key]) } as unknown as Reflector;
  const guard = new AuthGuard(reflector, prisma);
  const req: Record<string, unknown> = { headers: { authorization: 'Bearer tok' } };
  const ctx = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { guard, prisma, req, ctx };
}

beforeEach(() => {
  verify.mockReset().mockResolvedValue('auth-1');
  email.mockReset();
  delete process.env.SEED_ADMIN_EMAIL;
});

describe('AuthGuard', () => {
  it('lets @Public routes through without a token', async () => {
    const { guard, ctx, req } = setup({ [IS_PUBLIC]: true });
    req.headers = {};
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('401 without a bearer token', async () => {
    const { guard, ctx, req } = setup();
    req.headers = { authorization: 'Basic abc' };
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('401 when the token does not verify', async () => {
    verify.mockRejectedValue(new Error('bad'));
    const { guard, ctx } = setup();
    await expect(guard.canActivate(ctx)).rejects.toThrow('Session expired');
  });

  it('computes permissions as role + grants − denies, and collects every team', async () => {
    const { guard, ctx, req } = setup();
    await guard.canActivate(ctx);
    const u = req.user as { permissions: Set<string>; teamIds: string[]; roleKeys: string[] };
    expect([...u.permissions].sort()).toEqual(['accounting.expenses.submit', 'calls.view.team']);
    expect(u.teamIds.sort()).toEqual(['t1', 't2', 't3']);
    expect(u.roleKeys).toEqual(['employee']);
  });

  it('a DENY override wins even when a GRANT for the same key exists', async () => {
    const { guard } = setup();
    const prisma = (guard as unknown as { prisma: PrismaService }).prisma;
    (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(dbUser({
      permissionOverrides: [{ effect: 'DENY', permission: { key: 'calls.view.team' } }, { effect: 'GRANT', permission: { key: 'calls.view.team' } }],
    }));
    const u = await guard.loadUser('u1');
    expect(u.permissions.has('calls.view.team')).toBe(false);
  });

  it('enforces @RequireAny: 403 without any of the listed permissions', async () => {
    const { guard, ctx } = setup({ [REQUIRED_PERMS]: ['accounting.manage'] });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('@RequireAny passes with one of the listed permissions', async () => {
    const { guard, ctx } = setup({ [REQUIRED_PERMS]: ['accounting.manage', 'accounting.expenses.submit'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('401 for a deactivated account', async () => {
    const { guard, ctx, prisma } = setup();
    (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, string> }) =>
      where.authUserId ? { id: 'u1', email: 'asha@x.com' } : dbUser({ isActive: false }));
    await expect(guard.canActivate(ctx)).rejects.toThrow('Account is inactive');
  });

  it('a sign-in account that was never added to the CRM gets no access', async () => {
    verify.mockResolvedValue('auth-unknown');
    email.mockResolvedValue('stranger@x.com');
    const { guard, ctx } = setup();
    await expect(guard.canActivate(ctx)).rejects.toThrow(NO_ACCESS);
  });

  it('a CRM email already linked to a different sign-in account is refused', async () => {
    verify.mockResolvedValue('auth-2');
    email.mockResolvedValue('asha@x.com');
    const { guard, ctx, prisma } = setup();
    (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, string> }) =>
      where.email === 'asha@x.com' ? { id: 'u1', authUserId: 'auth-1' } : null);
    await expect(guard.canActivate(ctx)).rejects.toThrow(NO_ACCESS);
  });

  it('the seed admin email is not promoted while an active Super Admin exists', async () => {
    process.env.SEED_ADMIN_EMAIL = 'boss@x.com';
    verify.mockResolvedValue('auth-boss');
    email.mockResolvedValue('boss@x.com');
    const { guard, ctx, prisma } = setup({}, { $transaction: jest.fn() });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(guard.canActivate(ctx)).rejects.toThrow(NO_ACCESS);
    expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).not.toHaveBeenCalled();
  });
});
