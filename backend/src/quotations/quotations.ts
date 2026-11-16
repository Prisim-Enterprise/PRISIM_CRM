import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max,
  MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { Prisma, QuotationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';

class ItemDto {
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(300, { each: true }) points: string[];
  @IsString() @MaxLength(50) qty: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) amount: number;
}

class QuotationDto {
  @IsOptional() @Matches(/^[A-Za-z0-9/_-]{1,30}$/, { message: 'Quotation number can use letters, numbers and / - _' }) number?: string;
  @IsDateString() date: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) validityDays?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsString() @MinLength(2) @MaxLength(200) clientName: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) address?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gstRate?: number;
  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(1000, { each: true }) terms: string[];
  @IsOptional() @IsEnum(QuotationStatus) status?: QuotationStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
}

class UpdateQuotationDto {
  @IsOptional() @Matches(/^[A-Za-z0-9/_-]{1,30}$/) number?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) validityDays?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) clientName?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) address?: string | null;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ItemDto) items?: ItemDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gstRate?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(1000, { each: true }) terms?: string[];
  @IsOptional() @IsEnum(QuotationStatus) status?: QuotationStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
}

class ListQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(QuotationStatus) status?: QuotationStatus;
}

const PREFIX = 'PR/DM/';
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const person = { select: { id: true, fullName: true } } as const;

type Item = { title: string; points: string[]; qty: string; amount: number };
function totals(items: Item[], gstRate: number) {
  const subtotal = round2(items.reduce((a, i) => a + Number(i.amount || 0), 0));
  const gst = round2((subtotal * gstRate) / 100);
  return { subtotal, gst, total: round2(subtotal + gst) };
}

@Injectable()
export class QuotationsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private shape(q: Prisma.QuotationGetPayload<{ include: { createdBy: typeof person; client: { select: { id: true; name: true } } } }>) {
    const gstRate = Number(q.gstRate);
    return { ...q, gstRate, ...totals(q.items as unknown as Item[], gstRate) };
  }

  /** The next number after the highest PR/DM/### so far (starting after 045, the last paper one). */
  async nextNumber() {
    const rows = await this.prisma.quotation.findMany({ where: { number: { startsWith: PREFIX } }, select: { number: true } });
    const max = Math.max(45, ...rows.map((r) => Number(r.number.slice(PREFIX.length))).filter((n) => Number.isFinite(n)));
    return { number: `${PREFIX}${String(max + 1).padStart(3, '0')}` };
  }

  async list(q: ListQuery) {
    const s = q.search?.trim();
    const rows = await this.prisma.quotation.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(s ? { OR: [{ number: { contains: s, mode: 'insensitive' } }, { clientName: { contains: s, mode: 'insensitive' } }] } : {}),
      },
      include: { createdBy: person, client: { select: { id: true, name: true } } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return rows.map((r) => this.shape(r));
  }

  async get(id: string) {
    const q = await this.prisma.quotation.findUnique({ where: { id }, include: { createdBy: person, client: { select: { id: true, name: true } } } });
    if (!q) throw new NotFoundException('Quotation not found');
    return this.shape(q);
  }

  private async checkClient(clientId?: string | null) {
    if (clientId && !(await this.prisma.client.count({ where: { id: clientId } }))) throw new BadRequestException('That client does not exist');
  }

  async create(u: AuthUser, dto: QuotationDto) {
    await this.checkClient(dto.clientId);
    const number = dto.number?.trim() || (await this.nextNumber()).number;
    try {
      const q = await this.prisma.quotation.create({
        data: {
          number, date: day(dto.date), validityDays: dto.validityDays ?? 15, clientId: dto.clientId ?? null,
          clientName: dto.clientName.trim(), address: dto.address?.trim() || null,
          items: dto.items as unknown as Prisma.InputJsonValue, gstRate: dto.gstRate ?? 18,
          terms: dto.terms.map((t) => t.trim()).filter(Boolean), status: dto.status ?? 'DRAFT', notes: dto.notes, createdById: u.id,
        },
        include: { createdBy: person, client: { select: { id: true, name: true } } },
      });
      const shaped = this.shape(q);
      await this.audit.record({ actorId: u.id, action: 'quotation.created', entityType: 'quotation', entityId: q.id, after: { number, client: q.clientName, total: shaped.total } });
      return shaped;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException(`Quotation number ${number} is already used`);
      throw e;
    }
  }

  async update(u: AuthUser, id: string, dto: UpdateQuotationDto) {
    const before = await this.prisma.quotation.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Quotation not found');
    await this.checkClient(dto.clientId);
    try {
      const q = await this.prisma.quotation.update({
        where: { id },
        data: {
          number: dto.number?.trim(), date: dto.date ? day(dto.date) : undefined, validityDays: dto.validityDays, clientId: dto.clientId,
          clientName: dto.clientName?.trim(), address: dto.address === undefined ? undefined : dto.address?.trim() || null,
          items: dto.items as unknown as Prisma.InputJsonValue | undefined, gstRate: dto.gstRate,
          terms: dto.terms ? dto.terms.map((t) => t.trim()).filter(Boolean) : undefined, status: dto.status, notes: dto.notes,
        },
        include: { createdBy: person, client: { select: { id: true, name: true } } },
      });
      const shaped = this.shape(q);
      await this.audit.record({
        actorId: u.id, action: dto.status && dto.status !== before.status ? 'quotation.status_changed' : 'quotation.updated', entityType: 'quotation', entityId: id,
        before: { number: before.number, status: before.status }, after: { number: q.number, status: q.status, total: shaped.total },
      });
      return shaped;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException(`Quotation number ${dto.number} is already used`);
      throw e;
    }
  }

  async duplicate(u: AuthUser, id: string) {
    const q = await this.get(id);
    return this.create(u, {
      date: new Date().toISOString().slice(0, 10), validityDays: q.validityDays, clientId: q.clientId, clientName: q.clientName, address: q.address,
      items: q.items as unknown as ItemDto[], gstRate: q.gstRate, terms: q.terms as unknown as string[], status: 'DRAFT', notes: q.notes,
    });
  }

  async remove(u: AuthUser, id: string) {
    const q = await this.prisma.quotation.findUnique({ where: { id } });
    if (!q) throw new NotFoundException('Quotation not found');
    await this.prisma.quotation.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'quotation.deleted', entityType: 'quotation', entityId: id, before: { number: q.number, client: q.clientName } });
    return { deleted: true };
  }
}

@ApiTags('Quotations')
@ApiBearerAuth()
@Controller('quotations')
export class QuotationsController {
  constructor(private svc: QuotationsService) {}

  @Get() @RequireAny('quotations.manage') list(@Query() q: ListQuery) { return this.svc.list(q); }
  @Get('next-number') @RequireAny('quotations.manage') next() { return this.svc.nextNumber(); }
  @Get(':id') @RequireAny('quotations.manage') get(@Param('id', ParseUUIDPipe) id: string) { return this.svc.get(id); }
  @Post() @RequireAny('quotations.manage') create(@CurrentUser() u: AuthUser, @Body() dto: QuotationDto) { return this.svc.create(u, dto); }
  @Patch(':id') @RequireAny('quotations.manage') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateQuotationDto) { return this.svc.update(u, id, dto); }
  @Post(':id/duplicate') @RequireAny('quotations.manage') duplicate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.duplicate(u, id); }
  @Delete(':id') @RequireAny('quotations.manage') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.remove(u, id); }
}

@Module({ providers: [QuotationsService], controllers: [QuotationsController] })
export class QuotationsModule {}
