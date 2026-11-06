import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, } from '@nestjs/common';
import { FileUpload } from '../common/file-upload';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { FeedbackKind, FeedbackStatus, Prisma, TaskPriority } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { MAX_UPLOAD_BYTES, StorageService } from '../common/storage.service';
import { PageQuery, paged, skipTake } from '../common/pagination';
import { TasksModule, TasksService } from '../tasks/tasks';
import { ClientsModule, ClientsService } from '../clients/clients';

export const FEEDBACK_CATEGORIES = [
  'Work issue', 'Technical issue', 'Process improvement', 'Management', 'Collaboration', 'Suggestion', 'HR / Policy query', 'Other',
];

class CreateFeedbackDto {
  @IsEnum(FeedbackKind) kind: FeedbackKind;
  @IsIn(FEEDBACK_CATEGORIES) category: string;
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(5) @MaxLength(10000) description: string;
  @IsOptional() @IsBoolean() isAnonymous?: boolean;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
}

class ResponseDto {
  @IsString() @MinLength(1) @MaxLength(10000) body: string;
  @IsOptional() @IsBoolean() isInternal?: boolean;
  @IsOptional() @IsEnum(FeedbackStatus) status?: FeedbackStatus;
}

class AdminUpdateDto {
  @IsOptional() @IsEnum(FeedbackStatus) status?: FeedbackStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() assignedAdminId?: string | null;
  @IsOptional() @IsEnum(TaskPriority) priority?: TaskPriority;
}

class FeedbackQuery extends PageQuery {
  @IsOptional() @IsEnum(FeedbackStatus) status?: FeedbackStatus;
  @IsOptional() @IsIn(['open', 'closed']) state?: string;
  @IsOptional() @IsEnum(FeedbackKind) kind?: FeedbackKind;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() assigned?: string; // "me" | "unassigned" | id
  @IsOptional() @IsString() search?: string;
}

const OPEN: FeedbackStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'];
const person = { select: { id: true, fullName: true } } as const;

