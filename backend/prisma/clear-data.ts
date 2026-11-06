/* eslint-disable no-console */
// Removes all business data (leads, calls, follow-ups, tasks, feedback, logs, demo users/teams)
// while keeping the schema, roles, permissions and the Super Admin account(s).
// Usage: npm run clear-data -w backend
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const before = await prisma.lead.count();
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      call_logs, follow_up_reschedules, follow_ups, lead_notes, lead_status_history, lead_assignments,
      task_activities, task_comments, task_checklist_items, attachments, tasks,
      feedback_responses, feedback, leads, lead_sources,
      notifications, sync_row_errors, sync_logs, webhook_events, audit_logs, integration_configs
    RESTART IDENTITY CASCADE`);
  // Keep only Super Admin accounts; remove every other user and all teams.
  const keep = await prisma.user.findMany({
    where: { roles: { some: { role: { key: 'super_admin' } } } },
    select: { id: true, email: true },
  });
  await prisma.user.updateMany({ data: { teamId: null } });
  await prisma.team.deleteMany();
  const removed = await prisma.user.deleteMany({ where: { id: { notIn: keep.map((u) => u.id) } } });
  console.log(`✓ Removed ${before} leads and all related activity, tasks, feedback and logs`);
  console.log(`✓ Removed ${removed.count} users and all teams`);
  console.log(`✓ Kept roles, permissions and Super Admin: ${keep.map((u) => u.email).join(', ')}`);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
