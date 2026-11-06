import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Injectable, Logger, Module,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res, UnauthorizedException, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CallDirection, CallStatus, Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, Public } from '../common/current-user';
import { StorageService, MAX_UPLOAD_BYTES } from '../common/storage.service';
import { PageQuery, paged, skipTake } from '../common/pagination';
import { addDays, parseLocalDate } from '../common/time';
import { maskPhone } from '../common/phone';
import { LeadsModule } from '../leads/leads.controller';
import { LeadsService } from '../leads/leads.service';
import { CALL_OUTCOMES, CONNECTED_OUTCOMES, isClosed, statusForCallOutcome } from '../leads/lead-status';
import { CallEvent, TELEPHONY_PROVIDER, TelephonyProvider } from './telephony/provider';
import { ExotelProvider } from './telephony/exotel.provider';
import { MockProvider } from './telephony/mock.provider';

class NextFollowUpDto {
  @IsDateString() dueAt: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class LogCallDto {
  @IsUUID() leadId: string;
  @IsOptional() @IsIn(['OUTBOUND', 'INBOUND']) direction?: CallDirection;
  @IsOptional() @IsDateString() startedAt?: string;
  @IsOptional() @IsInt() @Min(0) @Max(36000) durationSeconds?: number;
  @IsIn(CALL_OUTCOMES) outcome: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @ValidateNested() @Type(() => NextFollowUpDto) nextFollowUp?: NextFollowUpDto;
}

class DispositionDto {
  @IsIn(CALL_OUTCOMES) outcome: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @ValidateNested() @Type(() => NextFollowUpDto) nextFollowUp?: NextFollowUpDto;
}

class ClickToCallDto {
  @IsUUID() leadId: string;
}

class CallQuery extends PageQuery {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsUUID() leadId?: string;
  @IsOptional() @IsString() outcome?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['true', 'false']) hasRecording?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

const callInclude = {
  user: { select: { id: true, fullName: true } },
  lead: { select: { id: true, fullName: true, phoneE164: true, status: true } },
} satisfies Prisma.CallLogInclude;

@Injectable()
export class CallsService {
  private log = new Logger('Calls');
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private audit: AuditService,
    private storage: StorageService,
    private leads: LeadsService,
    @Inject(TELEPHONY_PROVIDER) private provider: TelephonyProvider,
  ) {}

  providerInfo() {
    return { provider: this.provider.name, configured: this.provider.isConfigured(), simulated: this.provider.name === 'mock' };
  }

