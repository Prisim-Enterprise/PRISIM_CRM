import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UploadedFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { AcctExpenseStatus, AcctPaymentMethod, AcctProjectStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { FileUpload } from '../common/file-upload';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { localDateKey } from '../common/time';

// ───────────────────────── Shared ─────────────────────────

const MANAGE = 'accounting.manage';
const SUBMIT = 'accounting.expenses.submit';
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const today = () => localDateKey(new Date());
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
const csv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
const csvList = ({ value }: { value: unknown }) =>
  value == null || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean);

const RECEIPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

const isManager = (u: AuthUser) => u.permissions.has(MANAGE);
function assertCanSubmit(u: AuthUser) {
  if (!isManager(u) && !u.permissions.has(SUBMIT)) throw new ForbiddenException('You do not have access to accounting');
}

// ───────────────────────── Settings ─────────────────────────

export interface AcctSettingsData {
  companyName: string; tagline: string; address: string; phone: string; email: string; website: string;
  gstin: string; stateCode: string;
  bank: { accountName: string; accountNumber: string; ifsc: string; bankName: string; upiId: string };
  invoicePrefix: string; invoiceDueDays: number; fyStartMonth: number; invoiceTerms: string[];
  /** HSN/SAC filled in on new invoice lines (998365: advertising services). */
  defaultHsn: string;
}

export const DEFAULT_SETTINGS: AcctSettingsData = {
  // As on Prisim's tax invoice.
  companyName: 'Prisim',
  tagline: 'Digital Marketing | Advertising | Lead Generation | Business Growth | Software Development',
  address: 'No.21, Ramachandra Arcad\n3rd Floor, MSRE Road\nBangalore - 560 054.',
  phone: '9742502964',
  email: 'varuncena12@gmail.com',
  website: 'www.prisim.co.in',
  gstin: '29CROPV8759A1ZX',
  stateCode: '29',
  bank: { accountName: '', accountNumber: '', ifsc: '', bankName: '', upiId: '' },
  invoicePrefix: '',
  invoiceDueDays: 15,
  fyStartMonth: 4,
  invoiceTerms: [],
  defaultHsn: '998365',
};

class BankDto {
  @IsString() @MaxLength(120) accountName: string;
  @IsString() @MaxLength(40) accountNumber: string;
  @IsString() @MaxLength(20) ifsc: string;
  @IsString() @MaxLength(120) bankName: string;
  @IsString() @MaxLength(80) upiId: string;
}

class SettingsDto {
  @IsString() @MinLength(1) @MaxLength(120) companyName: string;
  @IsString() @MaxLength(300) tagline: string;
  @IsString() @MaxLength(600) address: string;
  @IsString() @MaxLength(40) phone: string;
  @IsString() @MaxLength(120) email: string;
  @IsString() @MaxLength(120) website: string;
  @Matches(/^$|^[0-9A-Z]{15}$/, { message: 'GSTIN is 15 letters and numbers' }) gstin: string;
  @Matches(/^\d{2}$/, { message: 'State code is two digits (Karnataka is 29)' }) stateCode: string;
  @ValidateNested() @Type(() => BankDto) bank: BankDto;
  @Matches(/^[A-Za-z0-9]{0,8}$/, { message: 'Invoice prefix: up to 8 letters or numbers' }) invoicePrefix: string;
  @Matches(/^[0-9A-Za-z]{0,10}$/, { message: 'HSN/SAC is up to 10 letters or numbers' }) defaultHsn: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(365) invoiceDueDays: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) fyStartMonth: number;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(600, { each: true }) invoiceTerms: string[];
}

// ───────────────────────── Categories ─────────────────────────

class CategoryDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() parentId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) monthlyBudget?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999_999) annualBudget?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
  @IsOptional() @IsBoolean() archived?: boolean;
}
class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) monthlyBudget?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999_999) annualBudget?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
  @IsOptional() @IsBoolean() archived?: boolean;
}
class MonthQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) month?: string;
}

// ───────────────────────── Expenses ─────────────────────────

class ExpenseDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount: number;
  @IsDateString() dateIncurred: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() datePaid?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  /** Typed vendor/payee name: matched to an existing vendor or added. Empty clears it. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) vendorName?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsEnum(AcctExpenseStatus) status?: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) reviewComment?: string | null;
}
class UpdateExpenseDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount?: number;
  @IsOptional() @IsDateString() dateIncurred?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() datePaid?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) vendorName?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsEnum(AcctExpenseStatus) status?: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) reviewComment?: string | null;
}
class ReviewDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
  @IsEnum(AcctExpenseStatus) status: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) comment?: string | null;
}
class DeleteManyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
}
const SORTS = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc', 'created_desc'] as const;
class ExpenseQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(csvList) @IsArray() @IsEnum(AcctExpenseStatus, { each: true }) status?: AcctExpenseStatus[];
  @IsOptional() @IsString() categoryId?: string; // a uuid, or "none"
  @IsOptional() @IsString() vendorId?: string; // a uuid, or "none"
  @IsOptional() @IsString() projectId?: string; // a uuid, or "none"
  @IsOptional() @IsUUID() submittedById?: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @IsOptional() @IsIn(['yes', 'no']) receipt?: 'yes' | 'no';
  @IsOptional() @IsIn(SORTS as unknown as string[]) sort?: (typeof SORTS)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
class ReceiptParams {
  @IsUUID() id: string;
}

// ───────────────────────── Projects ─────────────────────────

class ProjectDto {
  @IsUUID() clientId: string;
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() meetingDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootStart?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootEnd?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) quotedAmount?: number | null;
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
class UpdateProjectDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() meetingDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootStart?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootEnd?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) quotedAmount?: number | null;
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
class ProjectQuery {
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
class PaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount: number;
  @IsDateString() paidOn: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) method?: AcctPaymentMethod;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) note?: string | null;
}

// ───────────────────────── Invoices ─────────────────────────

class InvoiceItemDto {
  @IsString() @MinLength(1) @MaxLength(1000) description: string;
  @IsOptional() @Matches(/^[0-9A-Za-z]{0,10}$/, { message: 'HSN/SAC is up to 10 letters or numbers' }) hsn?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1_000_000) qty: number;
  @IsOptional() @IsString() @MaxLength(15) unit?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) rate: number;
}
class InvoiceExtraDto {
  @IsOptional() @IsString() @MaxLength(120) deliveryNote?: string;
  @IsOptional() @IsString() @MaxLength(120) referenceNo?: string;
  @IsOptional() @IsString() @MaxLength(120) otherReferences?: string;
  @IsOptional() @IsString() @MaxLength(120) buyerOrderNo?: string;
  @IsOptional() @IsString() @MaxLength(40) buyerOrderDate?: string;
  @IsOptional() @IsString() @MaxLength(120) dispatchDocNo?: string;
  @IsOptional() @IsString() @MaxLength(40) deliveryNoteDate?: string;
  @IsOptional() @IsString() @MaxLength(120) dispatchedThrough?: string;
  @IsOptional() @IsString() @MaxLength(120) destination?: string;
  @IsOptional() @IsString() @MaxLength(300) termsOfDelivery?: string;
}
class ShipToDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(600) address?: string;
  @IsOptional() @Matches(/^$|^[0-9A-Za-z]{15}$/, { message: 'Consignee GSTIN is 15 letters and numbers' }) gstin?: string;
  @IsOptional() @Matches(/^$|^\d{2}$/) stateCode?: string;
}
class ClientDetailsDto {
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @ValidateIf((_, v) => !!v) @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @Matches(/^$|^[0-9A-Za-z]{15}$/, { message: 'Client GSTIN is 15 letters and numbers' }) gstin?: string;
  @IsOptional() @IsString() @MaxLength(600) address?: string;
  /** GST state code of the buyer when there's no GSTIN to read it from. */
  @IsOptional() @Matches(/^$|^\d{2}$/) stateCode?: string;
}
class InvoiceDto {
  @IsOptional() @Matches(/^[A-Za-z0-9/_-]{1,30}$/, { message: 'Invoice number can use letters, numbers and / - _' }) number?: string;
  @IsDateString() date: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsString() @MinLength(2) @MaxLength(200) clientName: string;
  @ValidateNested() @Type(() => ClientDetailsDto) clientDetails: ClientDetailsDto;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => InvoiceItemDto) items: InvoiceItemDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) discount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gstRate?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(600, { each: true }) terms: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) preparedBy?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  @IsOptional() @IsBoolean() cancelled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => InvoiceExtraDto) extra?: InvoiceExtraDto;
  @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => ShipToDto) shipTo?: ShipToDto | null;
}
class UpdateInvoiceDto {
  @IsOptional() @Matches(/^[A-Za-z0-9/_-]{1,30}$/, { message: 'Invoice number can use letters, numbers and / - _' }) number?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) clientName?: string;
  @IsOptional() @ValidateNested() @Type(() => ClientDetailsDto) clientDetails?: ClientDetailsDto;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => InvoiceItemDto) items?: InvoiceItemDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) discount?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) gstRate?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(600, { each: true }) terms?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) preparedBy?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  @IsOptional() @IsBoolean() cancelled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => InvoiceExtraDto) extra?: InvoiceExtraDto;
  @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => ShipToDto) shipTo?: ShipToDto | null;
}
class InvoiceQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['paid', 'partial', 'unpaid', 'overdue', 'cancelled']) status?: string;
  @IsOptional() @IsUUID() clientId?: string;
}
class NextNumberQuery {
  @IsOptional() @IsDateString() date?: string;
}
class LedgerQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
}