@Injectable()
export class FeedbackService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  /** Keyed hash linking an anonymous submission to its author without storing who they are. */
  private hash(userId: string) {
    return createHmac('sha256', process.env.FEEDBACK_HASH_SECRET || 'dev-secret').update(userId).digest('hex');
  }

  private isOwner(user: AuthUser, f: { submittedById: string | null; submitterHash: string | null }) {
    return f.submittedById === user.id || (!!f.submitterHash && f.submitterHash === this.hash(user.id));
  }

  /** Strips identity from anonymous items before they leave the server. */
  private present<T extends { isAnonymous: boolean; submittedBy?: unknown; submittedById: string | null; submitterHash: string | null }>(f: T) {
    const { submitterHash: _h, ...rest } = f;
    return f.isAnonymous ? { ...rest, submittedById: null, submittedBy: null } : rest;
  }

  async create(user: AuthUser, dto: CreateFeedbackDto) {
    const anon = !!dto.isAnonymous;
    const f = await this.prisma.feedback.create({
      data: {
        kind: dto.kind, category: dto.category, subject: dto.subject.trim(), description: dto.description.trim(),
        priority: dto.priority ?? 'MEDIUM', isAnonymous: anon,
        submittedById: anon ? null : user.id,
        submitterHash: anon ? this.hash(user.id) : null,
      },
    });
    // Anonymous submissions are not audited with an actor, so the audit log can't reveal the author.
    await this.audit.record({ actorId: anon ? null : user.id, action: 'feedback.submitted', entityType: 'feedback', entityId: f.id, after: { kind: f.kind, anonymous: anon } });
    const admins = (await this.notifications.usersWithPermission('feedback.manage')).filter((id) => anon || id !== user.id);
    await this.notifications.notifyMany(admins, {
      type: 'feedback.new',
      title: `New ${dto.kind === 'QUERY' ? 'query' : 'feedback'}: ${f.subject}`,
      body: anon ? `${dto.category} · anonymous` : `${dto.category} · from ${user.fullName}`,
      link: `/feedback/${f.id}`,
    });
    return this.present(f);
  }

  async mine(user: AuthUser, q: FeedbackQuery) {
    const where: Prisma.FeedbackWhereInput = {
      OR: [{ submittedById: user.id }, { submitterHash: this.hash(user.id) }],
      ...(q.state === 'open' ? { status: { in: OPEN } } : q.state === 'closed' ? { status: { notIn: OPEN } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where, orderBy: { updatedAt: 'desc' }, ...skipTake(q),
        include: { _count: { select: { responses: { where: { isInternal: false } } } } },
      }),
      this.prisma.feedback.count({ where }),
    ]);
    return paged(items.map((f) => this.present(f)), total, q);
  }

  async adminList(q: FeedbackQuery, user: AuthUser) {
    const and: Prisma.FeedbackWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.state === 'open') and.push({ status: { in: OPEN } });
    if (q.state === 'closed') and.push({ status: { notIn: OPEN } });
    if (q.kind) and.push({ kind: q.kind });
    if (q.category) and.push({ category: q.category });
    if (q.assigned === 'me') and.push({ assignedAdminId: user.id });
    else if (q.assigned === 'unassigned') and.push({ assignedAdminId: null });
    else if (q.assigned) and.push({ assignedAdminId: q.assigned });
    if (q.search) and.push({ OR: [{ subject: { contains: q.search, mode: 'insensitive' } }, { description: { contains: q.search, mode: 'insensitive' } }] });
    const where = { AND: and };
    const [items, total, counts] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where, orderBy: [{ updatedAt: 'desc' }], ...skipTake(q),
        include: { submittedBy: person, assignedAdmin: person, _count: { select: { responses: true } } },
      }),
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.groupBy({ by: ['status'], _count: true, orderBy: { status: 'asc' } }),
    ]);
    return { ...paged(items.map((f) => this.present(f)), total, q), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  async get(user: AuthUser, id: string) {
    const f = await this.prisma.feedback.findUnique({
      where: { id },
      include: {
        submittedBy: person, assignedAdmin: person,
        responses: { include: { author: person }, orderBy: { createdAt: 'asc' } },
        attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
      },
    });
    if (!f) throw new NotFoundException('Not found');
    const isAdmin = user.permissions.has('feedback.view.all');
    const isOwner = this.isOwner(user, f);
    if (!isAdmin && !isOwner) throw new NotFoundException('Not found');
    const responses = f.responses
      .filter((r) => isAdmin || !r.isInternal)
      // Anonymous submitter replies have no author; show them as "Submitter".
      .map((r) => ({ ...r, author: r.fromSubmitter && f.isAnonymous ? null : r.author }));
    return {
      ...this.present({ ...f, responses }),
      viewer: { isAdmin, isOwner, canManage: user.permissions.has('feedback.manage') },
    };
  }

  async respond(user: AuthUser, id: string, dto: ResponseDto) {
    const f = await this.prisma.feedback.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Not found');
    const canManage = user.permissions.has('feedback.manage');
    const isOwner = this.isOwner(user, f);
    if (!canManage && !isOwner) throw new NotFoundException('Not found');
    const asSubmitter = isOwner && !canManage ? true : isOwner && !dto.isInternal && !dto.status;
    if (asSubmitter && (dto.isInternal || dto.status)) throw new ForbiddenException('Only admins can add internal notes or change status');
    if (!OPEN.includes(f.status) && asSubmitter) throw new BadRequestException('This item is closed');

    const response = await this.prisma.$transaction(async (tx) => {
      const r = await tx.feedbackResponse.create({
        data: {
          feedbackId: id, body: dto.body.trim(), isInternal: !!dto.isInternal && !asSubmitter,
          fromSubmitter: asSubmitter, authorId: asSubmitter && f.isAnonymous ? null : user.id,
          statusChange: dto.status && dto.status !== f.status ? dto.status : null,
        },
      });
      const newStatus = dto.status ?? (!asSubmitter && !dto.isInternal && f.status === 'SUBMITTED' ? 'UNDER_REVIEW' : undefined);
      await tx.feedback.update({
        where: { id },
        data: {
          updatedAt: new Date(),
          ...(newStatus ? { status: newStatus, resolvedAt: newStatus === 'RESOLVED' || newStatus === 'CLOSED' ? new Date() : null } : {}),
          ...(!asSubmitter && !f.assignedAdminId ? { assignedAdminId: user.id } : {}),
        },
      });
      return r;
    });

    if (!asSubmitter && !dto.isInternal) {
      // Notify the submitter. For anonymous items we can't look up the user; they see it under "My feedback".
      if (f.submittedById) {
        await this.notifications.notify(f.submittedById, {
          type: 'feedback.response', title: `Reply to your ${f.kind === 'QUERY' ? 'query' : 'feedback'}: ${f.subject}`, link: `/feedback/${id}`,
        });
      }
    } else if (asSubmitter) {
      const target = f.assignedAdminId ? [f.assignedAdminId] : await this.notifications.usersWithPermission('feedback.manage');
      await this.notifications.notifyMany(target.filter((t) => f.isAnonymous || t !== user.id), {
        type: 'feedback.reply', title: `New reply on: ${f.subject}`, link: `/feedback/${id}`,
      });
    }
    return response;
  }

  async adminUpdate(user: AuthUser, id: string, dto: AdminUpdateDto) {
    const f = await this.prisma.feedback.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Not found');
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.status && dto.status !== f.status) {
        await tx.feedbackResponse.create({
          data: { feedbackId: id, authorId: user.id, body: `Status changed to ${dto.status.replace('_', ' ').toLowerCase()}`, statusChange: dto.status },
        });
      }
      return tx.feedback.update({
        where: { id },
        data: {
          status: dto.status,
          priority: dto.priority,
          assignedAdminId: dto.assignedAdminId,
          ...(dto.status ? { resolvedAt: dto.status === 'RESOLVED' || dto.status === 'CLOSED' ? new Date() : null } : {}),
        },
      });
    });
    await this.audit.record({ actorId: user.id, action: 'feedback.updated', entityType: 'feedback', entityId: id, before: { status: f.status, assignedAdminId: f.assignedAdminId }, after: dto });
    if (dto.assignedAdminId && dto.assignedAdminId !== user.id && dto.assignedAdminId !== f.assignedAdminId) {
      await this.notifications.notify(dto.assignedAdminId, { type: 'feedback.assigned', title: `Assigned to you: ${f.subject}`, link: `/feedback/${id}` });
    }
    if (dto.status && dto.status !== f.status && f.submittedById) {
      await this.notifications.notify(f.submittedById, {
        type: 'feedback.status', title: `"${f.subject}" is now ${dto.status.replace('_', ' ').toLowerCase()}`, link: `/feedback/${id}`,
      });
    }
    return this.present(updated);
  }

  async attach(user: AuthUser, id: string, file: Express.Multer.File) {
    const f = await this.prisma.feedback.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Not found');
    if (!this.isOwner(user, f) && !user.permissions.has('feedback.manage')) throw new NotFoundException('Not found');
    this.storage.validate('attachment', file);
    const key = await this.storage.save('attachment', file.buffer, file.originalname, file.mimetype);
    // Anonymous: generic file name, no uploader, so the file record can't identify the author.
    const anonymousUpload = f.isAnonymous && this.isOwner(user, f);
    const ext = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '';
    return this.prisma.attachment.create({
      data: {
        storageKey: key, mimeType: file.mimetype, sizeBytes: file.size, feedbackId: id,
        fileName: anonymousUpload ? `attachment${ext}` : file.originalname.slice(0, 200),
        uploadedById: anonymousUpload ? null : user.id,
      },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
  }

  async assertCanView(user: AuthUser, feedbackId: string) {
    const f = await this.prisma.feedback.findUnique({ where: { id: feedbackId } });
    if (!f || (!this.isOwner(user, f) && !user.permissions.has('feedback.view.all'))) throw new NotFoundException('Not found');
  }
}

@ApiTags('Feedback')
@ApiBearerAuth()
@Controller()
export class FeedbackController {
  constructor(private svc: FeedbackService) {}

  @Get('feedback/categories') categories() { return FEEDBACK_CATEGORIES; }
  @Post('feedback') create(@CurrentUser() u: AuthUser, @Body() dto: CreateFeedbackDto) { return this.svc.create(u, dto); }
  @Get('feedback/mine') mine(@CurrentUser() u: AuthUser, @Query() q: FeedbackQuery) { return this.svc.mine(u, q); }
  @Get('feedback/:id') get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u, id); }
  @Post('feedback/:id/responses') respond(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResponseDto) { return this.svc.respond(u, id, dto); }

  @Post('feedback/:id/attachments')
  @FileUpload()
  attach(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.attach(u, id, file);
  }

  @Get('admin/feedback')
  @RequireAny('feedback.view.all')
  adminList(@CurrentUser() u: AuthUser, @Query() q: FeedbackQuery) { return this.svc.adminList(q, u); }

  @Patch('admin/feedback/:id')
  @RequireAny('feedback.manage')
  adminUpdate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminUpdateDto) { return this.svc.adminUpdate(u, id, dto); }
}