  async list(user: AuthUser, q: CallQuery) {
    const ids = await this.access.userIdsInScope(user, 'calls.view');
    const and: Prisma.CallLogWhereInput[] = [ids === null ? {} : { userId: { in: ids } }];
    if (q.userId === 'me') and.push({ userId: user.id });
    else if (q.userId) and.push({ userId: q.userId });
    if (q.leadId) and.push({ leadId: q.leadId });
    if (q.outcome) and.push({ outcome: q.outcome });
    if (q.hasRecording === 'true') and.push({ OR: [{ recordingKey: { not: null } }, { recordingUrl: { not: null } }] });
    if (q.from) and.push({ createdAt: { gte: parseLocalDate(q.from) } });
    if (q.to) and.push({ createdAt: { lt: addDays(parseLocalDate(q.to), 1) } });
    if (q.search) {
      const digits = q.search.replace(/\D/g, '');
      and.push({ lead: { OR: [{ fullName: { contains: q.search, mode: 'insensitive' } }, ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : [])] } });
    }
    const where = { AND: and };
    const recScope = await this.access.userIdsInScope(user, 'calls.recordings');
    const [items, total] = await this.prisma.$transaction([
      this.prisma.callLog.findMany({ where, include: callInclude, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.callLog.count({ where }),
    ]);
    return paged(
      items.map(({ recordingUrl, recordingKey, ...c }) => ({
        ...c,
        hasRecording: !!(recordingKey || recordingUrl),
        canPlayRecording: recScope === null || recScope.includes(c.userId),
      })),
      total, q,
    );
  }

  async get(user: AuthUser, id: string) {
    const call = await this.prisma.callLog.findUnique({
      where: { id },
      include: { ...callInclude, lead: { select: { ...callInclude.lead.select, assignedUserId: true } } },
    });
    if (!call) throw new NotFoundException('Call not found');
    // Visible if the call is in the user's call scope, or the lead is visible to them.
    const inCallScope = await this.access.canActOnOwner(user, 'calls.view', call.userId);
    const leadVisible = await this.access.canActOnOwner(user, 'leads.view', call.lead.assignedUserId);
    if (!inCallScope && !leadVisible) throw new ForbiddenException();
    const { recordingKey, recordingUrl, ...rest } = call;
    return { ...rest, hasRecording: !!(recordingKey || recordingUrl) };
  }

  private async applyOutcome(tx: Prisma.TransactionClient, user: AuthUser, leadId: string, outcome: string, notes?: string, next?: NextFollowUpDto) {
    await this.leads.advance(tx, leadId, statusForCallOutcome(outcome), user.id, `Call outcome: ${outcome}`);
    if (CONNECTED_OUTCOMES.includes(outcome)) await tx.lead.update({ where: { id: leadId }, data: { lastContactedAt: new Date() } });
    if (notes?.trim()) await tx.leadNote.create({ data: { leadId, authorId: user.id, body: `[Call: ${outcome}] ${notes.trim()}` } });
    if (next) {
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
      await tx.followUp.create({
        data: { leadId, ownerId: lead.assignedUserId ?? user.id, createdById: user.id, dueAt: new Date(next.dueAt), type: next.type ?? 'call', note: next.note },
      });
      await this.leads.advance(tx, leadId, 'FOLLOW_UP_REQUIRED', user.id, 'Follow-up scheduled after call');
    }
  }

  /** Manual call log: employee called from their own phone and records what happened. */
  async logManual(user: AuthUser, dto: LogCallDto) {
    const lead = await this.leads.getLeadForEdit(user, dto.leadId);
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { phone: true } });
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date();
    const answered = CONNECTED_OUTCOMES.includes(dto.outcome);
    const direction = dto.direction ?? 'OUTBOUND';
    const call = await this.prisma.$transaction(async (tx) => {
      const c = await tx.callLog.create({
        data: {
          leadId: lead.id, userId: user.id, provider: 'manual', direction,
          fromNumber: direction === 'OUTBOUND' ? me.phone : lead.phoneE164,
          toNumber: direction === 'OUTBOUND' ? lead.phoneE164 : me.phone,
          status: answered ? 'COMPLETED' : dto.outcome === 'BUSY' ? 'BUSY' : 'NO_ANSWER',
          startedAt, durationSeconds: dto.durationSeconds,
          endedAt: dto.durationSeconds ? new Date(startedAt.getTime() + dto.durationSeconds * 1000) : undefined,
          outcome: dto.outcome, notes: dto.notes,
        },
        include: callInclude,
      });
      // Call notes live on the call itself; follow-ups are only scheduled on open leads.
      await this.applyOutcome(tx, user, lead.id, dto.outcome, undefined, isClosed(lead.status) ? undefined : dto.nextFollowUp);
      return c;
    });
    return call;
  }

  /** Click-to-call through the telephony provider. Rings the employee first, then the customer. */
  async clickToCall(user: AuthUser, leadId: string) {
    const lead = await this.leads.getLeadForEdit(user, leadId);
    if (!lead.phoneE164) throw new BadRequestException('This lead has no valid phone number');
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { phone: true } });
    if (!me.phone) throw new BadRequestException('Add your phone number to your profile first. The provider rings you before connecting the customer.');
    if (!this.provider.isConfigured()) throw new BadRequestException('Telephony is not configured. Ask an admin to set it up.');

    const call = await this.prisma.callLog.create({
      data: {
        leadId, userId: user.id, provider: this.provider.name, direction: 'OUTBOUND', status: 'INITIATED',
        fromNumber: me.phone, toNumber: lead.phoneE164, startedAt: new Date(),
      },
    });
    const secret = process.env.TELEPHONY_WEBHOOK_SECRET || '';
    const base = (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
    try {
      const res = await this.provider.startCall({
        agentNumber: me.phone,
        customerNumber: lead.phoneE164,
        statusCallbackUrl: `${base}/api/v1/telephony/webhooks/${this.provider.name}?token=${encodeURIComponent(secret)}`,
        deliver: (e) => this.applyEvent(this.provider.name, e).catch((err) => this.log.error(err.message)),
      });
      await this.prisma.callLog.update({ where: { id: call.id }, data: { providerCallId: res.providerCallId } });
    } catch (e) {
      await this.prisma.callLog.update({ where: { id: call.id }, data: { status: 'FAILED', endedAt: new Date() } });
      throw e;
    }
    this.log.log(`Call ${call.id} started by ${user.id} to ${maskPhone(lead.phoneE164)}`);
    return this.prisma.callLog.findUniqueOrThrow({ where: { id: call.id }, include: callInclude });
  }

  /** Applies a provider event once (idempotent on provider + event id). */
  async applyEvent(provider: string, e: CallEvent) {
    try {
      await this.prisma.webhookEvent.create({ data: { provider, eventId: e.eventId, payload: (e.raw ?? {}) as Prisma.InputJsonValue } });
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') return; // duplicate delivery
      throw err;
    }
    const call = await this.prisma.callLog.findUnique({ where: { provider_providerCallId: { provider, providerCallId: e.providerCallId } } });
    if (!call) {
      await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider, eventId: e.eventId } }, data: { error: 'Unknown call' } });
      return;
    }
    // Don't let a late "ringing" event overwrite a final status.
    const terminal: CallStatus[] = ['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED'];
    const keepStatus = terminal.includes(call.status) && !terminal.includes(e.status);
    let recordingKey: string | undefined;
    if (e.recordingBuffer) recordingKey = await this.storage.save('recording', e.recordingBuffer, 'call.wav');
    await this.prisma.callLog.update({
      where: { id: call.id },
      data: {
        status: keepStatus ? undefined : e.status,
        startedAt: e.startedAt ?? undefined,
        endedAt: e.endedAt ?? undefined,
        durationSeconds: e.durationSeconds ?? undefined,
        recordingUrl: e.recordingUrl ?? undefined,
        recordingKey: recordingKey ?? undefined,
      },
    });
    // Unanswered provider calls count as a contact attempt even if the employee forgets the disposition.
    if (terminal.includes(e.status)) {
      await this.prisma.$transaction((tx) => this.leads.advance(tx, call.leadId, 'CONTACT_ATTEMPTED', call.userId, 'Call attempted'));
    }
    if (e.recordingUrl && !recordingKey) void this.archiveRecording(call.id, e.recordingUrl);
    await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider, eventId: e.eventId } }, data: { processedAt: new Date() } });
  }

  /** Copies the provider recording into private storage so it outlives provider retention. */
  private async archiveRecording(callId: string, url: string) {
    try {
      const { buffer, contentType } = await this.provider.fetchRecording(url);
      const ext = contentType.includes('wav') ? '.wav' : '.mp3';
      const key = await this.storage.save('recording', buffer, `call${ext}`);
      await this.prisma.callLog.update({ where: { id: callId }, data: { recordingKey: key } });
    } catch (e) {
      this.log.warn(`Recording archive failed for call ${callId}: ${(e as Error).message}`);
    }
  }

  async setDisposition(user: AuthUser, id: string, dto: DispositionDto) {
    const call = await this.prisma.callLog.findUnique({ where: { id }, include: { lead: true } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.userId !== user.id) await this.leads.getLeadForEdit(user, call.leadId);
    await this.prisma.$transaction(async (tx) => {
      await tx.callLog.update({ where: { id }, data: { outcome: dto.outcome, notes: dto.notes } });
      if (!isClosed(call.lead.status)) await this.applyOutcome(tx, user, call.leadId, dto.outcome, undefined, dto.nextFollowUp);
    });
    return this.prisma.callLog.findUniqueOrThrow({ where: { id }, include: callInclude });
  }

  async uploadRecording(user: AuthUser, id: string, file: Express.Multer.File) {
    this.storage.validate('recording', file);
    const call = await this.prisma.callLog.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('Call not found');
    if (call.userId !== user.id) await this.leads.getLeadForEdit(user, call.leadId);
    const key = await this.storage.save('recording', file.buffer, file.originalname);
    if (call.recordingKey) await this.storage.remove(call.recordingKey);
    await this.prisma.callLog.update({ where: { id }, data: { recordingKey: key } });
    await this.audit.record({ actorId: user.id, action: 'call.recording_uploaded', entityType: 'call', entityId: id });
    return { ok: true };
  }

  async streamRecording(user: AuthUser, id: string, res: Response, range?: string) {
    const call = await this.prisma.callLog.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('Call not found');
    await this.access.assertCanActOnOwner(user, 'calls.recordings', call.userId, 'You are not allowed to listen to this recording');
    await this.audit.record({ actorId: user.id, action: 'call.recording_played', entityType: 'call', entityId: id });
    if (call.recordingKey) {
      const ext = call.recordingKey.split('.').pop();
      const mime = ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : ext === 'webm' ? 'audio/webm' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
      return this.storage.send(res, call.recordingKey, mime, range);
    }
    if (call.recordingUrl) {
      const { buffer, contentType } = await this.provider.fetchRecording(call.recordingUrl);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(buffer);
    }
    throw new NotFoundException('No recording for this call');
  }
}

