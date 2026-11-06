/* eslint-disable no-console */
// Seeds permissions, built-in roles and the first Super Admin.
// Run with --demo to also create sample teams, users, leads, calls, tasks and feedback.
import { PrismaClient, LeadStatus, TaskPriority, TaskStatus } from '@prisma/client';
import { createClerkClient } from '@clerk/backend';
import { DEFAULT_ROLES, PERMISSIONS } from '../src/common/permissions';

const prisma = new PrismaClient();
const demo = process.argv.includes('--demo');

async function seedRbac() {
  const known = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const added: string[] = [];
  for (const [key, [group, description]] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { group, description }, create: { key, group, description } });
    if (!known.has(key)) added.push(key);
  }
  const perms = await prisma.permission.findMany();
  for (const r of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description, isSystem: true },
      create: { key: r.key, name: r.name, description: r.description, isSystem: true },
    });
    // Only set default permissions on first creation, or always for super_admin (keeps it complete).
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0 || r.key === 'super_admin') {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.createMany({
        data: perms.filter((p) => (r.permissions as string[]).includes(p.key)).map((p) => ({ roleId: role.id, permissionId: p.id })),
      });
    } else if (known.size) {
      // Roles edited by an admin keep their settings, but permissions introduced in an
      // update are added to the built-in roles whose defaults include them.
      const fresh = perms.filter((p) => added.includes(p.key) && (r.permissions as string[]).includes(p.key));
      if (fresh.length) {
        await prisma.rolePermission.createMany({ data: fresh.map((p) => ({ roleId: role.id, permissionId: p.id })), skipDuplicates: true });
        console.log(`  + ${r.key}: ${fresh.map((p) => p.key).join(', ')}`);
      }
    }
  }
  console.log(`✓ ${perms.length} permissions, ${DEFAULT_ROLES.length} roles`);
}

async function createUser(email: string, fullName: string, roleKey: string, extra: { phone?: string; teamId?: string } = {}) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email, fullName, phone: extra.phone, teamId: extra.teamId,
      roles: { create: { roleId: role.id } },
    },
  });
}

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@prisim.local').toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) {
    console.log(`✓ Super Admin ${email} already exists`);
    return;
  }
  await createUser(email, 'Super Admin', 'super_admin');
  console.log(`✓ Super Admin created → ${email}`);
  if (process.env.CLERK_SECRET_KEY) {
    const origin = (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
    await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }).invitations
      .createInvitation({ emailAddress: email, redirectUrl: `${origin}/sign-up`, ignoreExisting: true, notify: true })
      .then(() => console.log(`✓ Clerk invitation emailed to ${email}`))
      .catch((e) => console.warn(`! Could not send the Clerk invitation: ${(e as Error).message}`));
  }
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000);