/** Authorised download of task, feedback and client-work attachments. */
@ApiTags('Attachments')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private tasks: TasksService,
    private feedback: FeedbackService,
    private clients: ClientsService,
  ) {}

  private async authorise(user: AuthUser, id: string, write = false) {
    const a = await this.prisma.attachment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('File not found');
    if (a.taskId) await (write ? this.tasks.assertCanWork(user, a.taskId) : this.tasks.assertCanView(user, a.taskId));
    else if (a.feedbackId) {
      await this.feedback.assertCanView(user, a.feedbackId);
      if (write && !user.permissions.has('feedback.manage') && a.uploadedById !== user.id) throw new ForbiddenException();
    } else if (a.clientWorkId) {
      await (write ? this.clients.assertCanWork(user, a.clientWorkId, a.uploadedById) : this.clients.assertCanView(user, a.clientWorkId));
    } else throw new NotFoundException('File not found');
    return a;
  }

  @Get(':id')
  async download(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response, @Headers('range') range?: string) {
    const a = await this.authorise(u, id);
    const inline = a.mimeType.startsWith('image/') || a.mimeType === 'application/pdf';
    return this.storage.send(res, a.storageKey, a.mimeType, range, inline ? undefined : a.fileName);
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.authorise(u, id, true);
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(a.storageKey);
    return { ok: true };
  }
}

@Module({ imports: [TasksModule, ClientsModule], providers: [FeedbackService], controllers: [FeedbackController, AttachmentsController] })
export class FeedbackModule {}
