import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Injectable, Logger, Module, NotFoundException,
  Param, ParseUUIDPipe, Post, Query, Res, UploadedFile,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser, CurrentUser } from '../common/current-user';
import { StorageService } from '../common/storage.service';
import { FileUpload } from '../common/file-upload';

/** A conversation: "everyone", or the other person's user id. */
const TO = /^(everyone|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

class ThreadQuery {
  @Matches(TO, { message: 'with must be "everyone" or a user id' }) with: string;
  @IsOptional() @IsDateString() after?: string;
}
class TextDto {
  @Matches(TO, { message: 'to must be "everyone" or a user id' }) to: string;
  @IsString() @MinLength(1) @MaxLength(4000) body: string;
}
/** Path parameters, so a large recording can still arrive through the staged-upload query string. */
class VoiceParams {
  @Matches(TO, { message: 'to must be "everyone" or a user id' }) to: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(300) durationSec: number;
}
class IncomingQuery {
  @IsOptional() @IsDateString() after?: string;
}
class ReadDto {
  @Matches(TO) with: string;
}

const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const VOICE_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav'];
const IST_OFFSET_MS = 330 * 60_000; // India has no daylight saving, so a fixed offset is exact.

/** Monday 00:00 India time at the start of the current week. Everything older is deleted. */
export function weekStart(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysSinceMonday) - IST_OFFSET_MS);
}
const nextReset = (now = new Date()) => new Date(weekStart(now).getTime() + 7 * 86_400_000);

const person = { select: { id: true, fullName: true } } as const;

@Injectable()
export class MessagesService {
  private log = new Logger('Messages');
  private lastPurge = 0;
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  /** Where clause for one conversation, limited to this week. */
  private thread(u: AuthUser, withKey: string): Prisma.MessageWhereInput {
    const since = { createdAt: { gte: weekStart() } };
    if (withKey === 'everyone') return { ...since, recipientId: null };
    return { ...since, OR: [{ senderId: u.id, recipientId: withKey }, { senderId: withKey, recipientId: u.id }] };
  }

  private async assertPerson(u: AuthUser, id: string) {
    if (id === u.id) throw new BadRequestException("You can't message yourself");
    if (!(await this.prisma.user.count({ where: { id, isActive: true, deletedAt: null } }))) throw new BadRequestException('That person is not active in the CRM');
  }

  /**
   * Deletes last week's messages and voice files. Runs from the scheduler and, so the reset
   * never depends on it, at most every 10 minutes when someone opens Mic.
   */
  async purge(force = false) {
    if (!force && Date.now() - this.lastPurge < 10 * 60_000) return { deleted: 0 };
    this.lastPurge = Date.now();
    const before = weekStart();
    const old = await this.prisma.message.findMany({ where: { createdAt: { lt: before } }, select: { audioKey: true } });
    if (!old.length) return { deleted: 0 };
    const { count } = await this.prisma.message.deleteMany({ where: { createdAt: { lt: before } } });
    for (const m of old) if (m.audioKey) await this.storage.remove(m.audioKey).catch(() => undefined);
    this.log.log(`Weekly reset: deleted ${count} messages`);
    return { deleted: count };
  }