async function seedDemo() {
  if (await prisma.lead.count()) {
    console.log('• Demo data skipped (leads already exist)');
    return;
  }
  const north = await prisma.team.upsert({ where: { name: 'Sales North' }, update: {}, create: { name: 'Sales North' } });
  const south = await prisma.team.upsert({ where: { name: 'Sales South' }, update: {}, create: { name: 'Sales South' } });
  const manager = await createUser('manager@prisim.local', 'Meera Kapoor', 'admin', { phone: '+919800000002' });
  const tlN = await createUser('lead.north@prisim.local', 'Arjun Mehta', 'team_leader', { phone: '+919800000003', teamId: north.id });
  const tlS = await createUser('lead.south@prisim.local', 'Divya Iyer', 'team_leader', { phone: '+919800000004', teamId: south.id });
  await prisma.team.update({ where: { id: north.id }, data: { leaderId: tlN.id } });
  await prisma.team.update({ where: { id: south.id }, data: { leaderId: tlS.id } });
  const emps = [
    await createUser('rahul@prisim.local', 'Rahul Sharma', 'employee', { phone: '+919800000011', teamId: north.id }),
    await createUser('priya@prisim.local', 'Priya Nair', 'employee', { phone: '+919800000012', teamId: north.id }),
    await createUser('karthik@prisim.local', 'Karthik Reddy', 'employee', { phone: '+919800000013', teamId: south.id }),
    await createUser('sneha@prisim.local', 'Sneha Joshi', 'employee', { phone: '+919800000014', teamId: south.id }),
  ];

  const source = await prisma.leadSource.upsert({ where: { key: 'meta_ads' }, update: {}, create: { key: 'meta_ads', name: 'Meta Ads (Google Sheets)' } });
  const campaigns = [
    { c: 'Diwali Home Loan Offer', a: ['Mumbai 25-45', 'Pune Families'] },
    { c: 'Premium Apartments Launch', a: ['Bangalore IT Pros', 'Hyderabad HNI'] },
    { c: 'Free Consultation Q4', a: ['Lookalike 2%', 'Retargeting 30d'] },
  ];
  const first = ['Aarav', 'Vivaan', 'Aditya', 'Ananya', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Saanvi', 'Arnav', 'Neha', 'Vikram', 'Pooja', 'Siddharth', 'Tanvi', 'Manish', 'Ritika', 'Harsh', 'Nisha', 'Gaurav'];
  const last = ['Patel', 'Gupta', 'Singh', 'Kumar', 'Desai', 'Verma', 'Menon', 'Bose', 'Chopra', 'Pillai'];
  const cities = ['Mumbai', 'Pune', 'Bangalore', 'Hyderabad', 'Chennai', 'Delhi'];
  const flow: LeadStatus[] = ['UNASSIGNED', 'ASSIGNED', 'CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP_REQUIRED', 'CONVERTED', 'LOST'];

  for (let i = 0; i < 60; i++) {
    const camp = pick(campaigns);
    const created = new Date(Date.now() - Math.floor(Math.random() * 28 * 24) * 3600_000);
    const status = i < 8 ? 'UNASSIGNED' : pick(flow.slice(1));
    const owner = status === 'UNASSIGNED' ? null : pick(emps);
    const name = `${pick(first)} ${pick(last)}`;
    const lead = await prisma.lead.create({
      data: {
        sourceId: source.id, externalLeadId: `l:${900000000 + i}`, fullName: name,
        phoneE164: `+9198${String(10000000 + i * 7919).slice(0, 8)}`,
        email: `${name.toLowerCase().replace(' ', '.')}${i}@example.com`, city: pick(cities),
        campaignName: camp.c, adsetName: pick(camp.a), adName: `Creative ${1 + (i % 4)}`, formName: 'Lead form v2',
        sourceCreatedAt: created, createdAt: created, assignedUserId: owner?.id, status,
        closeReason: status === 'LOST' ? pick(['Budget too low', 'Bought elsewhere', 'Not reachable after 5 attempts']) : null,
      },
    });
    await prisma.leadStatusHistory.create({ data: { leadId: lead.id, toStatus: 'UNASSIGNED', reason: 'Imported from Meta Ads (Google Sheets)', createdAt: created } });
    if (!owner) continue;
    const assignedAt = new Date(created.getTime() + 2 * 3600_000);
    await prisma.leadAssignment.create({ data: { leadId: lead.id, userId: owner.id, assignedById: manager.id, method: 'round_robin', assignedAt } });
    await prisma.leadStatusHistory.create({ data: { leadId: lead.id, fromStatus: 'UNASSIGNED', toStatus: 'ASSIGNED', actorId: manager.id, reason: 'Lead assigned', createdAt: assignedAt } });

    const calls = status === 'ASSIGNED' ? 0 : 1 + Math.floor(Math.random() * 3);
    for (let c = 0; c < calls; c++) {
      const at = new Date(assignedAt.getTime() + (c + 1) * (6 + Math.random() * 30) * 3600_000);
      if (at > new Date()) break;
      const connected = c === calls - 1 && status !== 'CONTACT_ATTEMPTED';
      const outcome = connected ? (status === 'INTERESTED' ? 'INTERESTED' : status === 'LOST' ? 'NOT_INTERESTED' : status === 'FOLLOW_UP_REQUIRED' ? 'CALLBACK' : 'CONNECTED') : pick(['NO_ANSWER', 'BUSY', 'SWITCHED_OFF']);
      const dur = connected ? 45 + Math.floor(Math.random() * 400) : 0;
      await prisma.callLog.create({
        data: {
          leadId: lead.id, userId: owner.id, provider: 'manual', direction: 'OUTBOUND', fromNumber: owner.phone, toNumber: lead.phoneE164,
          status: connected ? 'COMPLETED' : 'NO_ANSWER', startedAt: at, endedAt: new Date(at.getTime() + dur * 1000), durationSeconds: dur,
          outcome, notes: connected ? pick(['Discussed pricing, wants brochure on WhatsApp.', 'Asked to call back after salary credit.', 'Comparing with two other builders.', 'Wants site visit this weekend.']) : null,
          createdAt: at,
        },
      });
    }
    if (['FOLLOW_UP_REQUIRED', 'INTERESTED', 'CONTACTED'].includes(status)) {
      const due = hoursFromNow(-30 + Math.floor(Math.random() * 100));
      await prisma.followUp.create({
        data: { leadId: lead.id, ownerId: owner.id, createdById: owner.id, dueAt: due, type: pick(['call', 'whatsapp', 'meeting']), note: pick(['Share brochure and EMI calculation', 'Confirm site visit time', 'Check loan eligibility documents']), overdueNotified: due < new Date() },
      });
    }
    if (status === 'CONVERTED' || status === 'LOST') {
      await prisma.leadStatusHistory.create({ data: { leadId: lead.id, fromStatus: 'CONTACTED', toStatus: status, actorId: owner.id, reason: status === 'LOST' ? lead.closeReason : 'Booking amount paid', createdAt: hoursFromNow(-Math.random() * 200) } });
    }
  }

  const taskSeed: [string, TaskPriority, TaskStatus, number, boolean][] = [
    ['Call back all Diwali campaign leads from last week', 'HIGH', 'IN_PROGRESS', 24, false],
    ['Prepare site-visit schedule for Saturday', 'MEDIUM', 'TODO', 48, false],
    ['Update brochure PDF with new pricing', 'CRITICAL', 'REVIEW', -5, true],
    ['Clean up duplicate leads from CSV import', 'LOW', 'DONE', -48, false],
    ['Collect KYC documents for converted customers', 'HIGH', 'BLOCKED', 12, false],
    ['Weekly pipeline review notes', 'MEDIUM', 'TODO', 72, true],
  ];
  let pos = 1000;
  for (const [title, priority, status, dueH, review] of taskSeed) {
    const assignee = pick(emps);
    const t = await prisma.task.create({
      data: {
        title, priority, status, requiresReview: review, createdById: assignee.teamId === north.id ? tlN.id : tlS.id, assigneeId: assignee.id,
        teamId: assignee.teamId, dueAt: hoursFromNow(dueH), position: (pos += 1000), completedAt: status === 'DONE' ? hoursFromNow(-50) : null,
        description: 'Created from demo seed. Use the checklist to track progress.',
        checklist: { create: [{ text: 'Gather list', done: true, position: 0 }, { text: 'Complete action', done: status === 'DONE', position: 1 }] },
      },
    });
    await prisma.taskActivity.create({ data: { taskId: t.id, actorId: t.createdById, action: 'created' } });
  }

  await prisma.feedback.create({
    data: { kind: 'QUERY', category: 'HR / Policy query', subject: 'Incentive calculation for converted leads', description: 'How is the monthly incentive calculated when a lead is reassigned mid-way?', submittedById: emps[0].id, status: 'UNDER_REVIEW', assignedAdminId: manager.id,
      responses: { create: [{ authorId: manager.id, body: 'Good question — we are confirming the policy with finance and will reply by Friday.' }] } },
  });
  await prisma.feedback.create({
    data: { kind: 'FEEDBACK', category: 'Technical issue', subject: 'Leads from the Pune ad set show wrong city', description: 'Several leads from Pune Families show Mumbai as the city.', submittedById: emps[2].id },
  });
  await prisma.feedback.create({
    data: { kind: 'FEEDBACK', category: 'Management', subject: 'Too many leads assigned late in the evening', description: 'Leads assigned after 7pm are hard to call the same day. Could assignment pause after 6pm?', isAnonymous: true, submitterHash: 'demo-anonymous' },
  });
  console.log(`✓ Demo data: 2 teams, 7 users, 60 leads, calls, follow-ups, tasks, feedback`);
  console.log('  Logins: manager@prisim.local, lead.north@prisim.local, rahul@prisim.local, priya@prisim.local …');
}

(async () => {
  await seedRbac();
  await seedAdmin();
  if (demo) await seedDemo();
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
