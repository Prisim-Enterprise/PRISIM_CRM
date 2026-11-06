import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FileUpload } from '../common/file-upload';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf,
} from 'class-validator';
import { Prisma, TaskPriority, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { MAX_UPLOAD_BYTES, StorageService } from '../common/storage.service';
import { localDayRange, addDays } from '../common/time';

const toArray = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',');

class TaskQuery {
  @IsOptional() @IsString() assignee?: string; // "me" | "unassigned" | id
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() leadId?: string;
  @IsOptional() @Transform(toArray) @IsEnum(TaskStatus, { each: true }) status?: TaskStatus[];
  @IsOptional() @Transform(toArray) @IsEnum(TaskPriority, { each: true }) priority?: TaskPriority[];
  @IsOptional() @IsIn(['overdue', 'today', 'week']) due?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['true', 'false']) createdByMe?: string;
}

class CreateTaskDto {
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsUUID() leadId?: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsBoolean() requiresReview?: boolean;
}

class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() assigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() teamId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() leadId?: string | null;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueAt?: string | null;
  @IsOptional() @IsBoolean() requiresReview?: boolean;
}

class MoveDto {
  @IsEnum(TaskStatus) status: TaskStatus;
  @IsOptional() @IsNumber() position?: number;
}

class ReviewDto {
  @IsIn(['approve', 'reject']) decision: 'approve' | 'reject';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class CommentDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}

class ChecklistDto {
  @IsString() @MinLength(1) @MaxLength(500) text: string;
}

class ChecklistUpdateDto {
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsBoolean() done?: boolean;
}

const person = { select: { id: true, fullName: true } } as const;
const listInclude = {
  assignee: person,
  createdBy: person,
  team: { select: { id: true, name: true } },
  lead: { select: { id: true, fullName: true } },
  _count: { select: { comments: true, subtasks: true, attachments: true, checklist: true } },
  checklist: { select: { done: true } },
} satisfies Prisma.TaskInclude;