  async threads(u: AuthUser) {
    await this.purge().catch((e) => this.log.error(`Purge failed: ${(e as Error).message}`));
    const since = { createdAt: { gte: weekStart() } };
    const unreadFor = { reads: { none: { userId: u.id } }, senderId: { not: u.id } };
    const [everyoneLast, everyoneUnread, direct, directUnread] = await Promise.all([
      this.prisma.message.findFirst({ where: { ...since, recipientId: null }, orderBy: { createdAt: 'desc' }, include: { sender: person } }),
      this.prisma.message.count({ where: { ...since, recipientId: null, ...unreadFor } }),
      // Newest first, so the first message seen per person is their latest.
      this.prisma.message.findMany({
        where: { ...since, recipientId: { not: null }, OR: [{ senderId: u.id }, { recipientId: u.id }] },
        orderBy: { createdAt: 'desc' }, include: { sender: person, recipient: person }, take: 5000,
      }),
      this.prisma.message.groupBy({ by: ['senderId'], where: { ...since, recipientId: u.id, ...unreadFor }, _count: true }),
    ]);
    const summary = (m: { kind: string; body: string | null; durationSec: number | null; createdAt: Date; senderId: string; sender: { fullName: string } }) => ({
      kind: m.kind, body: m.body, durationSec: m.durationSec, at: m.createdAt, mine: m.senderId === u.id, senderName: m.sender.fullName,
    });
    const people = new Map<string, { user: { id: string; fullName: string }; last: ReturnType<typeof summary>; unread: number }>();
    for (const m of direct) {
      const other = m.senderId === u.id ? m.recipient! : m.sender;
      if (!people.has(other.id)) people.set(other.id, { user: other, last: summary(m), unread: directUnread.find((g) => g.senderId === other.id)?._count ?? 0 });
    }
    return {
      resetsAt: nextReset(),
      everyone: { last: everyoneLast ? summary(everyoneLast) : null, unread: everyoneUnread },
      people: [...people.values()],
    };
  }

