import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { LeadsService } from './leads.service';
import { AssignDto, AssignOneDto, CreateLeadDto, LeadQuery, NoteDto, StatusDto, UnassignDto, UpdateLeadDto } from './leads.dto';

@ApiTags('Leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private leads: LeadsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: LeadQuery) {
    return this.leads.list(user, q);
  }

  @Get('filters')
  filters() {
    return this.leads.filterOptions();
  }

  @Get('export')
  @RequireAny('leads.export')
  async export(@CurrentUser() user: AuthUser, @Query() q: LeadQuery, @Res() res: Response) {
    const csv = await this.leads.exportCsv(user, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  }

  @Post()
  @RequireAny('leads.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadDto) {
    return this.leads.create(user, dto);
  }

  @Post('assign')
  @RequireAny('leads.assign.all', 'leads.assign.team')
  assign(@CurrentUser() user: AuthUser, @Body() dto: AssignDto) {
    return this.leads.assign(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(user, id);
  }

  @Get(':id/history')
  timeline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.timeline(user, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLeadDto) {
    return this.leads.update(user, id, dto);
  }

  @Post(':id/status')
  status(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    return this.leads.changeStatus(user, id, dto.status, dto.reason, dto.duplicateOfId);
  }

  @Post(':id/notes')
  note(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.leads.addNote(user, id, dto.body);
  }

  @Post(':id/assign')
  @RequireAny('leads.assign.all', 'leads.assign.team')
  assignOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignOneDto) {
    return this.leads.assign(user, { ...dto, leadIds: [id] });
  }

  @Post(':id/unassign')
  @RequireAny('leads.assign.all', 'leads.assign.team')
  unassign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UnassignDto) {
    return this.leads.unassign(user, id, dto.reason);
  }
}

@Module({ providers: [LeadsService], controllers: [LeadsController], exports: [LeadsService] })
export class LeadsModule {}
