import { ForbiddenException } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuthUser } from './current-user';
import { DEFAULT_ROLES } from './permissions';
import { PrismaService } from '../prisma/prisma.service';

const user = (over: Partial<AuthUser> & { perms?: string[] } = {}): AuthUser => ({
  id: 'me', fullName: 'Me', email: 'me@x.com', teamId: null, roleKeys: [], teamIds: [], ...over,
  permissions: new Set(over.perms ?? []),
});

function access(teamMembers: { id: string }[] = []) {
  const findMany = jest.fn().mockResolvedValue(teamMembers);
  const prisma = { user: { findMany } } as unknown as PrismaService;
  return { svc: new AccessService(prisma), findMany };
}

describe('AccessService.scope', () => {
  const { svc } = access();
  it('all beats team beats own', () => {
    expect(svc.scope(user({ perms: ['leads.view.all', 'leads.view.team'] }), 'leads.view')).toBe('all');
    expect(svc.scope(user({ perms: ['leads.view.team'] }), 'leads.view')).toBe('team');
    expect(svc.scope(user(), 'leads.view')).toBe('own');
  });
  it('a permission for another area does not leak', () => {
    expect(svc.scope(user({ perms: ['calls.view.all'] }), 'leads.view')).toBe('own');
  });
});

describe('AccessService.userIdsInScope', () => {
  it('all → unrestricted, without touching the database', async () => {
    const { svc, findMany } = access();
    expect(await svc.userIdsInScope(user({ perms: ['calls.view.all'] }), 'calls.view')).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('own → just me', async () => {
    const { svc } = access();
    expect(await svc.userIdsInScope(user(), 'calls.view')).toEqual(['me']);
  });

  it('team → me plus members of my teams (primary team or membership), de-duplicated', async () => {
    const { svc, findMany } = access([{ id: 'a' }, { id: 'me' }, { id: 'b' }]);
    const ids = await svc.userIdsInScope(user({ perms: ['calls.view.team'], teamIds: ['t1', 't2'] }), 'calls.view');
    expect(ids).toEqual(['me', 'a', 'b']);
    expect(findMany.mock.calls[0][0].where).toEqual({ OR: [{ teamId: { in: ['t1', 't2'] } }, { teamMemberships: { some: { teamId: { in: ['t1', 't2'] } } } }] });
  });

  it('team scope with no team falls back to own', async () => {
    const { svc, findMany } = access();
    expect(await svc.userIdsInScope(user({ perms: ['calls.view.team'] }), 'calls.view')).toEqual(['me']);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('AccessService.canActOnOwner', () => {
  it('own scope: only my records, never unowned ones', async () => {
    const { svc } = access();
    expect(await svc.canActOnOwner(user(), 'leads.edit', 'me')).toBe(true);
    expect(await svc.canActOnOwner(user(), 'leads.edit', 'other')).toBe(false);
    expect(await svc.canActOnOwner(user(), 'leads.edit', null)).toBe(false);
  });

  it('team scope: teammates yes, outsiders no', async () => {
    const { svc } = access([{ id: 'mate' }]);
    const lead = user({ perms: ['leads.edit.team'], teamIds: ['t1'] });
    expect(await svc.canActOnOwner(lead, 'leads.edit', 'mate')).toBe(true);
    expect(await svc.canActOnOwner(lead, 'leads.edit', 'outsider')).toBe(false);
  });

  it('all scope: anything, including unowned', async () => {
    const { svc } = access();
    expect(await svc.canActOnOwner(user({ perms: ['leads.edit.all'] }), 'leads.edit', null)).toBe(true);
  });

  it('assertCanActOnOwner throws 403 with the given message', async () => {
    const { svc } = access();
    await expect(svc.assertCanActOnOwner(user(), 'leads.edit', 'other', 'Nope')).rejects.toThrow(new ForbiddenException('Nope'));
  });
});

describe('default roles', () => {
  const role = (key: string) => new Set(DEFAULT_ROLES.find((r) => r.key === key)!.permissions as readonly string[]);

  it('only the Super Admin gets accounting, role management, client posting and the chat backup', () => {
    for (const r of DEFAULT_ROLES.filter((x) => x.key !== 'super_admin')) {
      const p = new Set(r.permissions as readonly string[]);
      expect([...p].filter((k) => k.startsWith('accounting.') || k === 'roles.manage' || k === 'clients.manage' || k === 'chat.backup.view')).toEqual([]);
    }
    expect(role('super_admin').has('accounting.manage')).toBe(true);
  });

  it('employees cannot see everyone\'s leads to edit, calls or recordings', () => {
    const emp = DEFAULT_ROLES.find((r) => r.key === 'employee');
    if (!emp) return; // role set may be customised
    const p = new Set(emp.permissions as readonly string[]);
    for (const k of ['leads.edit.all', 'calls.view.all', 'calls.recordings.all', 'users.manage', 'roles.manage', 'audit.view']) expect(p.has(k)).toBe(false);
  });
});