  async list(u: AuthUser, q: ThreadQuery) {
    if (q.with !== 'everyone' && q.with === u.id) throw new BadRequestException("You can't message yourself");
    const where: Prisma.MessageWhereInput = { AND: [this.thread(u, q.with), ...(q.after ? [{ createdAt: { gt: new Date(q.after) } }] : [])] };
    const rows = await this.prisma.message.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 300,
      include: { sender: person, reads: { select: { userId: true, readAt: true } } },
    });
    return rows.reverse().map(({ audioKey, audioType, reads, ...m }) => ({
      ...m,
      hasAudio: !!audioKey,
      mine: m.senderId === u.id,
      // Direct: whether the other person has seen it. Everyone: how many have.
      seenBy: m.senderId === u.id ? reads.filter((r) => r.userId !== u.id).length : undefined,
    }));
  }

  async markRead(u: AuthUser, withKey: string) {
    const unread = await this.prisma.message.findMany({
      where: { AND: [this.thread(u, withKey), { senderId: { not: u.id }, reads: { none: { userId: u.id } } }] }, select: { id: true },
    });
    if (unread.length) await this.prisma.messageRead.createMany({ data: unread.map((m) => ({ messageId: m.id, userId: u.id })), skipDuplicates: true });
    return { read: unread.length };
  }

  /**
   * Messages to this person (or to everyone) from others since `after`, for the popups.
   * Without `after` it only returns the server's time, so popups start from now.
   */
  async incoming(u: AuthUser, after?: string) {
    const now = new Date();
    if (!after) return { now, items: [] };
    const since = new Date(Math.max(new Date(after).getTime(), weekStart().getTime(), now.getTime() - 10 * 60_000));
    const items = await this.prisma.message.findMany({
      where: { createdAt: { gt: since, lte: now }, senderId: { not: u.id }, OR: [{ recipientId: u.id }, { recipientId: null }] },
      orderBy: { createdAt: 'asc' }, take: 20,
      select: { id: true, kind: true, body: true, durationSec: true, createdAt: true, recipientId: true, sender: person },
    });
    return { now, items: items.map(({ body, ...m }) => ({ ...m, preview: body ? body.slice(0, 140) : null, everyone: m.recipientId === null })) };
  }

  async unread(u: AuthUser) {
    const count = await this.prisma.message.count({
      where: { createdAt: { gte: weekStart() }, senderId: { not: u.id }, reads: { none: { userId: u.id } }, OR: [{ recipientId: u.id }, { recipientId: null }] },
    });
    return { count };
  }

  async sendText(u: AuthUser, dto: TextDto) {
    if (dto.to !== 'everyone') await this.assertPerson(u, dto.to);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Type a message first');
    return this.prisma.message.create({
      data: { senderId: u.id, recipientId: dto.to === 'everyone' ? null : dto.to, kind: 'TEXT', body }, include: { sender: person },
    });
  }

  async sendVoice(u: AuthUser, q: VoiceParams, file?: Express.Multer.File) {
    if (q.to !== 'everyone') await this.assertPerson(u, q.to);
    if (!file?.size) throw new BadRequestException('No recording received');
    if (file.size > MAX_VOICE_BYTES) throw new BadRequestException('Voice messages can be up to 10 MB');
    const type = file.mimetype.split(';')[0].trim().toLowerCase();
    if (!VOICE_TYPES.includes(type)) throw new BadRequestException(`Recording type ${type || 'unknown'} is not supported`);
    const ext = type === 'audio/mp4' || type === 'audio/x-m4a' ? '.m4a' : type === 'audio/mpeg' ? '.mp3' : `.${type.split('/')[1]}`;
    const key = await this.storage.save('voice', file.buffer, `voice${ext}`, type);
    try {
      return await this.prisma.message.create({
        data: { senderId: u.id, recipientId: q.to === 'everyone' ? null : q.to, kind: 'VOICE', audioKey: key, audioType: type, durationSec: q.durationSec },
        include: { sender: person },
      });
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async audio(u: AuthUser, id: string, res: Response, range?: string) {
    const m = await this.prisma.message.findFirst({
      where: { id, createdAt: { gte: weekStart() }, OR: [{ recipientId: null }, { senderId: u.id }, { recipientId: u.id }] },
    });
    if (!m?.audioKey) throw new NotFoundException('Voice message not found');
    return this.storage.send(res, m.audioKey, m.audioType ?? 'audio/webm', range);
  }

  /** Unsend: the sender can delete their own message. */
  async remove(u: AuthUser, id: string) {
    const m = await this.prisma.message.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Message not found');
    if (m.senderId !== u.id) throw new ForbiddenException('You can only delete messages you sent');
    await this.prisma.message.delete({ where: { id } });
    if (m.audioKey) await this.storage.remove(m.audioKey).catch(() => undefined);
    return { deleted: true };
  }
}

@Injectable()
export class MessagesReset {
  constructor(private messages: MessagesService) {}
  /** Monday 00:00 India time (18:30 UTC on Sunday). On Vercel, /internal/tick and opening Mic do this instead. */
  @Cron('30 18 * * 0')
  run() { return this.messages.purge(true); }
}

@ApiTags('Team chat')
@ApiBearerAuth()
@Controller('messages')
export class MessagesController {
  constructor(private svc: MessagesService) {}

  @Get('threads') threads(@CurrentUser() u: AuthUser) { return this.svc.threads(u); }
  @Get('unread') unread(@CurrentUser() u: AuthUser) { return this.svc.unread(u); }
  @Get('incoming') incoming(@CurrentUser() u: AuthUser, @Query() q: IncomingQuery) { return this.svc.incoming(u, q.after); }
  @Get() list(@CurrentUser() u: AuthUser, @Query() q: ThreadQuery) { return this.svc.list(u, q); }
  @Post('read') read(@CurrentUser() u: AuthUser, @Body() dto: ReadDto) { return this.svc.markRead(u, dto.with); }
  @Post() text(@CurrentUser() u: AuthUser, @Body() dto: TextDto) { return this.svc.sendText(u, dto); }

  @Post('voice/:to/:durationSec')
  @FileUpload(MAX_VOICE_BYTES)
  voice(@CurrentUser() u: AuthUser, @Param() p: VoiceParams, @UploadedFile() file: Express.Multer.File) { return this.svc.sendVoice(u, p, file); }

  @Get(':id/audio')
  audio(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response, @Headers('range') range?: string) {
    return this.svc.audio(u, id, res, range);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }
}

@Module({ providers: [MessagesService, MessagesReset], controllers: [MessagesController], exports: [MessagesService] })
export class MessagesModule {}
