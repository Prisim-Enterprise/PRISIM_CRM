import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, } from '@nestjs/common';
import { FileUpload } from '../common/file-upload';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf,
} from 'class-validator';
import { ClientStatus, ClientWorkStatus, Prisma, TaskPriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { MAX_UPLOAD_BYTES, StorageService } from '../common/storage.service';

const toArray = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',');
const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

class ClientQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(ClientStatus) status?: ClientStatus;
}

class ClientDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) company?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) contactName?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsEmail() email?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(10000) notes?: string | null;
  @IsOptional() @IsEnum(ClientStatus) status?: ClientStatus;
}

class UpdateClientDto implements Partial<ClientDto> {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) company?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) contactName?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsEmail() email?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(10000) notes?: string | null;
  @IsOptional() @IsEnum(ClientStatus) status?: ClientStatus;
}

class WorkQuery {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() assignee?: string; // "me" | user id
  @IsOptional() @Transform(toArray) @IsEnum(ClientWorkStatus, { each: true }) status?: ClientWorkStatus[];
  @IsOptional() @IsString() search?: string;
}

class CreateWorkDto {
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) assigneeIds: string[];
}

class UpdateWorkDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(10000) description?: string | null;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueAt?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) assigneeIds?: string[];
}

class WorkUpdateDto {
  @IsOptional() @IsString() @MaxLength(5000) body?: string;
  @IsOptional() @IsEnum(ClientWorkStatus) status?: ClientWorkStatus;
}

const person = { select: { id: true, fullName: true } } as const;
const workListInclude = {
  client: { select: { id: true, name: true, company: true } },
  createdBy: person,
  assignees: { include: { user: person }, orderBy: { createdAt: 'asc' } },
  _count: { select: { updates: true, attachments: true } },
} satisfies Prisma.ClientWorkInclude;

/** What a plain assignee may move their own work to. Managers may set any status. */
const ASSIGNEE_STATUSES: ClientWorkStatus[] = ['OPEN', 'IN_PROGRESS', 'SUBMITTED'];
const OPEN_STATUSES: ClientWorkStatus[] = ['OPEN', 'IN_PROGRESS', 'SUBMITTED'];