type InvoiceItem = { description: string; hsn?: string; qty: number; unit?: string; rate: number };
type ClientDetails = { contactPerson?: string; phone?: string; email?: string; gstin?: string; address?: string; stateCode?: string };

/** Totals for an invoice. Inside the company's state: CGST + SGST; another state (by GSTIN): IGST. */
export function invoiceTotals(inv: { items: InvoiceItem[]; discount: number; gstRate: number; clientDetails: ClientDetails }, stateCode: string, paid: number) {
  const subtotal = r2(inv.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0));
  const discount = Math.min(subtotal, Math.max(0, r2(Number(inv.discount) || 0)));
  const taxable = r2(subtotal - discount);
  const fromGstin = (inv.clientDetails.gstin ?? '').trim().slice(0, 2);
  const clientState = /^\d{2}$/.test(fromGstin) ? fromGstin : (inv.clientDetails.stateCode ?? '');
  const igst = /^\d{2}$/.test(clientState) && clientState !== stateCode;
  const rate = Number(inv.gstRate) || 0;
  const half = igst ? 0 : r2((taxable * rate) / 200);
  const igstAmt = igst ? r2((taxable * rate) / 100) : 0;
  const gst = r2(half * 2 + igstAmt);
  const total = r2(taxable + gst);
  return { subtotal, discount, taxable, split: igst ? 'igst' : 'cgst_sgst', cgst: half, sgst: half, igst: igstAmt, gst, total, paid: r2(paid), balance: r2(Math.max(0, total - paid)) };
}