const TERMINAL: TaskStatus[] = ['DONE'];

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  private async visibleWhere(user: AuthUser): Promise<Prisma.TaskWhereInput> {
    const s = this.access.scope(user, 'tasks.view');
    if (s === 'all') return {};
    const mine: Prisma.TaskWhereInput[] = [{ assigneeId: user.id }, { createdById: user.id }];
    if (s === 'team') {
      const ids = await this.access.teamMemberIds(user);
      mine.push({ assigneeId: { in: ids } }, { teamId: { in: user.teamIds } });
    }
    return { OR: mine };
  }

  private async canManage(user: AuthUser, task: { createdById: string; assigneeId: string | null; teamId: string | null }) {
    if (task.createdById === user.id) return true;
    const s = this.access.scope(user, 'tasks.manage');
    if (s === 'all') return true;
    if (s === 'team') {
      if (task.teamId && user.teamIds.includes(task.teamId)) return true;
      return task.assigneeId ? (await this.access.teamMemberIds(user)).includes(task.assigneeId) : false;
    }
    return false;
  }

  private async load(user: AuthUser, id: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    const visible = await this.prisma.task.count({ where: { AND: [{ id }, await this.visibleWhere(user)] } });
    if (!visible) throw new NotFoundException('Task not found');
    const canManage = await this.canManage(user, task);
    const canWork = canManage || task.assigneeId === user.id;
    return { task, canManage, canWork };
  }

  private activity(tx: Prisma.TransactionClient | PrismaService, taskId: string, actorId: string, action: string, detail?: object) {
    return tx.taskActivity.create({ data: { taskId, actorId, action, detail: detail as Prisma.InputJsonValue } });
  }

  private async assertCanAssignTo(user: AuthUser, assigneeId: string | null | undefined) {
    if (!assigneeId || assigneeId === user.id) return;
    if (!user.permissions.has('tasks.create_for_others')) throw new ForbiddenException('You can only create tasks for yourself');
    const s = this.access.scope(user, 'tasks.manage');
    if (s === 'all') return;
    if (s === 'team' && (await this.access.teamMemberIds(user)).includes(assigneeId)) return;
    throw new ForbiddenException('You can only assign tasks to members of your team');
  }

  async list(user: AuthUser, q: TaskQuery) {
    const and: Prisma.TaskWhereInput[] = [await this.visibleWhere(user), { parentId: null }];
    if (q.assignee === 'me') and.push({ assigneeId: user.id });
    else if (q.assignee === 'unassigned') and.push({ assigneeId: null });
    else if (q.assignee) and.push({ assigneeId: q.assignee });
    if (q.createdByMe === 'true') and.push({ createdById: user.id });
    if (q.teamId) and.push({ teamId: q.teamId });
    if (q.leadId) and.push({ leadId: q.leadId });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.priority?.length) and.push({ priority: { in: q.priority } });
    if (q.search) {
      const n = Number(q.search.replace(/^PRS-/i, ''));
      and.push({ OR: [{ title: { contains: q.search, mode: 'insensitive' } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] });
    }
    const now = new Date();
    if (q.due === 'overdue') and.push({ dueAt: { lt: now }, status: { notIn: TERMINAL } });
    if (q.due === 'today') { const r = localDayRange(now); and.push({ dueAt: { gte: r.start, lt: r.end } }); }
    if (q.due === 'week') and.push({ dueAt: { gte: localDayRange(now).start, lt: addDays(localDayRange(now).start, 7) } });
    const tasks = await this.prisma.task.findMany({
      where: { AND: and }, include: listInclude, orderBy: [{ position: 'asc' }, { createdAt: 'desc' }], take: 1000,
    });
    return tasks.map(({ checklist, ...t }) => ({
      ...t,
      key: `PRS-${t.number}`,
      isOverdue: !!t.dueAt && t.dueAt < now && !TERMINAL.includes(t.status),
      checklistDone: checklist.filter((c) => c.done).length,
    }));
  }

  async get(user: AuthUser, id: string) {
    const { canManage, canWork } = await this.load(user, id);
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: {
        assignee: person, createdBy: person, team: { select: { id: true, name: true } },
        lead: { select: { id: true, fullName: true, phoneE164: true } },
        parent: { select: { id: true, number: true, title: true } },
        subtasks: { include: { assignee: person }, orderBy: { createdAt: 'asc' } },
        checklist: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
        comments: { include: { author: person }, orderBy: { createdAt: 'asc' } },
        attachments: { include: { uploadedBy: person }, orderBy: { createdAt: 'desc' } },
        activities: { include: { actor: person }, orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    return {
      ...task,
      key: `PRS-${task.number}`,
      subtasks: task.subtasks.map((s) => ({ ...s, key: `PRS-${s.number}` })),
      isOverdue: !!task.dueAt && task.dueAt < new Date() && !TERMINAL.includes(task.status),
      permissions: { canManage, canWork },
    };
  }

  async create(user: AuthUser, dto: CreateTaskDto) {
    const assigneeId = dto.assigneeId ?? (dto.teamId ? undefined : user.id);
    await this.assertCanAssignTo(user, assigneeId);
    if (dto.parentId) {
      const { canWork } = await this.load(user, dto.parentId);
      if (!canWork) throw new ForbiddenException('You cannot add subtasks here');
    }
    if (dto.leadId) await this.prisma.lead.findUniqueOrThrow({ where: { id: dto.leadId } });
    const max = await this.prisma.task.aggregate({ _max: { position: true }, where: { status: 'TODO' } });
    const task = await this.prisma.$transaction(async (tx) => {
      const t = await tx.task.create({
        data: {
          title: dto.title.trim(), description: dto.description, createdById: user.id, assigneeId: assigneeId ?? null,
          teamId: dto.teamId, leadId: dto.leadId, parentId: dto.parentId, priority: dto.priority ?? 'MEDIUM',
          startAt: dto.startAt ? new Date(dto.startAt) : null, dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
          requiresReview: dto.requiresReview ?? false, position: (max._max.position ?? 0) + 1000,
        },
      });
      await this.activity(tx, t.id, user.id, 'created');
      return t;
    });
    if (task.assigneeId && task.assigneeId !== user.id) {
      await this.notifications.notify(task.assigneeId, {
        type: 'task.assigned', title: `New task: PRS-${task.number} ${task.title}`,
        body: `${task.priority} priority, from ${user.fullName}`, link: `/tasks?open=${task.id}`,
      });
    }
    return task;
  }

  async update(user: AuthUser, id: string, dto: UpdateTaskDto) {
    const { task, canManage, canWork } = await this.load(user, id);
    const managerFields: (keyof UpdateTaskDto)[] = ['assigneeId', 'teamId', 'priority', 'dueAt', 'startAt', 'requiresReview', 'title'];
    if (!canWork) throw new ForbiddenException('You cannot edit this task');
    if (!canManage && managerFields.some((f) => dto[f] !== undefined)) {
      throw new ForbiddenException('Only the task creator or a manager can change these fields');
    }
    if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) await this.assertCanAssignTo(user, dto.assigneeId);
    const data: Prisma.TaskUncheckedUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const set = <K extends keyof Prisma.TaskUncheckedUpdateInput>(k: K, v: Prisma.TaskUncheckedUpdateInput[K], from: unknown) => {
      data[k] = v;
      changes[k as string] = { from, to: v };
    };
    if (dto.title !== undefined) set('title', dto.title.trim(), task.title);
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.assigneeId !== undefined) set('assigneeId', dto.assigneeId, task.assigneeId);
    if (dto.teamId !== undefined) set('teamId', dto.teamId, task.teamId);
    if (dto.leadId !== undefined) set('leadId', dto.leadId, task.leadId);
    if (dto.priority !== undefined) set('priority', dto.priority, task.priority);
    if (dto.startAt !== undefined) set('startAt', dto.startAt ? new Date(dto.startAt) : null, task.startAt);
    if (dto.dueAt !== undefined) { set('dueAt', dto.dueAt ? new Date(dto.dueAt) : null, task.dueAt); data.overdueNotified = false; }
    if (dto.requiresReview !== undefined) set('requiresReview', dto.requiresReview, task.requiresReview);
    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.task.update({ where: { id }, data });
      if (Object.keys(changes).length) await this.activity(tx, id, user.id, 'updated', changes);
      else if (dto.description !== undefined) await this.activity(tx, id, user.id, 'description_updated');
      return t;
    });
    if (dto.assigneeId && dto.assigneeId !== task.assigneeId && dto.assigneeId !== user.id) {
      await this.notifications.notify(dto.assigneeId, {
        type: 'task.assigned', title: `Task assigned to you: PRS-${task.number} ${updated.title}`, body: `By ${user.fullName}`, link: `/tasks?open=${id}`,
      });
    }
    return updated;
  }

  async move(user: AuthUser, id: string, dto: MoveDto) {
    const { task, canManage, canWork } = await this.load(user, id);
    if (!canWork) throw new ForbiddenException('You cannot move this task');
    // Tasks that need review go through REVIEW; only a manager can approve them to DONE.
    if (dto.status === 'DONE' && task.requiresReview && task.status !== 'DONE' && !(canManage && task.assigneeId !== user.id)) {
      throw new BadRequestException('This task needs manager review. Move it to Review instead.');
    }
    const statusChanged = dto.status !== task.status;
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: {
          status: dto.status,
          position: dto.position ?? task.position,
          completedAt: dto.status === 'DONE' ? task.completedAt ?? new Date() : null,
        },
      });
      if (statusChanged) await this.activity(tx, id, user.id, 'status_changed', { from: task.status, to: dto.status });
    });
    if (statusChanged && dto.status === 'REVIEW' && task.createdById !== user.id) {
      await this.notifications.notify(task.createdById, {
        type: 'task.review', title: `Ready for review: PRS-${task.number} ${task.title}`, body: `From ${user.fullName}`, link: `/tasks?open=${id}`,
      });
    }
    if (statusChanged && dto.status === 'BLOCKED' && task.createdById !== user.id) {
      await this.notifications.notify(task.createdById, {
        type: 'task.blocked', title: `Blocked: PRS-${task.number} ${task.title}`, body: `Marked by ${user.fullName}`, link: `/tasks?open=${id}`,
      });
    }
    return { ok: true };
  }

  async review(user: AuthUser, id: string, dto: ReviewDto) {
    const { task, canManage } = await this.load(user, id);
    if (!canManage) throw new ForbiddenException('Only the task creator or a manager can review');
    if (task.status !== 'REVIEW') throw new BadRequestException('Task is not waiting for review');
    if (dto.decision === 'reject' && !dto.note?.trim()) throw new BadRequestException('Add a note explaining what needs to change');
    const to: TaskStatus = dto.decision === 'approve' ? 'DONE' : 'IN_PROGRESS';
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id }, data: { status: to, reviewNote: dto.note, completedAt: to === 'DONE' ? new Date() : null } });
      await this.activity(tx, id, user.id, dto.decision === 'approve' ? 'review_approved' : 'review_rejected', { note: dto.note });
      if (dto.note?.trim()) await tx.taskComment.create({ data: { taskId: id, authorId: user.id, body: `Review ${dto.decision === 'approve' ? 'approved' : 'changes requested'}: ${dto.note.trim()}` } });
    });
    await this.notifications.notify(task.assigneeId, {
      type: 'task.reviewed',
      title: `${dto.decision === 'approve' ? 'Approved' : 'Changes requested'}: PRS-${task.number} ${task.title}`,
      body: dto.note, link: `/tasks?open=${id}`,
    });
    return { ok: true };
  }

  async remove(user: AuthUser, id: string) {
    const { task, canManage } = await this.load(user, id);
    if (!canManage) throw new ForbiddenException('Only the task creator or a manager can delete this task');
    const files = await this.prisma.attachment.findMany({ where: { task: { OR: [{ id }, { parentId: id }] } } });
    await this.prisma.task.delete({ where: { id } });
    for (const f of files) await this.storage.remove(f.storageKey);
    await this.audit.record({ actorId: user.id, action: 'task.deleted', entityType: 'task', entityId: id, before: { number: task.number, title: task.title } });
    return { ok: true };
  }

  async comment(user: AuthUser, id: string, body: string) {
    const { task } = await this.load(user, id);
    const c = await this.prisma.taskComment.create({ data: { taskId: id, authorId: user.id, body: body.trim() }, include: { author: person } });
    const notify = [task.assigneeId, task.createdById].filter((u): u is string => !!u && u !== user.id);
    await this.notifications.notifyMany(notify, {
      type: 'task.comment', title: `${user.fullName} commented on PRS-${task.number}`, body: body.slice(0, 140), link: `/tasks?open=${id}`,
    });
    return c;
  }

  async addChecklist(user: AuthUser, id: string, text: string) {
    const { canWork } = await this.load(user, id);
    if (!canWork) throw new ForbiddenException();
    const count = await this.prisma.taskChecklistItem.count({ where: { taskId: id } });
    return this.prisma.taskChecklistItem.create({ data: { taskId: id, text: text.trim(), position: count } });
  }

  async updateChecklist(user: AuthUser, id: string, itemId: string, dto: ChecklistUpdateDto) {
    const { canWork } = await this.load(user, id);
    if (!canWork) throw new ForbiddenException();
    const item = await this.prisma.taskChecklistItem.findFirst({ where: { id: itemId, taskId: id } });
    if (!item) throw new NotFoundException('Checklist item not found');
    return this.prisma.taskChecklistItem.update({ where: { id: itemId }, data: { text: dto.text, done: dto.done } });
  }

  async removeChecklist(user: AuthUser, id: string, itemId: string) {
    const { canWork } = await this.load(user, id);
    if (!canWork) throw new ForbiddenException();
    await this.prisma.taskChecklistItem.deleteMany({ where: { id: itemId, taskId: id } });
    return { ok: true };
  }

  async attach(user: AuthUser, id: string, file: Express.Multer.File) {
    const { canWork } = await this.load(user, id);
    if (!canWork) throw new ForbiddenException();
    this.storage.validate('attachment', file);
    const key = await this.storage.save('attachment', file.buffer, file.originalname, file.mimetype);
    const a = await this.prisma.attachment.create({
      data: { storageKey: key, fileName: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, uploadedById: user.id, taskId: id },
    });
    await this.activity(this.prisma, id, user.id, 'attachment_added', { fileName: a.fileName });
    return a;
  }

  /** Used by the attachments controller to authorise downloads. */
  async assertCanView(user: AuthUser, taskId: string) {
    await this.load(user, taskId);
  }

  async assertCanWork(user: AuthUser, taskId: string) {
    const { canWork } = await this.load(user, taskId);
    if (!canWork) throw new ForbiddenException();
  }
}