@Injectable()
export class ClientsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  private manages(user: AuthUser) {
    return user.permissions.has('clients.manage');
  }

  private seesAll(user: AuthUser) {
    return this.manages(user) || user.permissions.has('clients.view.all');
  }

  /** Non-admins only see work posted to them (or by them). */
  private workWhere(user: AuthUser): Prisma.ClientWorkWhereInput {
    if (this.seesAll(user)) return {};
    return { OR: [{ assignees: { some: { userId: user.id } } }, { createdById: user.id }] };
  }

  private assertManage(user: AuthUser) {
    if (!this.manages(user)) throw new ForbiddenException('Only a Super Admin can manage clients and post client work');
  }

  private async assertActiveUsers(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.user.count({ where: { id: { in: unique }, isActive: true } });
    if (found !== unique.length) throw new BadRequestException('One or more people are inactive or do not exist');
    return unique;
  }

  /** Admins and anyone else who sees all client work, so they hear about every update. */
  private async watchers(work: { createdById: string }) {
    return [work.createdById, ...(await this.notifications.usersWithPermission('clients.view.all')), ...(await this.notifications.usersWithPermission('clients.manage'))];
  }

  // ───── Clients ─────

  async list(user: AuthUser, q: ClientQuery) {
    const and: Prisma.ClientWhereInput[] = [];
    if (!this.seesAll(user)) and.push({ works: { some: this.workWhere(user) } });
    if (q.status) and.push({ status: q.status });
    if (q.search) {
      const s = { contains: q.search.trim(), mode: 'insensitive' as const };
      and.push({ OR: [{ name: s }, { company: s }, { contactName: s }, { email: s }, { phone: s }] });
    }
    const clients = await this.prisma.client.findMany({
      where: { AND: and },
      include: { createdBy: person },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 500,
    });
    const ids = clients.map((c) => c.id);
    const scoped = { clientId: { in: ids }, ...this.workWhere(user) };
    const [total, open, last] = await Promise.all([
      this.prisma.clientWork.groupBy({ by: ['clientId'], where: scoped, _count: true }),
      this.prisma.clientWork.groupBy({ by: ['clientId'], where: { ...scoped, status: { in: OPEN_STATUSES } }, _count: true }),
      this.prisma.clientWork.groupBy({ by: ['clientId'], where: scoped, _max: { updatedAt: true } }),
    ]);
    return clients.map((c) => ({
      ...c,
      workCount: total.find((t) => t.clientId === c.id)?._count ?? 0,
      openWorkCount: open.find((t) => t.clientId === c.id)?._count ?? 0,
      lastActivityAt: last.find((t) => t.clientId === c.id)?._max.updatedAt ?? c.updatedAt,
    }));
  }

  async get(user: AuthUser, id: string) {
    const client = await this.prisma.client.findUnique({ where: { id }, include: { createdBy: person } });
    if (!client) throw new NotFoundException('Client not found');
    const works = await this.prisma.clientWork.findMany({
      where: { clientId: id, ...this.workWhere(user) }, include: workListInclude, orderBy: [{ createdAt: 'desc' }],
    });
    if (!this.seesAll(user) && !works.length) throw new NotFoundException('Client not found');
    return { ...client, works: works.map((w) => this.decorate(w)), permissions: { canManage: this.manages(user) } };
  }

  async create(user: AuthUser, dto: ClientDto) {
    this.assertManage(user);
    const c = await this.prisma.client.create({
      data: {
        name: dto.name.trim(), company: dto.company, contactName: dto.contactName, email: dto.email?.toLowerCase(),
        phone: dto.phone, notes: dto.notes, status: dto.status ?? 'ACTIVE', createdById: user.id,
      },
    });
    await this.audit.record({ actorId: user.id, action: 'client.created', entityType: 'client', entityId: c.id, after: { name: c.name } });
    return c;
  }

  async update(user: AuthUser, id: string, dto: UpdateClientDto) {
    this.assertManage(user);
    const before = await this.prisma.client.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Client not found');
    const c = await this.prisma.client.update({
      where: { id },
      data: {
        name: dto.name?.trim(), company: dto.company, contactName: dto.contactName,
        email: dto.email === undefined ? undefined : dto.email?.toLowerCase() ?? null, phone: dto.phone, notes: dto.notes, status: dto.status,
      },
    });
    const changed = Object.fromEntries(
      (['name', 'company', 'contactName', 'email', 'phone', 'notes', 'status'] as const)
        .filter((k) => dto[k] !== undefined && before[k] !== c[k]).map((k) => [k, { from: before[k], to: c[k] }]),
    );
    if (Object.keys(changed).length) await this.audit.record({ actorId: user.id, action: 'client.updated', entityType: 'client', entityId: id, after: changed });
    return c;
  }

  async remove(user: AuthUser, id: string) {
    this.assertManage(user);
    const c = await this.prisma.client.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Client not found');
    const files = await this.prisma.attachment.findMany({ where: { clientWork: { clientId: id } } });
    await this.prisma.client.delete({ where: { id } });
    for (const f of files) await this.storage.remove(f.storageKey);
    await this.audit.record({ actorId: user.id, action: 'client.deleted', entityType: 'client', entityId: id, before: { name: c.name } });
    return { ok: true };
  }

  // ───── Work ─────

  private decorate<T extends { dueAt: Date | null; status: ClientWorkStatus }>(w: T) {
    return { ...w, isOverdue: !!w.dueAt && w.dueAt < new Date() && w.status !== 'DONE' };
  }

  private async loadWork(user: AuthUser, id: string) {
    const work = await this.prisma.clientWork.findFirst({ where: { id, ...this.workWhere(user) }, include: { assignees: true, client: true } });
    if (!work) throw new NotFoundException('Work item not found');
    const isAssignee = work.assignees.some((a) => a.userId === user.id);
    return { work, isAssignee, canManage: this.manages(user) };
  }

  async listWork(user: AuthUser, q: WorkQuery) {
    const and: Prisma.ClientWorkWhereInput[] = [this.workWhere(user)];
    if (q.clientId) and.push({ clientId: q.clientId });
    if (q.assignee) and.push({ assignees: { some: { userId: q.assignee === 'me' ? user.id : q.assignee } } });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.search) {
      const s = { contains: q.search.trim(), mode: 'insensitive' as const };
      and.push({ OR: [{ title: s }, { client: { name: s } }, { client: { company: s } }] });
    }
    const works = await this.prisma.clientWork.findMany({
      where: { AND: and }, include: workListInclude, orderBy: [{ updatedAt: 'desc' }], take: 500,
    });
    return works.map((w) => this.decorate(w));
  }

  async getWork(user: AuthUser, id: string) {
    const { isAssignee, canManage } = await this.loadWork(user, id);
    const w = await this.prisma.clientWork.findUniqueOrThrow({
      where: { id },
      include: {
        ...workListInclude,
        updates: { include: { author: person }, orderBy: { createdAt: 'asc' } },
        attachments: { include: { uploadedBy: person }, orderBy: { createdAt: 'desc' } },
      },
    });
    return {
      ...this.decorate(w),
      permissions: { canManage, canWork: canManage || isAssignee, allowedStatuses: canManage ? Object.values(ClientWorkStatus) : ASSIGNEE_STATUSES },
    };
  }

  async createWork(user: AuthUser, clientId: string, dto: CreateWorkDto) {
    this.assertManage(user);
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (!dto.assigneeIds.length) throw new BadRequestException('Choose at least one person to post this work to');
    const assigneeIds = await this.assertActiveUsers(dto.assigneeIds);
    const work = await this.prisma.clientWork.create({
      data: {
        clientId, title: dto.title.trim(), description: dto.description?.trim() || null, priority: dto.priority ?? 'MEDIUM',
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null, createdById: user.id,
        assignees: { create: assigneeIds.map((userId) => ({ userId })) },
        updates: { create: { authorId: user.id, body: 'Posted this work', toStatus: 'OPEN' } },
      },
    });
    await this.prisma.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
    await this.notifications.notifyMany(assigneeIds.filter((u) => u !== user.id), {
      type: 'client.work_posted', title: `New client work for ${client.name}: ${work.title}`,
      body: `${work.priority} priority, from ${user.fullName}`, link: `/clients/${clientId}?work=${work.id}`,
    });
    await this.audit.record({ actorId: user.id, action: 'client_work.created', entityType: 'client_work', entityId: work.id, after: { client: client.name, title: work.title, assigneeIds } });
    return work;
  }

  async updateWork(user: AuthUser, id: string, dto: UpdateWorkDto) {
    this.assertManage(user);
    const { work } = await this.loadWork(user, id);
    const before = work.assignees.map((a) => a.userId);
    let added: string[] = [];
    let removed: string[] = [];
    if (dto.assigneeIds) {
      if (!dto.assigneeIds.length) throw new BadRequestException('Work must be posted to at least one person');
      const next = await this.assertActiveUsers(dto.assigneeIds);
      added = next.filter((u) => !before.includes(u));
      removed = before.filter((u) => !next.includes(u));
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.clientWork.update({
        where: { id },
        data: {
          title: dto.title?.trim(), description: dto.description === undefined ? undefined : dto.description?.trim() || null,
          priority: dto.priority, dueAt: dto.dueAt === undefined ? undefined : dto.dueAt ? new Date(dto.dueAt) : null,
        },
      });
      if (removed.length) await tx.clientWorkAssignee.deleteMany({ where: { workId: id, userId: { in: removed } } });
      if (added.length) await tx.clientWorkAssignee.createMany({ data: added.map((userId) => ({ workId: id, userId })) });
      if (added.length || removed.length) {
        const names = await tx.user.findMany({ where: { id: { in: [...added, ...removed] } }, select: { id: true, fullName: true } });
        const n = (ids: string[]) => ids.map((i) => names.find((x) => x.id === i)?.fullName).join(', ');
        const parts = [added.length && `added ${n(added)}`, removed.length && `removed ${n(removed)}`].filter(Boolean);
        await tx.clientWorkUpdate.create({ data: { workId: id, authorId: user.id, body: `Changed people: ${parts.join('; ')}` } });
      }
    });
    await this.notifications.notifyMany(added.filter((u) => u !== user.id), {
      type: 'client.work_posted', title: `Client work for ${work.client.name}: ${dto.title ?? work.title}`,
      body: `Posted to you by ${user.fullName}`, link: `/clients/${work.clientId}?work=${id}`,
    });
    await this.audit.record({
      actorId: user.id, action: 'client_work.updated', entityType: 'client_work', entityId: id,
      after: { ...dto, ...(added.length || removed.length ? { added, removed } : {}) },
    });
    return this.getWork(user, id);
  }

  async removeWork(user: AuthUser, id: string) {
    this.assertManage(user);
    const { work } = await this.loadWork(user, id);
    const files = await this.prisma.attachment.findMany({ where: { clientWorkId: id } });
    await this.prisma.clientWork.delete({ where: { id } });
    for (const f of files) await this.storage.remove(f.storageKey);
    await this.audit.record({ actorId: user.id, action: 'client_work.deleted', entityType: 'client_work', entityId: id, before: { client: work.client.name, title: work.title } });
    return { ok: true };
  }

  /** A progress note and/or status change, from an assignee or a manager. */
  async postUpdate(user: AuthUser, id: string, dto: WorkUpdateDto) {
    const { work, isAssignee, canManage } = await this.loadWork(user, id);
    if (!isAssignee && !canManage) throw new ForbiddenException('Only the people this work was posted to can update it');
    const body = dto.body?.trim() || null;
    const statusChange = dto.status && dto.status !== work.status ? dto.status : null;
    if (!body && !statusChange) throw new BadRequestException('Write an update or change the status');
    if (statusChange && !canManage && !ASSIGNEE_STATUSES.includes(statusChange)) {
      throw new ForbiddenException('Submit the work for review; a Super Admin marks it done');
    }
    const u = await this.prisma.$transaction(async (tx) => {
      if (statusChange) {
        await tx.clientWork.update({
          where: { id }, data: { status: statusChange, completedAt: statusChange === 'DONE' ? new Date() : null },
        });
      } else {
        await tx.clientWork.update({ where: { id }, data: { updatedAt: new Date() } });
      }
      await tx.client.update({ where: { id: work.clientId }, data: { updatedAt: new Date() } });
      return tx.clientWorkUpdate.create({
        data: { workId: id, authorId: user.id, body, fromStatus: statusChange ? work.status : null, toStatus: statusChange },
        include: { author: person },
      });
    });
    const label = statusChange ? STATUS_LABEL[statusChange] : null;
    const recipients = isAssignee && !canManage
      ? [...(await this.watchers(work)), ...work.assignees.map((a) => a.userId)]
      : work.assignees.map((a) => a.userId);
    await this.notifications.notifyMany(recipients.filter((r) => r !== user.id), {
      type: 'client.work_update',
      title: `${user.fullName} ${label ? `marked "${work.title}" ${label}` : `updated "${work.title}"`} (${work.client.name})`,
      body: body?.slice(0, 140), link: `/clients/${work.clientId}?work=${id}`,
    });
    return u;
  }

  async attach(user: AuthUser, id: string, file: Express.Multer.File) {
    const { work, isAssignee, canManage } = await this.loadWork(user, id);
    if (!isAssignee && !canManage) throw new ForbiddenException();
    this.storage.validate('attachment', file);
    const key = await this.storage.save('attachment', file.buffer, file.originalname, file.mimetype);
    const a = await this.prisma.attachment.create({
      data: { storageKey: key, fileName: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, uploadedById: user.id, clientWorkId: id },
    });
    await this.prisma.clientWorkUpdate.create({ data: { workId: id, authorId: user.id, body: `Attached ${a.fileName}` } });
    if (isAssignee && !canManage) {
      await this.notifications.notifyMany((await this.watchers(work)).filter((r) => r !== user.id), {
        type: 'client.work_update', title: `${user.fullName} attached a file to "${work.title}" (${work.client.name})`,
        body: a.fileName, link: `/clients/${work.clientId}?work=${id}`,
      });
    }
    return a;
  }

  /** Used by the attachments controller. */
  async assertCanView(user: AuthUser, workId: string) {
    await this.loadWork(user, workId);
  }

  async assertCanWork(user: AuthUser, workId: string, uploadedById: string | null) {
    const { canManage } = await this.loadWork(user, workId);
    if (!canManage && uploadedById !== user.id) throw new ForbiddenException();
  }

  /** Summary for the dashboard. */
  async summary(user: AuthUser) {
    const where = this.workWhere(user);
    const mine = { assignees: { some: { userId: user.id } } };
    const [activeClients, openWork, submitted, overdue, myOpen] = await Promise.all([
      this.seesAll(user) ? this.prisma.client.count({ where: { status: 'ACTIVE' } }) : Promise.resolve(null),
      this.prisma.clientWork.count({ where: { ...where, status: { in: OPEN_STATUSES } } }),
      this.prisma.clientWork.count({ where: { ...where, status: 'SUBMITTED' } }),
      this.prisma.clientWork.count({ where: { ...where, status: { not: 'DONE' }, dueAt: { lt: new Date() } } }),
      this.prisma.clientWork.count({ where: { ...mine, status: { in: OPEN_STATUSES } } }),
    ]);
    return { activeClients, openWork, submitted, overdue, myOpen };
  }
}

