import { ForbiddenException } from '@nestjs/common';
import { TasksService } from './tasks';

// Who may put other people on a task.
describe('TasksService assigning work', () => {
  const prisma = { user: { count: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.length) } };
  const access = { teamMemberIds: jest.fn(async () => ['me', 'teammate']) };
  const svc = new TasksService(prisma as never, access as never, {} as never, {} as never, {} as never);
  const assign = (perms: string[], ids: string[]) =>
    (svc as unknown as { assertCanAssignTo: (u: unknown, ids: string[]) => Promise<void> }).assertCanAssignTo({ id: 'me', permissions: new Set(perms) }, ids);

  it('lets anyone assign work to themselves', async () => {
    await expect(assign([], ['me'])).resolves.toBeUndefined();
  });
  it('stops people without a permission from assigning others', async () => {
    await expect(assign([], ['teammate'])).rejects.toThrow(ForbiddenException);
  });
  it('keeps create-for-others to the own team', async () => {
    await expect(assign(['tasks.create_for_others'], ['teammate'])).resolves.toBeUndefined();
    await expect(assign(['tasks.create_for_others'], ['stranger'])).rejects.toThrow('members of your team');
  });
  it('lets assign-anyone assign anyone in the organisation', async () => {
    await expect(assign(['tasks.assign.anyone'], ['stranger', 'teammate'])).resolves.toBeUndefined();
  });
  it('still lets manage-all assign anyone', async () => {
    await expect(assign(['tasks.manage.all'], ['stranger'])).resolves.toBeUndefined();
  });
});
