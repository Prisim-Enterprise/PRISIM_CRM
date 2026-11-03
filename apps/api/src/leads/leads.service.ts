import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Lead, LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { normalizeEmail, normalizePhone } from '../common/phone';
import { paged, skipTake } from '../common/pagination';
import { addDays, parseLocalDate } from '../common/time';
import { autoAdvance, isClosed, validateManualTransition } from './lead-status';
import type { AssignDto, CreateLeadDto, LeadQuery, UpdateLeadDto } from './leads.dto';

type Tx = Prisma.TransactionClient;

const ownerSelect = { select: { id: true, fullName: true } } as const;

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  // ───────────── status (shared with calls, follow-ups and sync) ─────────────

  async setStatus(tx: Tx, lead: Pick<Lead, 'id' | 'status'>, to: LeadStatus, actorId: string | null, reason?: string | null) {
    if (lead.status === to) return;
    await tx.lead.update({
      where: { id: lead.id },
      data: { status: to, ...(isClosed(to) ? { closeReason: reason ?? null } : { closeReason: null }) },
    });
    await tx.leadStatusHistory.create({
      data: { leadId: lead.id, fromStatus: lead.status, toStatus: to, reason: reason ?? null, actorId },
    });
  }

  /** Forward-only automatic status change triggered by activity (calls, follow-ups). */
  async advance(tx: Tx, leadId: string, suggested: LeadStatus, actorId: string | null, reason: string) {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId }, select: { id: true, status: true } });
    const next = autoAdvance(lead.status, suggested);
    if (next) await this.setStatus(tx, lead, next, actorId, reason);
  }

  // ───────────── access helpers ─────────────

  async getLeadForEdit(user: AuthUser, id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    await this.access.assertCanActOnOwner(user, 'leads.edit', lead.assignedUserId, 'You can only update leads assigned to you');
    return lead;
  }

  private async viewWhere(user: AuthUser): Promise<Prisma.LeadWhereInput> {
    const ids = await this.access.userIdsInScope(user, 'leads.view');
    return ids === null ? {} : { assignedUserId: { in: ids } };
  }

  async assertCanView(user: AuthUser, lead: { assignedUserId: string | null }) {
    await this.access.assertCanActOnOwner(user, 'leads.view', lead.assignedUserId);
  }

  // ───────────── queries ─────────────

  async list(user: AuthUser, q: LeadQuery) {
    const and: Prisma.LeadWhereInput[] = [await this.viewWhere(user)];
    if (q.search) {
      const s = q.search.trim();
      const digits = s.replace(/\D/g, '');
      and.push({
        OR: [
          { fullName: { contains: s, mode: 'insensitive' } },
          { email: { contains: s, mode: 'insensitive' } },
          ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
        ],
      });
    }
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.open === 'true') and.push({ status: { notIn: ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'] } });
    if (q.owner === 'unassigned') and.push({ assignedUserId: null });
    else if (q.owner === 'me') and.push({ assignedUserId: user.id });
    else if (q.owner) and.push({ assignedUserId: q.owner });
    if (q.teamId) and.push({ assignedUser: { teamId: q.teamId } });
    if (q.campaign) and.push({ campaignName: q.campaign });
    if (q.source) and.push({ source: { key: q.source } });
    if (q.from) and.push({ createdAt: { gte: parseLocalDate(q.from) } });
    if (q.to) and.push({ createdAt: { lt: addDays(parseLocalDate(q.to), 1) } });

    const where: Prisma.LeadWhereInput = { AND: and };
    const orderBy: Prisma.LeadOrderByWithRelationInput =
      q.sort === 'updated' ? { updatedAt: 'desc' } : q.sort === 'oldest' ? { createdAt: 'asc' } : { createdAt: 'desc' };
    const now = new Date();
    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where, orderBy, ...skipTake(q),
        include: {
          assignedUser: ownerSelect,
          source: { select: { key: true, name: true } },
          followUps: { where: { status: 'PENDING' }, orderBy: { dueAt: 'asc' }, take: 1, select: { id: true, dueAt: true } },
          _count: { select: { calls: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);
    return paged(
      items.map(({ followUps, _count, ...l }) => ({
        ...l,
        nextFollowUpAt: followUps[0]?.dueAt ?? null,
        followUpOverdue: !!followUps[0] && followUps[0].dueAt < now,
        callCount: _count.calls,
      })),
      total, q,
    );
  }

  async filterOptions() {
    const [campaigns, sources] = await Promise.all([
      this.prisma.lead.findMany({ where: { campaignName: { not: null } }, distinct: ['campaignName'], select: { campaignName: true }, orderBy: { campaignName: 'asc' } }),
      this.prisma.leadSource.findMany({ select: { key: true, name: true } }),
    ]);
    return { campaigns: campaigns.map((c) => c.campaignName!), sources };
  }

  async get(user: AuthUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        assignedUser: { select: { id: true, fullName: true, phone: true, teamId: true } },
        source: { select: { key: true, name: true } },
        duplicateOf: { select: { id: true, fullName: true, status: true } },
        duplicates: { select: { id: true, fullName: true, status: true, createdAt: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    await this.assertCanView(user, lead);
    const [canEdit, canAssign] = await Promise.all([
      this.access.canActOnOwner(user, 'leads.edit', lead.assignedUserId),
      this.canAssign(user, lead.assignedUserId),
    ]);
    return { ...lead, permissions: { canEdit, canAssign } };
  }

  /** Unified activity timeline: status changes, assignments, notes, calls and follow-ups. */
  async timeline(user: AuthUser, id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id }, select: { id: true, assignedUserId: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    await this.assertCanView(user, lead);
    const actor = { select: { id: true, fullName: true } };
    const [statuses, assignments, notes, calls, followUps] = await Promise.all([
      this.prisma.leadStatusHistory.findMany({ where: { leadId: id }, include: { actor } }),
      this.prisma.leadAssignment.findMany({ where: { leadId: id }, include: { user: actor, assignedBy: actor } }),
      this.prisma.leadNote.findMany({ where: { leadId: id }, include: { author: actor } }),
      this.prisma.callLog.findMany({ where: { leadId: id }, include: { user: actor } }),
      this.prisma.followUp.findMany({ where: { leadId: id }, include: { owner: actor, createdBy: actor } }),
    ]);
    const recordingScope = await this.access.userIdsInScope(user, 'calls.recordings');
    const canPlay = (ownerId: string) => recordingScope === null || recordingScope.includes(ownerId);

    const events = [
      ...statuses.map((s) => ({ type: 'status', at: s.createdAt, actor: s.actor, data: { from: s.fromStatus, to: s.toStatus, reason: s.reason } })),
      ...assignments.map((a) => ({ type: 'assignment', at: a.assignedAt, actor: a.assignedBy, data: { to: a.user, method: a.method, reason: a.reason } })),
      ...notes.map((n) => ({ type: 'note', at: n.createdAt, actor: n.author, data: { id: n.id, body: n.body } })),
      ...calls.map((c) => ({
        type: 'call', at: c.startedAt ?? c.createdAt, actor: c.user,
        data: {
          id: c.id, direction: c.direction, status: c.status, outcome: c.outcome, notes: c.notes, provider: c.provider,
          durationSeconds: c.durationSeconds, fromNumber: c.fromNumber, toNumber: c.toNumber,
          hasRecording: !!(c.recordingKey || c.recordingUrl), canPlayRecording: canPlay(c.userId),
        },
      })),
      ...followUps.map((f) => ({
        type: 'follow_up', at: f.createdAt, actor: f.createdBy,
        data: { id: f.id, dueAt: f.dueAt, status: f.status, outcome: f.outcome, note: f.note, owner: f.owner, followUpType: f.type, completedAt: f.completedAt },
      })),
    ];
    return events.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  // ───────────── mutations ─────────────

  async create(user: AuthUser, dto: CreateLeadDto) {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) throw new BadRequestException('Phone number is not valid');
    const email = dto.email ? normalizeEmail(dto.email) : null;
    if (dto.email && !email) throw new BadRequestException('Email is not valid');
    if (!phone && !email) throw new BadRequestException('Provide a phone number or email');

    if (!dto.force && phone) {
      const existing = await this.prisma.lead.findFirst({ where: { phoneE164: phone, status: { notIn: ['DUPLICATE'] } }, select: { id: true, fullName: true } });
      if (existing) throw new ConflictException({ message: `A lead with this phone already exists (${existing.fullName})`, existingLeadId: existing.id });
    }
    const source = await this.prisma.leadSource.upsert({ where: { key: 'manual' }, update: {}, create: { key: 'manual', name: 'Manual entry' } });
    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          sourceId: source.id, fullName: dto.fullName.trim(), phoneE164: phone, email, city: dto.city,
          campaignName: dto.campaignName, status: 'UNASSIGNED',
        },
      });
      await tx.leadStatusHistory.create({ data: { leadId: created.id, toStatus: 'UNASSIGNED', actorId: user.id, reason: 'Created manually' } });
      return created;
    });
    await this.audit.record({ actorId: user.id, action: 'lead.created', entityType: 'lead', entityId: lead.id });
    if (dto.assignToUserId) await this.assign(user, { leadIds: [lead.id], method: 'manual', userId: dto.assignToUserId });
    return lead;
  }

  async update(user: AuthUser, id: string, dto: UpdateLeadDto) {
    const lead = await this.getLeadForEdit(user, id);
    const data: Prisma.LeadUpdateInput = {};
    const edited = new Set(lead.editedFields);
    if (dto.fullName !== undefined) { data.fullName = dto.fullName.trim(); edited.add('fullName'); }
    if (dto.phone !== undefined) {
      const p = dto.phone ? normalizePhone(dto.phone) : null;
      if (dto.phone && !p) throw new BadRequestException('Phone number is not valid');
      data.phoneE164 = p; edited.add('phoneE164');
    }
    if (dto.email !== undefined) {
      const e = dto.email ? normalizeEmail(dto.email) : null;
      if (dto.email && !e) throw new BadRequestException('Email is not valid');
      data.email = e; edited.add('email');
    }
    if (dto.city !== undefined) { data.city = dto.city; edited.add('city'); }
    data.editedFields = [...edited];
    const updated = await this.prisma.lead.update({ where: { id }, data });
    await this.audit.record({
      actorId: user.id, action: 'lead.updated', entityType: 'lead', entityId: id,
      before: { fullName: lead.fullName, email: lead.email, city: lead.city, phoneChanged: dto.phone !== undefined },
      after: { fullName: updated.fullName, email: updated.email, city: updated.city },
    });
    return updated;
  }

  async changeStatus(user: AuthUser, id: string, to: LeadStatus, reason?: string, duplicateOfId?: string) {
    const lead = await this.getLeadForEdit(user, id);
    const err = validateManualTransition(lead.status, to, reason);
    if (err) throw new BadRequestException(err);
    if (to === 'DUPLICATE' && duplicateOfId) {
      if (duplicateOfId === id) throw new BadRequestException('A lead cannot duplicate itself');
      await this.prisma.lead.findUniqueOrThrow({ where: { id: duplicateOfId } });
    }
    await this.prisma.$transaction(async (tx) => {
      await this.setStatus(tx, lead, to, user.id, reason);
      if (to === 'DUPLICATE') await tx.lead.update({ where: { id }, data: { duplicateOfId: duplicateOfId ?? lead.duplicateOfId } });
      if (isClosed(lead.status) && lead.status === 'DUPLICATE') await tx.lead.update({ where: { id }, data: { duplicateOfId: null } });
      // Closing a lead cancels its open follow-ups so they don't linger as overdue.
      if (isClosed(to)) {
        await tx.followUp.updateMany({ where: { leadId: id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: `Lead closed as ${to}` } });
      }
    });
    await this.audit.record({ actorId: user.id, action: 'lead.status_changed', entityType: 'lead', entityId: id, before: { status: lead.status }, after: { status: to, reason } });
    return this.prisma.lead.findUnique({ where: { id } });
  }

  async addNote(user: AuthUser, id: string, body: string) {
    await this.getLeadForEdit(user, id);
    const note = await this.prisma.leadNote.create({
      data: { leadId: id, authorId: user.id, body: body.trim() },
      include: { author: ownerSelect },
    });
    await this.prisma.lead.update({ where: { id }, data: { updatedAt: new Date() } });
    return note;
  }

  // ───────────── assignment ─────────────

  private async canAssign(user: AuthUser, currentOwnerId: string | null) {
    if (user.permissions.has('leads.assign.all')) return true;
    if (!user.permissions.has('leads.assign.team')) return false;
    if (!currentOwnerId) return true;
    return (await this.access.teamMemberIds(user)).includes(currentOwnerId);
  }

  /**
   * Assigns one or many leads. Manual picks a single owner; round_robin rotates through
   * the given pool; workload picks whoever in the pool has the fewest open leads.
   */
  async assign(user: AuthUser, dto: AssignDto) {
    if (!user.permissions.has('leads.assign.all') && !user.permissions.has('leads.assign.team')) {
      throw new ForbiddenException('You cannot assign leads');
    }
    const teamScope = !user.permissions.has('leads.assign.all');
    const teamIds = teamScope ? await this.access.teamMemberIds(user) : null;

    const pool = dto.method === 'manual' ? (dto.userId ? [dto.userId] : []) : dto.userIds ?? [];
    if (!pool.length) throw new BadRequestException('Choose who to assign to');
    const users = await this.prisma.user.findMany({ where: { id: { in: pool }, isActive: true }, select: { id: true, fullName: true } });
    if (users.length !== new Set(pool).size) throw new BadRequestException('One or more selected users are inactive or do not exist');
    if (teamIds && pool.some((id) => !teamIds.includes(id))) throw new ForbiddenException('You can only assign to members of your team');

    const leads = await this.prisma.lead.findMany({ where: { id: { in: dto.leadIds } } });
    if (leads.length !== dto.leadIds.length) throw new NotFoundException('One or more leads were not found');
    if (teamIds && leads.some((l) => l.assignedUserId && !teamIds.includes(l.assignedUserId))) {
      throw new ForbiddenException('You can only reassign leads owned by your team');
    }

    // Work out the owner for each lead.
    const plan = new Map<string, string>();
    if (dto.method === 'workload') {
      const counts = await this.prisma.lead.groupBy({
        by: ['assignedUserId'],
        where: { assignedUserId: { in: pool }, status: { notIn: ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'] } },
        _count: true,
      });
      const load = new Map(pool.map((id) => [id, counts.find((c) => c.assignedUserId === id)?._count ?? 0]));
      for (const l of leads) {
        const [best] = [...load.entries()].sort((a, b) => a[1] - b[1]);
        plan.set(l.id, best[0]);
        load.set(best[0], best[1] + 1);
      }
    } else if (dto.method === 'round_robin') {
      const cfg = await this.prisma.integrationConfig.upsert({ where: { key: 'assignment' }, update: {}, create: { key: 'assignment' } });
      let pointer = Number((cfg.state as { rrPointer?: number }).rrPointer ?? 0);
      const sorted = [...pool].sort();
      for (const l of leads) plan.set(l.id, sorted[pointer++ % sorted.length]);
      await this.prisma.integrationConfig.update({ where: { key: 'assignment' }, data: { state: { ...(cfg.state as object), rrPointer: pointer % sorted.length } } });
    } else {
      for (const l of leads) plan.set(l.id, pool[0]);
    }

    let changed = 0;
    const perUser = new Map<string, number>();
    for (const lead of leads) {
      const ownerId = plan.get(lead.id)!;
      if (lead.assignedUserId === ownerId) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.leadAssignment.updateMany({ where: { leadId: lead.id, endedAt: null }, data: { endedAt: new Date() } });
        await tx.leadAssignment.create({
          data: { leadId: lead.id, userId: ownerId, assignedById: user.id, method: dto.method, reason: dto.reason },
        });
        await tx.lead.update({ where: { id: lead.id }, data: { assignedUserId: ownerId } });
        if (lead.status === 'NEW' || lead.status === 'UNASSIGNED') await this.setStatus(tx, lead, 'ASSIGNED', user.id, 'Lead assigned');
        // Open follow-ups move with the lead so nothing is orphaned.
        await tx.followUp.updateMany({ where: { leadId: lead.id, status: 'PENDING' }, data: { ownerId } });
      });
      changed++;
      perUser.set(ownerId, (perUser.get(ownerId) ?? 0) + 1);
      await this.audit.record({
        actorId: user.id, action: lead.assignedUserId ? 'lead.reassigned' : 'lead.assigned', entityType: 'lead', entityId: lead.id,
        before: { ownerId: lead.assignedUserId }, after: { ownerId, method: dto.method, reason: dto.reason },
      });
    }
    for (const [uid, n] of perUser) {
      const single = n === 1 ? leads.find((l) => plan.get(l.id) === uid && l.assignedUserId !== uid) : null;
      await this.notifications.notify(uid, {
        type: 'lead.assigned',
        title: n === 1 ? `New lead assigned: ${single?.fullName}` : `${n} new leads assigned to you`,
        body: `Assigned by ${user.fullName}`,
        link: n === 1 && single ? `/leads/${single.id}` : '/leads?owner=me',
      });
    }
    return { assigned: changed, skipped: leads.length - changed };
  }

  async unassign(user: AuthUser, id: string, reason?: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!(await this.canAssign(user, lead.assignedUserId))) throw new ForbiddenException('You cannot unassign this lead');
    await this.prisma.$transaction(async (tx) => {
      await tx.leadAssignment.updateMany({ where: { leadId: id, endedAt: null }, data: { endedAt: new Date() } });
      await tx.lead.update({ where: { id }, data: { assignedUserId: null } });
      if (!isClosed(lead.status)) await this.setStatus(tx, lead, 'UNASSIGNED', user.id, reason ?? 'Unassigned');
    });
    await this.audit.record({ actorId: user.id, action: 'lead.unassigned', entityType: 'lead', entityId: id, before: { ownerId: lead.assignedUserId }, after: { reason } });
    return { ok: true };
  }

  /** CSV export of leads in the caller's scope matching the filters. */
  async exportCsv(user: AuthUser, q: LeadQuery) {
    const res = await this.list(user, { ...q, page: 1, pageSize: 10_000 } as LeadQuery);
    const cols = ['fullName', 'phoneE164', 'email', 'city', 'status', 'campaignName', 'adsetName', 'adName', 'owner', 'createdAt'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
      // Prevent spreadsheet formula injection.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = res.items.map((l) =>
      cols.map((c) => esc(c === 'owner' ? l.assignedUser?.fullName : (l as Record<string, unknown>)[c])).join(','),
    );
    await this.audit.record({ actorId: user.id, action: 'lead.exported', entityType: 'lead', after: { count: rows.length, filters: q } });
    return [cols.join(','), ...rows].join('\n');
  }
}
