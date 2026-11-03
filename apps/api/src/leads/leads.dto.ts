import { LeadStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength,
} from 'class-validator';
import { OmitType } from '@nestjs/swagger';
import { PageQuery } from '../common/pagination';

const toArray = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',');

export class LeadQuery extends PageQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(toArray) @IsEnum(LeadStatus, { each: true }) status?: LeadStatus[];
  /** "me", "unassigned" or a user id */
  @IsOptional() @IsString() owner?: string;
  @IsOptional() @IsUUID() teamId?: string;
  @IsOptional() @IsString() campaign?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsIn(['true', 'false']) open?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsIn(['newest', 'oldest', 'updated']) sort?: string;
}

export class CreateLeadDto {
  @IsString() @MinLength(1) @MaxLength(200) fullName: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(200) campaignName?: string;
  @IsOptional() @IsUUID() assignToUserId?: string;
  /** Create even if a lead with the same phone exists */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) fullName?: string;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() @MaxLength(100) city?: string | null;
}

export class StatusDto {
  @IsEnum(LeadStatus) status: LeadStatus;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsUUID() duplicateOfId?: string;
}

export class NoteDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}

export class AssignDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) leadIds: string[];
  @IsIn(['manual', 'round_robin', 'workload']) method: 'manual' | 'round_robin' | 'workload';
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) userIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class UnassignDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AssignOneDto extends OmitType(AssignDto, ['leadIds'] as const) {}
