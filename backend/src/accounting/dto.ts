import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { AcctExpenseStatus, AcctPaymentMethod, AcctProjectStatus } from '@prisma/client';
import { csvList, EXPENSE_SORTS } from './shared';

// Request bodies and query strings for the accounting API.

export class BankDto {
  @IsString() @MaxLength(120) accountName: string;
  @IsString() @MaxLength(40) accountNumber: string;
  @IsString() @MaxLength(20) ifsc: string;
  @IsString() @MaxLength(120) bankName: string;
  @IsString() @MaxLength(80) upiId: string;
}

export class SettingsDto {
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

export class CategoryDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() parentId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) monthlyBudget?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999_999) annualBudget?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
  @IsOptional() @IsBoolean() archived?: boolean;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) monthlyBudget?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999_999) annualBudget?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9999) sortOrder?: number;
  @IsOptional() @IsBoolean() archived?: boolean;
}
export class MonthQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) month?: string;
}

// ───────────────────────── Expenses ─────────────────────────

export class ExpenseDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount: number;
  @IsDateString() dateIncurred: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() datePaid?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  /** Typed vendor/payee name: matched to an existing vendor or added. Empty clears it. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) vendorName?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  /** Ignored when a project is given: the expense then belongs to the project's client. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsEnum(AcctExpenseStatus) status?: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) reviewComment?: string | null;
}
export class UpdateExpenseDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount?: number;
  @IsOptional() @IsDateString() dateIncurred?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() datePaid?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() categoryId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) vendorName?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() projectId?: string | null;
  /** Ignored when a project is given: the expense then belongs to the project's client. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() clientId?: string | null;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsEnum(AcctExpenseStatus) status?: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) reviewComment?: string | null;
}
export class ReviewDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
  @IsEnum(AcctExpenseStatus) status: AcctExpenseStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) comment?: string | null;
}
export class DeleteManyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
}

export class ExpenseQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Transform(csvList) @IsArray() @IsEnum(AcctExpenseStatus, { each: true }) status?: AcctExpenseStatus[];
  @IsOptional() @IsString() categoryId?: string; // a uuid, or "none"
  @IsOptional() @IsString() vendorId?: string; // a uuid, or "none"
  @IsOptional() @IsString() projectId?: string; // a uuid, or "none"
  @IsOptional() @IsString() clientId?: string; // a uuid, or "none"
  @IsOptional() @IsUUID() submittedById?: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @IsOptional() @IsIn(['yes', 'no']) receipt?: 'yes' | 'no';
  @IsOptional() @IsIn(EXPENSE_SORTS as unknown as string[]) sort?: (typeof EXPENSE_SORTS)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
export class ReceiptParams {
  @IsUUID() id: string;
}

// ───────────────────────── Projects ─────────────────────────

export class ProjectDto {
  @IsUUID() clientId: string;
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() meetingDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootStart?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootEnd?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) quotedAmount?: number | null;
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
export class UpdateProjectDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() meetingDate?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootStart?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() shootEnd?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) quotedAmount?: number | null;
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
export class ProjectQuery {
  @IsOptional() @IsEnum(AcctProjectStatus) status?: AcctProjectStatus;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
export class PaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount: number;
  @IsDateString() paidOn: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) method?: AcctPaymentMethod;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) note?: string | null;
}

// ───────────────────────── Invoices ─────────────────────────

export class InvoiceItemDto {
  @IsString() @MinLength(1) @MaxLength(1000) description: string;
  @IsOptional() @Matches(/^[0-9A-Za-z]{0,10}$/, { message: 'HSN/SAC is up to 10 letters or numbers' }) hsn?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1_000_000) qty: number;
  @IsOptional() @IsString() @MaxLength(15) unit?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) rate: number;
}
export class InvoiceExtraDto {
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
export class ShipToDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(600) address?: string;
  @IsOptional() @Matches(/^$|^[0-9A-Za-z]{15}$/, { message: 'Consignee GSTIN is 15 letters and numbers' }) gstin?: string;
  @IsOptional() @Matches(/^$|^\d{2}$/) stateCode?: string;
}
export class ClientDetailsDto {
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @ValidateIf((_, v) => !!v) @IsEmail() @MaxLength(160) email?: string;
  @IsOptional() @Matches(/^$|^[0-9A-Za-z]{15}$/, { message: 'Client GSTIN is 15 letters and numbers' }) gstin?: string;
  @IsOptional() @IsString() @MaxLength(600) address?: string;
  /** GST state code of the buyer when there's no GSTIN to read it from. */
  @IsOptional() @Matches(/^$|^\d{2}$/) stateCode?: string;
}
export class InvoiceDto {
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
export class UpdateInvoiceDto {
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
/** The details of an uploaded invoice, so it lists and totals with the CRM's own invoices. */
export class InvoiceFileDetailsDto {
  @IsString() @MinLength(1) @MaxLength(60) invoiceNumber: string;
  @IsDateString() invoiceDate: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999_999) amount: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999_999) amountReceived?: number;
  /** How it was paid. Needed when anything has been received. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod | null;
}

export class InvoiceQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['paid', 'partial', 'unpaid', 'overdue', 'cancelled']) status?: string;
  @IsOptional() @IsUUID() clientId?: string;
}
export class NextNumberQuery {
  @IsOptional() @IsDateString() date?: string;
}
export class LedgerQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
}

export class AnalysisQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
}
