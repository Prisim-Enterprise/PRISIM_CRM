import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { AcctPaymentMethod } from '@prisma/client';

// Request bodies for the payroll API.

const MONEY = { maxDecimalPlaces: 2 };

export class ComponentDto {
  @IsString() @MinLength(1) @MaxLength(60) name: string;
  @IsNumber(MONEY) @Min(0) @Max(99_999_999) amount: number;
  @IsOptional() @IsBoolean() pf?: boolean;
}

export class LineItemDto {
  @IsString() @MinLength(1) @MaxLength(60) name: string;
  @IsNumber(MONEY) @Min(0) @Max(99_999_999) amount: number;
}

const optText = (max: number) => [IsOptional(), ValidateIf((_: unknown, v: unknown) => v !== null), IsString(), MaxLength(max)];
function OptText(max: number): PropertyDecorator {
  return (target, key) => optText(max).forEach((d) => d(target, key));
}

export class EmployeeDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() userId?: string | null;
  /** Employee ID printed on the payslip. Left empty, the next one (EMP001, EMP002…) is used. */
  @IsOptional() @Matches(/^[A-Za-z0-9/_-]{0,20}$/, { message: 'Employee ID: up to 20 letters, numbers, / _ or -' }) code?: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsEmail() email?: string | null;
  @OptText(30) phone?: string | null;
  @OptText(80) designation?: string | null;
  @OptText(80) department?: string | null;
  @OptText(80) location?: string | null;
  @IsDateString() dateOfJoining: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dateOfLeaving?: string | null;
  @IsOptional() @Matches(/^$|^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'PAN is 10 characters, like ABCDE1234F' }) pan?: string;
  @IsOptional() @Matches(/^$|^\d{12}$/, { message: 'UAN is 12 digits' }) uan?: string;
  @OptText(40) pfNumber?: string | null;
  @IsOptional() @Matches(/^$|^\d{10,17}$/, { message: 'ESI number is 10 to 17 digits' }) esiNumber?: string;
  @OptText(80) bankName?: string | null;
  @IsOptional() @Matches(/^$|^[0-9]{6,20}$/, { message: 'Account number is 6 to 20 digits' }) accountNumber?: string;
  @IsOptional() @Matches(/^$|^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'IFSC is 11 characters, like HDFC0001234' }) ifsc?: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) paymentMethod?: AcctPaymentMethod;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ComponentDto) components: ComponentDto[];
  @IsOptional() @IsBoolean() pfEnabled?: boolean;
  @IsOptional() @IsBoolean() pfCapped?: boolean;
  @IsOptional() @IsBoolean() esiEnabled?: boolean;
  @IsOptional() @IsBoolean() ptEnabled?: boolean;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(99_999_999) monthlyTds?: number;
  @OptText(2000) notes?: string | null;
}

export class RunDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Month is like 2026-11' }) month: string;
}

export class PayslipDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(31) lopDays?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineItemDto) extraEarnings?: LineItemDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineItemDto) otherDeductions?: LineItemDto[];
  /** null goes back to the employee's usual monthly TDS. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber(MONEY) @Min(0) @Max(99_999_999) tdsOverride?: number | null;
  @OptText(500) remarks?: string | null;
}

export class PayDto {
  @IsDateString() paidOn: string;
  @IsOptional() @IsEnum(AcctPaymentMethod) method?: AcctPaymentMethod;
  /** Also record the month's salary cost as an expense in Accounting. */
  @IsOptional() @IsBoolean() recordExpense?: boolean;
}

export class PfSettingsDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) employeeRate: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) employerRate: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) epsRate: number;
  @IsNumber(MONEY) @Min(0) @Max(10_000_000) wageCeiling: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) edliRate: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) adminRate: number;
}
export class EsiSettingsDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) employeeRate: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) employerRate: number;
  @IsNumber(MONEY) @Min(0) @Max(10_000_000) wageLimit: number;
}
export class PtSlabDto {
  @IsNumber(MONEY) @Min(0) @Max(100_000_000) from: number;
  @IsNumber(MONEY) @Min(0) @Max(100_000) amount: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber(MONEY) @Min(0) @Max(100_000) february?: number | null;
}
export class PtSettingsDto {
  @IsString() @MaxLength(60) state: string;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PtSlabDto) slabs: PtSlabDto[];
}
export class StatutoryDto {
  @IsBoolean() pf: boolean;
  @IsBoolean() esi: boolean;
  @IsBoolean() pt: boolean;
  @IsBoolean() tds: boolean;
}
export class PayrollSettingsDto {
  @ValidateNested() @Type(() => StatutoryDto) statutory: StatutoryDto;
  @ValidateNested() @Type(() => PfSettingsDto) pf: PfSettingsDto;
  @ValidateNested() @Type(() => EsiSettingsDto) esi: EsiSettingsDto;
  @ValidateNested() @Type(() => PtSettingsDto) pt: PtSettingsDto;
  @IsIn(['calendar', 'fixed30']) lopBasis: 'calendar' | 'fixed30';
  @IsString() @MaxLength(500) payslipNote: string;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ComponentDto) defaultComponents: ComponentDto[];
}