@Injectable()
export class TaskReminders {
  private log = new Logger('TaskReminders');
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async overdue() {
    try {
      const tasks = await this.prisma.task.findMany({
        where: { dueAt: { lt: new Date() }, status: { notIn: TERMINAL }, overdueNotified: false, assigneeId: { not: null } },
        take: 500,
      });
      for (const t of tasks) {
        await this.notifications.notify(t.assigneeId, { type: 'task.overdue', title: `Overdue task: PRS-${t.number} ${t.title}`, link: `/tasks?open=${t.id}` });
        await this.prisma.task.update({ where: { id: t.id }, data: { overdueNotified: true } });
      }
    } catch (e) {
      this.log.error(`Overdue check failed: ${(e as Error).message}`);
    }
  }
}

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private tasks: TasksService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: TaskQuery) { return this.tasks.list(u, q); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.tasks.get(u, id); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: CreateTaskDto) { return this.tasks.create(u, dto); }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) { return this.tasks.update(u, id, dto); }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.tasks.remove(u, id); }
  @Post(':id/move') move(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveDto) { return this.tasks.move(u, id, dto); }
  @Post(':id/review') review(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.tasks.review(u, id, dto); }
  @Post(':id/comments') comment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) { return this.tasks.comment(u, id, dto.body); }
  @Post(':id/checklist') addItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChecklistDto) { return this.tasks.addChecklist(u, id, dto.text); }
  @Patch(':id/checklist/:itemId') updItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: ChecklistUpdateDto) { return this.tasks.updateChecklist(u, id, itemId, dto); }
  @Delete(':id/checklist/:itemId') delItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) { return this.tasks.removeChecklist(u, id, itemId); }

  @Post(':id/attachments')
  @FileUpload()
  attach(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.tasks.attach(u, id, file);
  }
}

@Module({ providers: [TasksService, TaskReminders], controllers: [TasksController], exports: [TasksService, TaskReminders] })
export class TasksModule {}
