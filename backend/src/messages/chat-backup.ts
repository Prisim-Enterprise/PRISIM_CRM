import { BadRequestException, Controller, Get, Headers, Injectable, NotFoundException, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { APP_TZ } from '../common/time';

// The chat backup: every Team chat message ever sent, kept after the weekly reset.
// Super Admin only (permission chat.backup.view).

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONVERSATION = new RegExp(`^(everyone|dm:${UUID}:${UUID})$`, 'i');

/** "everyone", or "dm:<id>:<id>" with the two ids in a fixed order so both directions are one conversation. */
export function conversationKey(senderId: string, recipientId: string | null) {
  if (!recipientId) return 'everyone';
  const [a, b] = [senderId, recipientId].sort();
  return `dm:${a}:${b}`;
}

export function conversationWhere(key: string): Prisma.ChatArchiveWhereInput {
  if (key === 'everyone') return { recipientId: null };
  const [, a, b] = key.split(':');
  return { OR: [{ senderId: a, recipientId: b }, { senderId: b, recipientId: a }] };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
const local = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString('en-IN', { timeZone: APP_TZ, ...opts });

class BackupQuery {
  @Matches(CONVERSATION, { message: 'Pick a conversation' }) conversation: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(500) pageSize?: number;
}
class SearchAllQuery {
  @IsString() @MaxLength(100) search: string;
}

@Injectable()
export class ChatBackupService {
  constructor(private prisma: PrismaService, private storage: StorageService, private audit: AuditService) {}

  /** Every conversation in the backup, newest activity first, with the names as they were last seen. */
  async conversations() {
    const [everyone, pairs, senders, recipients] = await Promise.all([
      this.prisma.chatArchive.aggregate({ where: { recipientId: null }, _count: true, _min: { createdAt: true }, _max: { createdAt: true } }),
      this.prisma.chatArchive.groupBy({ by: ['senderId', 'recipientId'], where: { recipientId: { not: null } }, _count: true, _min: { createdAt: true }, _max: { createdAt: true } }),
      this.prisma.chatArchive.findMany({ distinct: ['senderId'], orderBy: { createdAt: 'desc' }, select: { senderId: true, senderName: true } }),
      this.prisma.chatArchive.findMany({ where: { recipientId: { not: null } }, distinct: ['recipientId'], orderBy: { createdAt: 'desc' }, select: { recipientId: true, recipientName: true } }),
    ]);
    const names = new Map<string, string>();
    for (const r of recipients) if (r.recipientId && r.recipientName) names.set(r.recipientId, r.recipientName);
    for (const s of senders) names.set(s.senderId, s.senderName);
    const dms = new Map<string, { key: string; people: { id: string; name: string }[]; count: number; first: Date; last: Date }>();
    for (const p of pairs) {
      const key = conversationKey(p.senderId, p.recipientId);
      const [, a, b] = key.split(':');
      const row = dms.get(key) ?? { key, people: [a, b].map((id) => ({ id, name: names.get(id) ?? 'Former user' })), count: 0, first: p._min.createdAt!, last: p._max.createdAt! };
      row.count += p._count;
      if (p._min.createdAt! < row.first) row.first = p._min.createdAt!;
      if (p._max.createdAt! > row.last) row.last = p._max.createdAt!;
      dms.set(key, row);
    }
    const list = [...dms.values()].map((d) => ({ ...d, label: d.people.map((p) => p.name).sort().join(' ↔ ') }));
    if (everyone._count) list.push({ key: 'everyone', label: 'Everyone (group)', people: [], count: everyone._count, first: everyone._min.createdAt!, last: everyone._max.createdAt! });
    return list.sort((a, b) => b.last.getTime() - a.last.getTime());
  }

  private where(q: BackupQuery): Prisma.ChatArchiveWhereInput {
    const range = q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {};
    const s = q.search?.trim();
    return { AND: [conversationWhere(q.conversation), range, s ? { body: { contains: s, mode: 'insensitive' } } : {}] };
  }

  async messages(u: AuthUser, q: BackupQuery) {
    const pageSize = q.pageSize ?? 200;
    const page = q.page ?? 1;
    const where = this.where(q);
    const [items, total] = await Promise.all([
      this.prisma.chatArchive.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), // newest first
      this.prisma.chatArchive.count({ where }),
    ]);
    // Reading other people's messages is recorded.
    await this.audit.record({ actorId: u.id, action: 'chat_backup.viewed', entityType: 'chat_archive', after: { conversation: q.conversation, page } });
    return {
      total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      items: items.map(({ audioKey, ...m }) => ({ ...m, hasAudio: !!audioKey })),
    };
  }

  /** Finds a phrase in every conversation at once. */
  async searchAll(q: SearchAllQuery) {
    const s = q.search.trim();
    if (s.length < 2) throw new BadRequestException('Type at least 2 letters');
    const rows = await this.prisma.chatArchive.findMany({ where: { body: { contains: s, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(({ audioKey: _a, ...m }) => ({ ...m, conversation: conversationKey(m.senderId, m.recipientId) }));
  }

  async audio(id: string, res: Response, range?: string) {
    const m = await this.prisma.chatArchive.findUnique({ where: { id } });
    if (!m?.audioKey) throw new NotFoundException('Voice message not found');
    return this.storage.send(res, m.audioKey, m.audioType ?? 'audio/webm', range);
  }

  async exportCsv(u: AuthUser, q: BackupQuery) {
    const rows = await this.prisma.chatArchive.findMany({ where: this.where(q), orderBy: { createdAt: 'asc' }, take: 50_000 });
    await this.audit.record({ actorId: u.id, action: 'chat_backup.exported', entityType: 'chat_archive', after: { conversation: q.conversation, rows: rows.length } });
    const body = '﻿' + [
      ['Date', 'Time', 'From', 'To', 'Type', 'Message', 'Voice length (s)', 'Unsent by sender'],
      ...rows.map((m) => [
        local(m.createdAt, { year: 'numeric', month: '2-digit', day: '2-digit' }), local(m.createdAt, { hour: '2-digit', minute: '2-digit' }),
        m.senderName, m.recipientName ?? 'Everyone', m.kind === 'VOICE' ? 'Voice' : 'Text', m.body ?? '', m.durationSec ?? '', m.unsentAt ? 'yes' : '',
      ]),
    ].map((r) => r.map(csvCell).join(',')).join('\r\n');
    return { name: `prisim-chat-${q.conversation === 'everyone' ? 'everyone' : 'direct'}-${new Date().toISOString().slice(0, 10)}.csv`, body };
  }
}

@ApiTags('Team chat backup')
@ApiBearerAuth()
@Controller('chat-backup')
export class ChatBackupController {
  constructor(private svc: ChatBackupService) {}

  @Get('conversations') @RequireAny('chat.backup.view') conversations() { return this.svc.conversations(); }
  @Get('messages') @RequireAny('chat.backup.view') messages(@CurrentUser() u: AuthUser, @Query() q: BackupQuery) { return this.svc.messages(u, q); }
  @Get('search') @RequireAny('chat.backup.view') search(@Query() q: SearchAllQuery) { return this.svc.searchAll(q); }
  @Get('export') @RequireAny('chat.backup.view')
  async export(@CurrentUser() u: AuthUser, @Query() q: BackupQuery, @Res() res: Response) {
    const { name, body } = await this.svc.exportCsv(u, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  }
  @Get(':id/audio') @RequireAny('chat.backup.view')
  audio(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response, @Headers('range') range?: string) { return this.svc.audio(id, res, range); }
}