const STATUS_LABEL: Record<ClientWorkStatus, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', SUBMITTED: 'Submitted', DONE: 'Done' };

@ApiTags('Clients')
@ApiBearerAuth()
@Controller()
export class ClientsController {
  constructor(private svc: ClientsService) {}

  @Get('clients') list(@CurrentUser() u: AuthUser, @Query() q: ClientQuery) { return this.svc.list(u, q); }
  @Get('clients/summary') summary(@CurrentUser() u: AuthUser) { return this.svc.summary(u); }
  @Get('clients/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }
  @Post('clients') @RequireAny('clients.manage') create(@CurrentUser() u: AuthUser, @Body() dto: ClientDto) { return this.svc.create(u, dto); }
  @Patch('clients/:id') @RequireAny('clients.manage') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClientDto) { return this.svc.update(u, id, dto); }
  @Delete('clients/:id') @RequireAny('clients.manage') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }
  @Post('clients/:id/work') @RequireAny('clients.manage') createWork(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateWorkDto) { return this.svc.createWork(u, id, dto); }

  @Get('client-work') listWork(@CurrentUser() u: AuthUser, @Query() q: WorkQuery) { return this.svc.listWork(u, q); }
  @Get('client-work/:id') getWork(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getWork(u, id); }
  @Patch('client-work/:id') @RequireAny('clients.manage') updateWork(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkDto) { return this.svc.updateWork(u, id, dto); }
  @Delete('client-work/:id') @RequireAny('clients.manage') removeWork(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeWork(u, id); }
  @Post('client-work/:id/updates') postUpdate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WorkUpdateDto) { return this.svc.postUpdate(u, id, dto); }

  @Post('client-work/:id/attachments')
  @FileUpload()
  attach(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.attach(u, id, file);
  }
}

@Module({ providers: [ClientsService], controllers: [ClientsController], exports: [ClientsService] })
export class ClientsModule {}