/** Financial year label: Nov 2026 → "2026-27", Feb 2027 → "2026-27". */
const fyLabel = (isoDate: string, fyStart: number) => {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= fyStart ? y : y - 1;
  return fyStart === 1 ? String(start) : `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

const person = { select: { id: true, fullName: true } } as const;
const expenseInclude = {
  category: { select: { id: true, name: true, parentId: true, parent: { select: { id: true, name: true } } } },
  vendor: { select: { id: true, name: true } },
  project: { select: { id: true, title: true, client: { select: { id: true, name: true } } } },
  submittedBy: person,
  reviewedBy: person,
} satisfies Prisma.AcctExpenseInclude;
type ExpenseRow = Prisma.AcctExpenseGetPayload<{ include: typeof expenseInclude }>;

const invoiceInclude = {
  payments: { orderBy: { paidOn: 'asc' } },
  client: { select: { id: true, name: true } },
  project: { select: { id: true, title: true } },
  quotation: { select: { id: true, number: true } },
  createdBy: person,
} satisfies Prisma.AcctInvoiceInclude;
type InvoiceRow = Prisma.AcctInvoiceGetPayload<{ include: typeof invoiceInclude }>;

// ───────────────────────── Service ─────────────────────────

@Injectable()
export class AccountingService {
  constructor(private prisma: PrismaService, private audit: AuditService, private storage: StorageService) {}

  // ── Settings ──
  async settings(): Promise<AcctSettingsData> {
    const row = await this.prisma.acctSettings.findUnique({ where: { id: 1 } });
    const data = (row?.data ?? {}) as Partial<AcctSettingsData>;
    return { ...DEFAULT_SETTINGS, ...data, bank: { ...DEFAULT_SETTINGS.bank, ...(data.bank ?? {}) } };
  }

  async saveSettings(u: AuthUser, dto: SettingsDto) {
    const data = { ...dto, gstin: dto.gstin.trim().toUpperCase(), invoiceTerms: dto.invoiceTerms.map((t) => t.trim()).filter(Boolean) };
    await this.prisma.acctSettings.upsert({
      where: { id: 1 }, create: { id: 1, data: data as unknown as Prisma.InputJsonValue }, update: { data: data as unknown as Prisma.InputJsonValue },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.settings_updated', entityType: 'accounting', after: { companyName: data.companyName, invoicePrefix: data.invoicePrefix } });
    return this.settings();
  }

  // ── Lookups for forms ──
  async lookups(u: AuthUser) {
    assertCanSubmit(u);
    const [categories, vendors, projects] = await Promise.all([
      this.prisma.acctCategory.findMany({ where: { archived: false }, select: { id: true, name: true, parentId: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.acctVendor.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.acctProject.findMany({
        where: { status: { not: 'CANCELLED' } }, select: { id: true, title: true, status: true, client: { select: { name: true } } }, orderBy: { createdAt: 'desc' },
      }),
    ]);
    const tags = isManager(u)
      ? await this.prisma.$queryRaw<{ tag: string }[]>`SELECT DISTINCT unnest("tags") AS tag FROM "acct_expenses" ORDER BY 1 LIMIT 300`
      : [];
    return {
      categories, vendors, tags: tags.map((t) => t.tag),
      projects: projects.map((p) => ({ id: p.id, title: p.title, status: p.status, clientName: p.client.name })),
      canManage: isManager(u),
    };
  }

  // ── Categories & budgets ──
  async categories(q: MonthQuery) {
    const s = await this.settings();
    const month = q.month ?? today().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const monthFrom = day(`${month}-01`);
    const monthTo = new Date(Date.UTC(y, m, 1));
    const fyYear = m >= s.fyStartMonth ? y : y - 1;
    const fyFrom = new Date(Date.UTC(fyYear, s.fyStartMonth - 1, 1));
    const fyTo = new Date(Date.UTC(fyYear + 1, s.fyStartMonth - 1, 1));
    const settled = { in: ['APPROVED', 'PAID'] as AcctExpenseStatus[] };
    const [cats, monthSpend, yearSpend, counts] = await Promise.all([
      this.prisma.acctCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], where: { status: settled, dateIncurred: { gte: monthFrom, lt: monthTo } }, _sum: { amount: true } }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], where: { status: settled, dateIncurred: { gte: fyFrom, lt: fyTo } }, _sum: { amount: true } }),
      this.prisma.acctExpense.groupBy({ by: ['categoryId'], _count: true }),
    ]);
    const mm = new Map(monthSpend.map((r) => [r.categoryId, num(r._sum.amount)]));
    const yy = new Map(yearSpend.map((r) => [r.categoryId, num(r._sum.amount)]));
    const cc = new Map(counts.map((r) => [r.categoryId, r._count]));
    return {
      month, fiscalYear: { from: iso(fyFrom), to: iso(new Date(fyTo.getTime() - 86400000)) },
      uncategorized: { month: mm.get(null) ?? 0, year: yy.get(null) ?? 0 },
      categories: cats.map((c) => ({
        id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder, archived: c.archived,
        monthlyBudget: c.monthlyBudget == null ? null : num(c.monthlyBudget), annualBudget: c.annualBudget == null ? null : num(c.annualBudget),
        spentMonth: mm.get(c.id) ?? 0, spentYear: yy.get(c.id) ?? 0, expenseCount: cc.get(c.id) ?? 0,
      })),
    };
  }

  private async assertUniqueCategory(name: string, parentId: string | null, exceptId?: string) {
    const clash = await this.prisma.acctCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, parentId, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new ConflictException(`"${name}" already exists here`);
  }

  async createCategory(u: AuthUser, dto: CategoryDto) {
    const name = dto.name.trim();
    const parentId = dto.parentId ?? null;
    if (parentId) {
      const parent = await this.prisma.acctCategory.findUnique({ where: { id: parentId } });
      if (!parent) throw new BadRequestException('That parent category does not exist');
      if (parent.parentId) throw new BadRequestException('Subcategories cannot have their own subcategories');
    }
    await this.assertUniqueCategory(name, parentId);
    const c = await this.prisma.acctCategory.create({
      data: { name, parentId, monthlyBudget: dto.monthlyBudget ?? null, annualBudget: dto.annualBudget ?? null, sortOrder: dto.sortOrder ?? 0, archived: dto.archived ?? false },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.category_created', entityType: 'acct_category', entityId: c.id, after: { name } });
    return c;
  }

  async updateCategory(u: AuthUser, id: string, dto: UpdateCategoryDto) {
    const before = await this.prisma.acctCategory.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Category not found');
    if (dto.name) await this.assertUniqueCategory(dto.name.trim(), before.parentId, id);
    const c = await this.prisma.acctCategory.update({
      where: { id },
      data: { name: dto.name?.trim(), monthlyBudget: dto.monthlyBudget, annualBudget: dto.annualBudget, sortOrder: dto.sortOrder, archived: dto.archived },
    });
    await this.audit.record({
      actorId: u.id, action: 'accounting.category_updated', entityType: 'acct_category', entityId: id,
      before: { name: before.name, monthlyBudget: before.monthlyBudget, annualBudget: before.annualBudget, archived: before.archived },
      after: { name: c.name, monthlyBudget: c.monthlyBudget, annualBudget: c.annualBudget, archived: c.archived },
    });
    return c;
  }

  async removeCategory(u: AuthUser, id: string) {
    const c = await this.prisma.acctCategory.findUnique({ where: { id }, include: { _count: { select: { children: true, expenses: true } } } });
    if (!c) throw new NotFoundException('Category not found');
    if (c._count.children) throw new BadRequestException('Remove or move its subcategories first');
    if (c._count.expenses) throw new BadRequestException(`${c._count.expenses} expense(s) use this category. Archive it instead, so they keep their category.`);
    await this.prisma.acctCategory.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.category_deleted', entityType: 'acct_category', entityId: id, before: { name: c.name } });
    return { deleted: true };
  }

  // ── Expenses ──
  private shapeExpense(e: ExpenseRow) {
    const { receiptKey, ...rest } = e;
    return {
      ...rest, amount: num(e.amount), dateIncurred: iso(e.dateIncurred)!, datePaid: iso(e.datePaid),
      hasReceipt: !!receiptKey,
      categoryLabel: e.category ? (e.category.parent ? `${e.category.parent.name} › ${e.category.name}` : e.category.name) : null,
      topCategoryId: e.category ? e.category.parentId ?? e.category.id : null,
    };
  }

  private expenseWhere(u: AuthUser, q: ExpenseQuery): Prisma.AcctExpenseWhereInput {
    const and: Prisma.AcctExpenseWhereInput[] = [];
    if (!isManager(u)) and.push({ submittedById: u.id });
    if (q.from || q.to) and.push({ dateIncurred: { ...(q.from ? { gte: day(q.from) } : {}), ...(q.to ? { lte: day(q.to) } : {}) } });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.categoryId === 'none') and.push({ categoryId: null });
    else if (q.categoryId) and.push({ OR: [{ categoryId: q.categoryId }, { category: { parentId: q.categoryId } }] });
    if (q.vendorId === 'none') and.push({ vendorId: null });
    else if (q.vendorId) and.push({ vendorId: q.vendorId });
    if (q.projectId === 'none') and.push({ projectId: null });
    else if (q.projectId) and.push({ projectId: q.projectId });
    if (q.submittedById) and.push({ submittedById: q.submittedById });
    if (q.paymentMethod) and.push({ paymentMethod: q.paymentMethod });
    if (q.tag) and.push({ tags: { has: q.tag.trim().toLowerCase() } });
    if (q.receipt) and.push({ receiptKey: q.receipt === 'yes' ? { not: null } : null });
    const s = q.search?.trim();
    if (s) {
      const c = { contains: s, mode: 'insensitive' as const };
      and.push({ OR: [{ description: c }, { vendor: { name: c } }, { category: { name: c } }, { project: { title: c } }, { project: { client: { name: c } } }] });
    }
    for (const id of [q.categoryId, q.vendorId, q.projectId]) if (id && id !== 'none' && !/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Invalid filter');
    return { AND: and };
  }

  private expenseOrder(sort?: ExpenseQuery['sort']): Prisma.AcctExpenseOrderByWithRelationInput[] {
    switch (sort) {
      case 'date_asc': return [{ dateIncurred: 'asc' }, { createdAt: 'asc' }];
      case 'amount_desc': return [{ amount: 'desc' }];
      case 'amount_asc': return [{ amount: 'asc' }];
      case 'created_desc': return [{ createdAt: 'desc' }];
      default: return [{ dateIncurred: 'desc' }, { createdAt: 'desc' }];
    }
  }

  async listExpenses(u: AuthUser, q: ExpenseQuery) {
    assertCanSubmit(u);
    const where = this.expenseWhere(u, q);
    const pageSize = q.pageSize ?? 50;
    const page = q.page ?? 1;
    const [items, total, sum, pending] = await Promise.all([
      this.prisma.acctExpense.findMany({ where, include: expenseInclude, orderBy: this.expenseOrder(q.sort), skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.acctExpense.count({ where }),
      this.prisma.acctExpense.aggregate({ where, _sum: { amount: true } }),
      this.prisma.acctExpense.aggregate({ where: { status: 'PENDING', ...(isManager(u) ? {} : { submittedById: u.id }) }, _sum: { amount: true }, _count: true }),
    ]);
    return {
      items: items.map((e) => this.shapeExpense(e)), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)),
      sum: num(sum._sum.amount), pending: { count: pending._count, amount: num(pending._sum.amount) },
    };
  }

  async exportExpenses(u: AuthUser, q: ExpenseQuery) {
    assertCanSubmit(u);
    const rows = await this.prisma.acctExpense.findMany({ where: this.expenseWhere(u, q), include: expenseInclude, orderBy: this.expenseOrder(q.sort), take: 20000 });
    const body = csv([
      ['Date', 'Amount (INR)', 'Status', 'Category', 'Vendor / payee', 'Client', 'Project', 'Payment method', 'Description', 'Tags', 'Date paid', 'Submitted by', 'Reviewed by', 'Review comment', 'Receipt'],
      ...rows.map((r) => {
        const e = this.shapeExpense(r);
        return [e.dateIncurred, e.amount.toFixed(2), e.status, e.categoryLabel ?? '', e.vendor?.name ?? '', e.project?.client.name ?? '', e.project?.title ?? '',
          e.paymentMethod, e.description ?? '', e.tags.join('; '), e.datePaid ?? '', e.submittedBy.fullName, e.reviewedBy?.fullName ?? '', e.reviewComment ?? '', e.hasReceipt ? 'yes' : ''];
      }),
    ]);
    return { name: `prisim-expenses-${today()}.csv`, body };
  }

  private async vendorId(name: string | null | undefined): Promise<string | null | undefined> {
    if (name === undefined) return undefined;
    const n = (name ?? '').trim().replace(/\s+/g, ' ');
    if (!n) return null;
    const found = await this.prisma.acctVendor.findFirst({ where: { name: { equals: n, mode: 'insensitive' } } });
    if (found) return found.id;
    try { return (await this.prisma.acctVendor.create({ data: { name: n } })).id; }
    catch { return (await this.prisma.acctVendor.findFirstOrThrow({ where: { name: { equals: n, mode: 'insensitive' } } })).id; }
  }

  private async checkRefs(dto: { categoryId?: string | null; projectId?: string | null }) {
    if (dto.categoryId && !(await this.prisma.acctCategory.count({ where: { id: dto.categoryId } }))) throw new BadRequestException('That category does not exist');
    if (dto.projectId && !(await this.prisma.acctProject.count({ where: { id: dto.projectId } }))) throw new BadRequestException('That project does not exist');
  }

  private review(u: AuthUser, status: AcctExpenseStatus | undefined, prev: AcctExpenseStatus | null, datePaid: Date | null | undefined) {
    if (!status || status === prev) return {};
    if (status === 'PENDING') return { status, reviewedById: null, reviewedAt: null };
    return { status, reviewedById: u.id, reviewedAt: new Date(), ...(status === 'PAID' && !datePaid ? { datePaid: day(today()) } : {}) };
  }

  async createExpense(u: AuthUser, dto: ExpenseDto) {
    assertCanSubmit(u);
    await this.checkRefs(dto);
    const manager = isManager(u);
    const status = manager ? dto.status ?? 'APPROVED' : 'PENDING';
    const datePaid = dto.datePaid ? day(dto.datePaid) : null;
    const e = await this.prisma.acctExpense.create({
      data: {
        amount: dto.amount, dateIncurred: day(dto.dateIncurred), datePaid, categoryId: dto.categoryId ?? null, vendorId: (await this.vendorId(dto.vendorName)) ?? null,
        projectId: dto.projectId ?? null, paymentMethod: dto.paymentMethod ?? 'BANK_TRANSFER', description: dto.description?.trim() || null,
        tags: [...new Set((dto.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))], submittedById: u.id,
        status: 'PENDING', ...this.review(u, status, 'PENDING', datePaid), reviewComment: manager ? dto.reviewComment?.trim() || null : null,
      },
      include: expenseInclude,
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.expense_created', entityType: 'acct_expense', entityId: e.id, after: { amount: num(e.amount), status: e.status } });
    return this.shapeExpense(e);
  }

  private async ownExpense(u: AuthUser, id: string) {
    const e = await this.prisma.acctExpense.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Expense not found');
    if (!isManager(u)) {
      if (e.submittedById !== u.id) throw new NotFoundException('Expense not found');
      if (e.status !== 'PENDING') throw new ForbiddenException('Only pending expenses can be changed. Ask an accounts manager.');
    }
    return e;
  }

  async updateExpense(u: AuthUser, id: string, dto: UpdateExpenseDto) {
    assertCanSubmit(u);
    const before = await this.ownExpense(u, id);
    await this.checkRefs(dto);
    const manager = isManager(u);
    const datePaid = dto.datePaid === undefined ? before.datePaid : dto.datePaid ? day(dto.datePaid) : null;
    const e = await this.prisma.acctExpense.update({
      where: { id },
      data: {
        amount: dto.amount, dateIncurred: dto.dateIncurred ? day(dto.dateIncurred) : undefined,
        datePaid: dto.datePaid === undefined ? undefined : datePaid, categoryId: dto.categoryId, vendorId: await this.vendorId(dto.vendorName),
        projectId: dto.projectId, paymentMethod: dto.paymentMethod,
        description: dto.description === undefined ? undefined : dto.description?.trim() || null,
        tags: dto.tags ? [...new Set(dto.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] : undefined,
        ...(manager ? this.review(u, dto.status, before.status, datePaid) : {}),
        ...(manager && dto.reviewComment !== undefined ? { reviewComment: dto.reviewComment?.trim() || null } : {}),
      },
      include: expenseInclude,
    });
    await this.audit.record({
      actorId: u.id, action: 'accounting.expense_updated', entityType: 'acct_expense', entityId: id,
      before: { amount: num(before.amount), status: before.status }, after: { amount: num(e.amount), status: e.status },
    });
    return this.shapeExpense(e);
  }

  async reviewExpenses(u: AuthUser, dto: ReviewDto) {
    const rows = await this.prisma.acctExpense.findMany({ where: { id: { in: dto.ids } }, select: { id: true, status: true, datePaid: true } });
    const comment = dto.comment?.trim() || null;
    await this.prisma.$transaction(rows.map((r) => this.prisma.acctExpense.update({
      where: { id: r.id },
      data: { ...this.review(u, dto.status, r.status, r.datePaid), ...(dto.comment !== undefined ? { reviewComment: comment } : {}) },
    })));
    await this.audit.record({ actorId: u.id, action: 'accounting.expenses_reviewed', entityType: 'acct_expense', after: { count: rows.length, status: dto.status, comment } });
    return { updated: rows.length };
  }

  async removeExpense(u: AuthUser, id: string) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    await this.prisma.acctExpense.delete({ where: { id } });
    if (e.receiptKey) await this.storage.remove(e.receiptKey).catch(() => undefined);
    await this.audit.record({ actorId: u.id, action: 'accounting.expense_deleted', entityType: 'acct_expense', entityId: id, before: { amount: num(e.amount), status: e.status, date: iso(e.dateIncurred) } });
    return { deleted: true };
  }

  async removeExpenses(u: AuthUser, dto: DeleteManyDto) {
    const rows = await this.prisma.acctExpense.findMany({ where: { id: { in: dto.ids } }, select: { id: true, receiptKey: true } });
    await this.prisma.acctExpense.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const r of rows) if (r.receiptKey) await this.storage.remove(r.receiptKey).catch(() => undefined);
    await this.audit.record({ actorId: u.id, action: 'accounting.expenses_deleted', entityType: 'acct_expense', after: { count: rows.length } });
    return { deleted: rows.length };
  }

  async attachReceipt(u: AuthUser, id: string, file?: Express.Multer.File) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException('Receipts can be up to 10 MB');
    if (!RECEIPT_TYPES.includes(file.mimetype)) throw new BadRequestException('Receipts can be a photo (PNG, JPG, WebP, HEIC) or a PDF');
    const key = await this.storage.save('receipts', file.buffer, file.originalname, file.mimetype);
    try {
      await this.prisma.acctExpense.update({ where: { id }, data: { receiptKey: key, receiptName: file.originalname.slice(0, 200), receiptType: file.mimetype } });
    } catch (err) {
      await this.storage.remove(key).catch(() => undefined);
      throw err;
    }
    if (e.receiptKey) await this.storage.remove(e.receiptKey).catch(() => undefined);
    return { hasReceipt: true, receiptName: file.originalname };
  }

  async removeReceipt(u: AuthUser, id: string) {
    assertCanSubmit(u);
    const e = await this.ownExpense(u, id);
    if (!e.receiptKey) return { hasReceipt: false };
    await this.prisma.acctExpense.update({ where: { id }, data: { receiptKey: null, receiptName: null, receiptType: null } });
    await this.storage.remove(e.receiptKey).catch(() => undefined);
    return { hasReceipt: false };
  }

  async receipt(u: AuthUser, id: string, res: Response) {
    assertCanSubmit(u);
    const e = await this.prisma.acctExpense.findUnique({ where: { id } });
    if (!e?.receiptKey || (!isManager(u) && e.submittedById !== u.id)) throw new NotFoundException('Receipt not found');
    return this.storage.send(res, e.receiptKey, e.receiptType ?? 'application/octet-stream', undefined, e.receiptName ?? 'receipt');
  }

  // ── Projects ──
  private async projectMoney(ids: string[]) {
    if (!ids.length) return new Map<string, { received: number; spent: number; invoiced: number; lastPayment: string | null; paymentCount: number }>();
    const [pp, ip, spent, inv] = await Promise.all([
      this.prisma.acctProjectPayment.groupBy({ by: ['projectId'], where: { projectId: { in: ids } }, _sum: { amount: true }, _max: { paidOn: true }, _count: true }),
      this.prisma.acctInvoicePayment.findMany({ where: { invoice: { projectId: { in: ids }, cancelled: false } }, select: { amount: true, paidOn: true, invoice: { select: { projectId: true } } } }),
      this.prisma.acctExpense.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: { in: ['APPROVED', 'PAID'] } }, _sum: { amount: true } }),
      this.prisma.acctInvoice.findMany({ where: { projectId: { in: ids }, cancelled: false }, select: { projectId: true, items: true, discount: true, gstRate: true, clientDetails: true } }),
    ]);
    const s = await this.settings();
    const out = new Map(ids.map((id) => [id, { received: 0, spent: 0, invoiced: 0, lastPayment: null as string | null, paymentCount: 0 }]));
    for (const r of pp) {
      const o = out.get(r.projectId)!;
      o.received += num(r._sum.amount); o.paymentCount += r._count; o.lastPayment = iso(r._max.paidOn);
    }
    for (const r of ip) {
      const o = out.get(r.invoice.projectId!)!;
      o.received += num(r.amount); o.paymentCount += 1;
      const d = iso(r.paidOn)!;
      if (!o.lastPayment || d > o.lastPayment) o.lastPayment = d;
    }
    for (const r of spent) out.get(r.projectId!)!.spent = num(r._sum.amount);
    for (const r of inv) {
      out.get(r.projectId!)!.invoiced += invoiceTotals({ items: r.items as InvoiceItem[], discount: num(r.discount), gstRate: num(r.gstRate), clientDetails: r.clientDetails as ClientDetails }, s.stateCode, 0).total;
    }
    for (const o of out.values()) { o.received = r2(o.received); o.spent = r2(o.spent); o.invoiced = r2(o.invoiced); }
    return out;
  }

  private shapeProject<T extends { quotedAmount: Prisma.Decimal | null; meetingDate: Date | null; shootStart: Date | null; shootEnd: Date | null }>(p: T, money: { received: number; spent: number; invoiced: number; lastPayment: string | null; paymentCount: number }) {
    const quoted = p.quotedAmount == null ? null : num(p.quotedAmount);
    const billed = Math.max(quoted ?? 0, money.invoiced);
    return {
      ...p, quotedAmount: quoted, meetingDate: iso(p.meetingDate), shootStart: iso(p.shootStart), shootEnd: iso(p.shootEnd), ...money,
      balance: r2(Math.max(0, billed - money.received)), profit: r2(money.received - money.spent),
    };
  }

  async listProjects(q: ProjectQuery) {
    const s = q.search?.trim();
    const rows = await this.prisma.acctProject.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}), ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(s ? { OR: [{ title: { contains: s, mode: 'insensitive' } }, { client: { name: { contains: s, mode: 'insensitive' } } }] } : {}),
      },
      include: { client: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const money = await this.projectMoney(rows.map((r) => r.id));
    return rows.map((r) => this.shapeProject(r, money.get(r.id)!));
  }

  async getProject(id: string) {
    const p = await this.prisma.acctProject.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, contactName: true, phone: true, email: true } },
        createdBy: person,
        payments: { orderBy: { paidOn: 'asc' } },
        expenses: { include: expenseInclude, orderBy: { dateIncurred: 'desc' } },
        invoices: { include: invoiceInclude, orderBy: { date: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    const money = (await this.projectMoney([id])).get(id)!;
    const s = await this.settings();
    const { payments, expenses, invoices, ...rest } = p;
    return {
      ...this.shapeProject(rest, money),
      payments: payments.map((x) => ({ ...x, amount: num(x.amount), paidOn: iso(x.paidOn)! })),
      expenses: expenses.map((e) => this.shapeExpense(e)),
      invoices: invoices.map((i) => this.shapeInvoice(i, s)),
    };
  }

  private async checkClient(clientId?: string | null) {
    if (clientId && !(await this.prisma.client.count({ where: { id: clientId } }))) throw new BadRequestException('That client does not exist');
  }

  private checkShoot(start?: string | null, end?: string | null) {
    if (start && end && end < start) throw new BadRequestException('The shoot cannot end before it starts');
  }

  async createProject(u: AuthUser, dto: ProjectDto) {
    await this.checkClient(dto.clientId);
    this.checkShoot(dto.shootStart, dto.shootEnd);
    const p = await this.prisma.acctProject.create({
      data: {
        clientId: dto.clientId, title: dto.title.trim(), meetingDate: dto.meetingDate ? day(dto.meetingDate) : null,
        shootStart: dto.shootStart ? day(dto.shootStart) : null, shootEnd: dto.shootEnd ? day(dto.shootEnd) : null,
        quotedAmount: dto.quotedAmount ?? null, status: dto.status ?? 'ACTIVE', notes: dto.notes?.trim() || null, createdById: u.id,
      },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_created', entityType: 'acct_project', entityId: p.id, after: { title: p.title } });
    return this.getProject(p.id);
  }

  async updateProject(u: AuthUser, id: string, dto: UpdateProjectDto) {
    const before = await this.prisma.acctProject.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Project not found');
    await this.checkClient(dto.clientId);
    const d = (v: string | null | undefined) => (v === undefined ? undefined : v ? day(v) : null);
    this.checkShoot(dto.shootStart === undefined ? iso(before.shootStart) : dto.shootStart, dto.shootEnd === undefined ? iso(before.shootEnd) : dto.shootEnd);
    await this.prisma.acctProject.update({
      where: { id },
      data: {
        clientId: dto.clientId, title: dto.title?.trim(), meetingDate: d(dto.meetingDate), shootStart: d(dto.shootStart), shootEnd: d(dto.shootEnd),
        quotedAmount: dto.quotedAmount, status: dto.status, notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
      },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_updated', entityType: 'acct_project', entityId: id, before: { title: before.title, status: before.status }, after: dto });
    return this.getProject(id);
  }

  async removeProject(u: AuthUser, id: string) {
    const p = await this.prisma.acctProject.findUnique({ where: { id }, include: { _count: { select: { payments: true, invoices: true } } } });
    if (!p) throw new NotFoundException('Project not found');
    if (p._count.invoices) throw new BadRequestException('This project has invoices. Cancel it instead (Status → Cancelled).');
    await this.prisma.acctProject.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_deleted', entityType: 'acct_project', entityId: id, before: { title: p.title, payments: p._count.payments } });
    return { deleted: true };
  }

  async addProjectPayment(u: AuthUser, id: string, dto: PaymentDto) {
    if (!(await this.prisma.acctProject.count({ where: { id } }))) throw new NotFoundException('Project not found');
    const pay = await this.prisma.acctProjectPayment.create({
      data: { projectId: id, amount: dto.amount, paidOn: day(dto.paidOn), method: dto.method ?? 'BANK_TRANSFER', note: dto.note?.trim() || null },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_payment_added', entityType: 'acct_project', entityId: id, after: { amount: dto.amount, paidOn: dto.paidOn } });
    return { ...pay, amount: num(pay.amount), paidOn: iso(pay.paidOn) };
  }

  async removeProjectPayment(u: AuthUser, id: string) {
    const pay = await this.prisma.acctProjectPayment.findUnique({ where: { id } });
    if (!pay) throw new NotFoundException('Payment not found');
    await this.prisma.acctProjectPayment.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.project_payment_removed', entityType: 'acct_project', entityId: pay.projectId, before: { amount: num(pay.amount), paidOn: iso(pay.paidOn) } });
    return { deleted: true };
  }

  // ── Invoices ──
  private shapeInvoice(i: InvoiceRow, s: AcctSettingsData) {
    const items = i.items as InvoiceItem[];
    const clientDetails = i.clientDetails as ClientDetails;
    const payments = i.payments.map((p) => ({ ...p, amount: num(p.amount), paidOn: iso(p.paidOn)! }));
    const t = invoiceTotals({ items, discount: num(i.discount), gstRate: num(i.gstRate), clientDetails }, s.stateCode, payments.reduce((a, p) => a + p.amount, 0));
    const due = iso(i.dueDate);
    const status = i.cancelled ? 'cancelled' : t.total > 0 && t.paid >= t.total ? 'paid' : due && due < today() ? 'overdue' : t.paid > 0 ? 'partial' : 'unpaid';
    return { ...i, date: iso(i.date)!, dueDate: due, items, clientDetails, gstRate: num(i.gstRate), payments, ...t, status };
  }

  async nextInvoiceNumber(date = today()) {
    const s = await this.settings();
    const prefix = `${s.invoicePrefix ? `${s.invoicePrefix}/` : ''}${fyLabel(date, s.fyStartMonth)}/`;
    const rows = await this.prisma.acctInvoice.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } });
    const max = Math.max(0, ...rows.map((r) => Number(r.number.slice(prefix.length))).filter((n) => Number.isInteger(n)));
    return { number: `${prefix}${max + 1}` };
  }

  async listInvoices(q: InvoiceQuery) {
    const s = q.search?.trim();
    const rows = await this.prisma.acctInvoice.findMany({
      where: {
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(s ? { OR: [{ number: { contains: s, mode: 'insensitive' } }, { clientName: { contains: s, mode: 'insensitive' } }] } : {}),
      },
      include: invoiceInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000,
    });
    const settings = await this.settings();
    const all = rows.map((r) => this.shapeInvoice(r, settings));
    return q.status ? all.filter((r) => r.status === q.status) : all;
  }

  async getInvoice(id: string) {
    const i = await this.prisma.acctInvoice.findUnique({ where: { id }, include: invoiceInclude });
    if (!i) throw new NotFoundException('Invoice not found');
    return this.shapeInvoice(i, await this.settings());
  }

  private invoiceData(dto: UpdateInvoiceDto) {
    const cd = dto.clientDetails;
    return {
      date: dto.date ? day(dto.date) : undefined, dueDate: dto.dueDate === undefined ? undefined : dto.dueDate ? day(dto.dueDate) : null,
      clientId: dto.clientId, clientName: dto.clientName?.trim(),
      clientDetails: cd ? ({
        contactPerson: cd.contactPerson?.trim() ?? '', phone: cd.phone?.trim() ?? '', email: cd.email?.trim() ?? '',
        gstin: (cd.gstin ?? '').trim().toUpperCase(), address: cd.address?.trim() ?? '', stateCode: cd.stateCode ?? '',
      } as Prisma.InputJsonValue) : undefined,
      items: dto.items ? (dto.items.map((i) => ({
        description: i.description.trim(), hsn: (i.hsn ?? '').trim().toUpperCase(), qty: i.qty, unit: (i.unit ?? '').trim(), rate: i.rate,
      })) as unknown as Prisma.InputJsonValue) : undefined,
      extra: dto.extra ? (Object.fromEntries(Object.entries(dto.extra).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v)) as Prisma.InputJsonValue) : undefined,
      shipTo: dto.shipTo === undefined ? undefined : dto.shipTo === null ? Prisma.DbNull : ({
        name: dto.shipTo.name.trim(), address: dto.shipTo.address?.trim() ?? '', gstin: (dto.shipTo.gstin ?? '').trim().toUpperCase(), stateCode: dto.shipTo.stateCode ?? '',
      } as Prisma.InputJsonValue),
      discount: dto.discount, gstRate: dto.gstRate, notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
      terms: dto.terms ? dto.terms.map((t) => t.trim()).filter(Boolean) : undefined,
      preparedBy: dto.preparedBy === undefined ? undefined : dto.preparedBy?.trim() || null, projectId: dto.projectId, cancelled: dto.cancelled,
    };
  }

  async createInvoice(u: AuthUser, dto: InvoiceDto, quotationId?: string) {
    await this.checkClient(dto.clientId);
    if (dto.projectId && !(await this.prisma.acctProject.count({ where: { id: dto.projectId } }))) throw new BadRequestException('That project does not exist');
    const number = dto.number?.trim() || (await this.nextInvoiceNumber(dto.date.slice(0, 10))).number;
    try {
      const data = this.invoiceData(dto);
      const i = await this.prisma.acctInvoice.create({
        data: {
          ...data, number, date: day(dto.date), clientName: dto.clientName.trim(), clientDetails: data.clientDetails!, items: data.items!, terms: data.terms!,
          quotationId: quotationId ?? null, createdById: u.id,
        },
        include: invoiceInclude,
      });
      const shaped = this.shapeInvoice(i, await this.settings());
      await this.audit.record({ actorId: u.id, action: 'accounting.invoice_created', entityType: 'acct_invoice', entityId: i.id, after: { number, client: i.clientName, total: shaped.total } });
      return shaped;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException(`Invoice number ${number} is already used`);
      throw e;
    }
  }

  /** A new invoice filled in from a quotation (its items, client and GST). */
  async invoiceFromQuotation(u: AuthUser, quotationId: string) {
    const q = await this.prisma.quotation.findUnique({ where: { id: quotationId }, include: { client: { select: { contactName: true, phone: true, email: true } } } });
    if (!q) throw new NotFoundException('Quotation not found');
    const s = await this.settings();
    const date = today();
    const [y, m, d] = date.split('-').map(Number);
    const due = new Date(Date.UTC(y, m - 1, d + s.invoiceDueDays)).toISOString().slice(0, 10);
    const items = (q.items as { title: string; points: string[]; qty: string; amount: number }[]).map((it) => ({
      description: [it.title, ...(it.points ?? []).map((p) => `• ${p}`)].join('\n').slice(0, 1000),
      hsn: s.defaultHsn, qty: 1, unit: '', rate: Number(it.amount) || 0,
    }));
    const project = q.clientId ? await this.prisma.acctProject.findFirst({ where: { clientId: q.clientId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, select: { id: true } }) : null;
    return this.createInvoice(u, {
      date, dueDate: due, clientId: q.clientId, clientName: q.clientName,
      clientDetails: { contactPerson: q.client?.contactName ?? '', phone: q.client?.phone ?? '', email: q.client?.email ?? '', gstin: '', address: q.address ?? '' },
      items, discount: 0, gstRate: num(q.gstRate), notes: null, terms: s.invoiceTerms, preparedBy: u.fullName,
      extra: { otherReferences: `Quotation ${q.number}` },
      projectId: project?.id ?? null,
    }, q.id);
  }

  async updateInvoice(u: AuthUser, id: string, dto: UpdateInvoiceDto) {
    const before = await this.prisma.acctInvoice.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Invoice not found');
    await this.checkClient(dto.clientId);
    if (dto.projectId && !(await this.prisma.acctProject.count({ where: { id: dto.projectId } }))) throw new BadRequestException('That project does not exist');
    try {
      const i = await this.prisma.acctInvoice.update({ where: { id }, data: { ...this.invoiceData(dto), number: dto.number?.trim() }, include: invoiceInclude });
      const shaped = this.shapeInvoice(i, await this.settings());
      await this.audit.record({
        actorId: u.id, action: dto.cancelled !== undefined && dto.cancelled !== before.cancelled ? (dto.cancelled ? 'accounting.invoice_cancelled' : 'accounting.invoice_restored') : 'accounting.invoice_updated',
        entityType: 'acct_invoice', entityId: id, before: { number: before.number }, after: { number: i.number, total: shaped.total },
      });
      return shaped;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException(`Invoice number ${dto.number} is already used`);
      throw e;
    }
  }

  async removeInvoice(u: AuthUser, id: string) {
    const i = await this.prisma.acctInvoice.findUnique({ where: { id }, include: { _count: { select: { payments: true } } } });
    if (!i) throw new NotFoundException('Invoice not found');
    if (i._count.payments) throw new BadRequestException('This invoice has payments recorded. Cancel it instead, so the record stays.');
    await this.prisma.acctInvoice.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_deleted', entityType: 'acct_invoice', entityId: id, before: { number: i.number, client: i.clientName } });
    return { deleted: true };
  }

  async addInvoicePayment(u: AuthUser, id: string, dto: PaymentDto) {
    const inv = await this.getInvoice(id);
    if (inv.cancelled) throw new BadRequestException('This invoice is cancelled');
    if (dto.amount > inv.balance + 0.005) throw new BadRequestException(`That is more than the balance due (₹${inv.balance.toFixed(2)})`);
    await this.prisma.acctInvoicePayment.create({
      data: { invoiceId: id, amount: dto.amount, paidOn: day(dto.paidOn), method: dto.method ?? 'BANK_TRANSFER', note: dto.note?.trim() || null },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_payment_added', entityType: 'acct_invoice', entityId: id, after: { number: inv.number, amount: dto.amount, paidOn: dto.paidOn } });
    return this.getInvoice(id);
  }

  async removeInvoicePayment(u: AuthUser, id: string) {
    const pay = await this.prisma.acctInvoicePayment.findUnique({ where: { id } });
    if (!pay) throw new NotFoundException('Payment not found');
    await this.prisma.acctInvoicePayment.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_payment_removed', entityType: 'acct_invoice', entityId: pay.invoiceId, before: { amount: num(pay.amount), paidOn: iso(pay.paidOn) } });
    return this.getInvoice(pay.invoiceId);
  }

  // ── Ledger: the raw figures behind the dashboard and reports ──
  async ledger(q: LedgerQuery) {
    const from = day(q.from), to = day(q.to);
    if (to < from) throw new BadRequestException('The end date is before the start date');
    if (to.getTime() - from.getTime() > 6 * 366 * 86400000) throw new BadRequestException('Pick a range of six years or less');
    const [expenses, projectPayments, invoicePayments, invoices, categories, s] = await Promise.all([
      this.prisma.acctExpense.findMany({
        where: { dateIncurred: { gte: from, lte: to }, status: { not: 'REJECTED' } },
        select: {
          id: true, amount: true, dateIncurred: true, status: true, paymentMethod: true, categoryId: true, vendorId: true, projectId: true,
          category: { select: { parentId: true } }, vendor: { select: { name: true } }, submittedBy: person,
          project: { select: { title: true, client: { select: { name: true } } } },
        },
      }),
      this.prisma.acctProjectPayment.findMany({ where: { paidOn: { gte: from, lte: to } }, select: { amount: true, paidOn: true, method: true, project: { select: { id: true, title: true, client: { select: { id: true, name: true } } } } } }),
      this.prisma.acctInvoicePayment.findMany({
        where: { paidOn: { gte: from, lte: to }, invoice: { cancelled: false } },
        select: { amount: true, paidOn: true, method: true, invoice: { select: { id: true, number: true, clientId: true, clientName: true } } },
      }),
      this.prisma.acctInvoice.findMany({ where: { cancelled: false }, include: invoiceInclude }),
      this.prisma.acctCategory.findMany({ select: { id: true, name: true, parentId: true, monthlyBudget: true, annualBudget: true, sortOrder: true, archived: true } }),
      this.settings(),
    ]);
    const shapedInvoices = invoices.map((i) => this.shapeInvoice(i, s));
    return {
      fyStartMonth: s.fyStartMonth,
      expenses: expenses.map((e) => ({
        id: e.id, amount: num(e.amount), date: iso(e.dateIncurred)!, status: e.status, method: e.paymentMethod,
        categoryId: e.categoryId, topCategoryId: e.category ? e.category.parentId ?? e.categoryId : null,
        vendorId: e.vendorId, vendorName: e.vendor?.name ?? null, projectId: e.projectId,
        projectLabel: e.project ? `${e.project.client.name} · ${e.project.title}` : null,
        submitterId: e.submittedBy.id, submitterName: e.submittedBy.fullName,
      })),
      income: [
        ...projectPayments.map((p) => ({ amount: num(p.amount), date: iso(p.paidOn)!, method: p.method, clientId: p.project.client.id, clientName: p.project.client.name, source: `Project · ${p.project.title}` })),
        ...invoicePayments.map((p) => ({ amount: num(p.amount), date: iso(p.paidOn)!, method: p.method, clientId: p.invoice.clientId, clientName: p.invoice.clientName, source: `Invoice ${p.invoice.number}` })),
      ],
      invoices: {
        count: shapedInvoices.length,
        invoicedInRange: r2(shapedInvoices.filter((i) => i.date >= q.from.slice(0, 10) && i.date <= q.to.slice(0, 10)).reduce((a, i) => a + i.total, 0)),
        outstanding: r2(shapedInvoices.reduce((a, i) => a + i.balance, 0)),
        overdue: r2(shapedInvoices.filter((i) => i.status === 'overdue').reduce((a, i) => a + i.balance, 0)),
        overdueCount: shapedInvoices.filter((i) => i.status === 'overdue').length,
      },
      categories: categories.map((c) => ({ ...c, monthlyBudget: c.monthlyBudget == null ? null : num(c.monthlyBudget), annualBudget: c.annualBudget == null ? null : num(c.annualBudget) })),
    };
  }
}

// ───────────────────────── Controller ─────────────────────────

@ApiTags('Accounting')
@ApiBearerAuth()
@Controller('accounting')
export class AccountingController {
  constructor(private svc: AccountingService) {}

  @Get('settings') @RequireAny(MANAGE) settings() { return this.svc.settings(); }
  @Put('settings') @RequireAny(MANAGE) saveSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) { return this.svc.saveSettings(u, dto); }
  @Get('lookups') lookups(@CurrentUser() u: AuthUser) { return this.svc.lookups(u); }
  @Get('ledger') @RequireAny(MANAGE) ledger(@Query() q: LedgerQuery) { return this.svc.ledger(q); }

  @Get('categories') @RequireAny(MANAGE) categories(@Query() q: MonthQuery) { return this.svc.categories(q); }
  @Post('categories') @RequireAny(MANAGE) createCategory(@CurrentUser() u: AuthUser, @Body() dto: CategoryDto) { return this.svc.createCategory(u, dto); }
  @Patch('categories/:id') @RequireAny(MANAGE) updateCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) { return this.svc.updateCategory(u, id, dto); }
  @Delete('categories/:id') @RequireAny(MANAGE) removeCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeCategory(u, id); }

  @Get('expenses') listExpenses(@CurrentUser() u: AuthUser, @Query() q: ExpenseQuery) { return this.svc.listExpenses(u, q); }
  @Get('expenses/export')
  async exportExpenses(@CurrentUser() u: AuthUser, @Query() q: ExpenseQuery, @Res() res: Response) {
    const { name, body } = await this.svc.exportExpenses(u, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  }
  @Post('expenses') createExpense(@CurrentUser() u: AuthUser, @Body() dto: ExpenseDto) { return this.svc.createExpense(u, dto); }
  @Post('expenses/review') @RequireAny(MANAGE) review(@CurrentUser() u: AuthUser, @Body() dto: ReviewDto) { return this.svc.reviewExpenses(u, dto); }
  @Post('expenses/delete') @RequireAny(MANAGE) removeMany(@CurrentUser() u: AuthUser, @Body() dto: DeleteManyDto) { return this.svc.removeExpenses(u, dto); }
  @Patch('expenses/:id') updateExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto) { return this.svc.updateExpense(u, id, dto); }
  @Delete('expenses/:id') removeExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeExpense(u, id); }
  @Post('expenses/:id/receipt')
  @FileUpload(MAX_RECEIPT_BYTES)
  attachReceipt(@CurrentUser() u: AuthUser, @Param() p: ReceiptParams, @UploadedFile() file: Express.Multer.File) { return this.svc.attachReceipt(u, p.id, file); }
  @Get('expenses/:id/receipt') receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.svc.receipt(u, id, res); }
  @Delete('expenses/:id/receipt') removeReceipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeReceipt(u, id); }

  @Get('projects') @RequireAny(MANAGE) listProjects(@Query() q: ProjectQuery) { return this.svc.listProjects(q); }
  @Get('projects/:id') @RequireAny(MANAGE) getProject(@Param('id', ParseUUIDPipe) id: string) { return this.svc.getProject(id); }
  @Post('projects') @RequireAny(MANAGE) createProject(@CurrentUser() u: AuthUser, @Body() dto: ProjectDto) { return this.svc.createProject(u, dto); }
  @Patch('projects/:id') @RequireAny(MANAGE) updateProject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) { return this.svc.updateProject(u, id, dto); }
  @Delete('projects/:id') @RequireAny(MANAGE) removeProject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeProject(u, id); }
  @Post('projects/:id/payments') @RequireAny(MANAGE) addProjectPayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) { return this.svc.addProjectPayment(u, id, dto); }
  @Delete('project-payments/:id') @RequireAny(MANAGE) removeProjectPayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeProjectPayment(u, id); }

  @Get('invoices') @RequireAny(MANAGE) listInvoices(@Query() q: InvoiceQuery) { return this.svc.listInvoices(q); }
  @Get('invoices/next-number') @RequireAny(MANAGE) nextNumber(@Query() q: NextNumberQuery) { return this.svc.nextInvoiceNumber(q.date?.slice(0, 10)); }
  @Post('invoices/from-quotation/:id') @RequireAny(MANAGE) fromQuotation(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.invoiceFromQuotation(u, id); }
  @Get('invoices/:id') @RequireAny(MANAGE) getInvoice(@Param('id', ParseUUIDPipe) id: string) { return this.svc.getInvoice(id); }
  @Post('invoices') @RequireAny(MANAGE) createInvoice(@CurrentUser() u: AuthUser, @Body() dto: InvoiceDto) { return this.svc.createInvoice(u, dto); }
  @Patch('invoices/:id') @RequireAny(MANAGE) updateInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) { return this.svc.updateInvoice(u, id, dto); }
  @Delete('invoices/:id') @RequireAny(MANAGE) removeInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeInvoice(u, id); }
  @Post('invoices/:id/payments') @RequireAny(MANAGE) addInvoicePayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) { return this.svc.addInvoicePayment(u, id, dto); }
  @Delete('invoice-payments/:id') @RequireAny(MANAGE) removeInvoicePayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.svc.removeInvoicePayment(u, id); }
}

@Module({ providers: [AccountingService], controllers: [AccountingController] })
export class AccountingModule {}