@ApiTags('Calls')
@ApiBearerAuth()
@Controller()
export class CallsController {
  constructor(private calls: CallsService) {}

  @Get('calls')
  list(@CurrentUser() user: AuthUser, @Query() q: CallQuery) {
    return this.calls.list(user, q);
  }

  @Get('calls/provider')
  provider() {
    return this.calls.providerInfo();
  }

  @Get('calls/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.get(user, id);
  }

  @Get('leads/:id/calls')
  forLead(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: CallQuery) {
    return this.calls.list(user, { ...q, leadId: id });
  }

  @Post('calls')
  log(@CurrentUser() user: AuthUser, @Body() dto: LogCallDto) {
    return this.calls.logManual(user, dto);
  }

  @Post('calls/click-to-call')
  clickToCall(@CurrentUser() user: AuthUser, @Body() dto: ClickToCallDto) {
    return this.calls.clickToCall(user, dto.leadId);
  }

  @Patch('calls/:id/disposition')
  disposition(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DispositionDto) {
    return this.calls.setDisposition(user, id, dto);
  }

  @Post('calls/:id/recording')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.calls.uploadRecording(user, id, file);
  }

  @Get('calls/:id/recording')
  recording(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response, @Headers('range') range?: string) {
    return this.calls.streamRecording(user, id, res, range);
  }
}

/** Public webhook endpoint for provider status callbacks, authenticated by a shared secret. */
@ApiTags('Telephony webhooks')
@Controller('telephony/webhooks')
export class TelephonyWebhookController {
  private log = new Logger('TelephonyWebhook');
  constructor(private calls: CallsService, @Inject(TELEPHONY_PROVIDER) private provider: TelephonyProvider) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') provider: string, @Query('token') token: string, @Body() body: Record<string, unknown>) {
    const secret = process.env.TELEPHONY_WEBHOOK_SECRET || '';
    const a = Buffer.from(token || '');
    const b = Buffer.from(secret);
    if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    if (provider !== this.provider.name) throw new BadRequestException('Unknown provider');
    const events = this.provider.parseWebhook(body ?? {});
    for (const e of events) await this.calls.applyEvent(provider, e);
    this.log.log(`Processed ${events.length} ${provider} event(s)`);
    return { ok: true };
  }
}

@Module({
  imports: [LeadsModule],
  providers: [
    CallsService,
    {
      provide: TELEPHONY_PROVIDER,
      useFactory: (): TelephonyProvider => (process.env.TELEPHONY_PROVIDER === 'exotel' ? new ExotelProvider() : new MockProvider()),
    },
  ],
  controllers: [CallsController, TelephonyWebhookController],
})
export class CallsModule {}
