import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import { AccountingSettingsService } from '../accounting/settings.service';
import { EmployeeDto, PayDto, PayrollSettingsDto, PayslipDto, RunDto } from './payroll.dto';
import { PayrollService } from './payroll.service';

// Payroll, under Accounting:
//   payroll-calc.ts     the pay arithmetic: loss of pay, PF, ESI, Professional Tax, TDS (unit-tested)
//   payroll.service.ts  employees, monthly runs, payslips, exports and the employee's own payslips
// Everything needs accounting.payroll.manage, except an employee reading their own finalised payslips.

const MANAGE = 'accounting.payroll.manage';

@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollController {
  constructor(private payroll: PayrollService) {}

  @Get('settings') @RequireAny(MANAGE) settings() { return this.payroll.settings(); }
  @Put('settings') @RequireAny(MANAGE) saveSettings(@CurrentUser() u: AuthUser, @Body() dto: PayrollSettingsDto) { return this.payroll.saveSettings(u, dto); }

  @Get('employees') @RequireAny(MANAGE) employees() { return this.payroll.employees(); }
  @Get('employees/next-code') @RequireAny(MANAGE) async nextCode() { return { code: await this.payroll.nextCode() }; }
  @Get('users') @RequireAny(MANAGE) users() { return this.payroll.linkableUsers(); }
  @Post('employees') @RequireAny(MANAGE) createEmployee(@CurrentUser() u: AuthUser, @Body() dto: EmployeeDto) { return this.payroll.createEmployee(u, dto); }
  @Put('employees/:id') @RequireAny(MANAGE) updateEmployee(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EmployeeDto) { return this.payroll.updateEmployee(u, id, dto); }
  @Delete('employees/:id') @RequireAny(MANAGE) removeEmployee(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.removeEmployee(u, id); }

  @Get('runs') @RequireAny(MANAGE) runs() { return this.payroll.runs(); }
  @Post('runs') @RequireAny(MANAGE) createRun(@CurrentUser() u: AuthUser, @Body() dto: RunDto) { return this.payroll.createRun(u, dto); }
  @Get('runs/:id') @RequireAny(MANAGE) run(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.run(id); }
  @Delete('runs/:id') @RequireAny(MANAGE) removeRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.removeRun(u, id); }
  @Post('runs/:id/refresh') @RequireAny(MANAGE) refreshRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.refreshRun(u, id); }
  @Post('runs/:id/finalise') @RequireAny(MANAGE) finaliseRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.finaliseRun(u, id); }
  @Post('runs/:id/reopen') @RequireAny(MANAGE) reopenRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.reopenRun(u, id); }
  @Post('runs/:id/pay') @RequireAny(MANAGE) payRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) { return this.payroll.payRun(u, id, dto); }
  @Post('runs/:id/unpay') @RequireAny(MANAGE) unpayRun(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.unpayRun(u, id); }
  @Get('runs/:id/payslips') @RequireAny(MANAGE) runPayslips(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.runPayslips(id); }
  @Get('runs/:id/register.csv') @RequireAny(MANAGE)
  async register(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { this.sendCsv(res, await this.payroll.registerCsv(id)); }
  @Get('runs/:id/bank.csv') @RequireAny(MANAGE)
  async bank(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { this.sendCsv(res, await this.payroll.bankCsv(id)); }

  @Get('payslips/:id') @RequireAny(MANAGE) payslip(@Param('id', ParseUUIDPipe) id: string) { return this.payroll.payslip(id); }
  @Patch('payslips/:id') @RequireAny(MANAGE) updatePayslip(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayslipDto) { return this.payroll.updatePayslip(u, id, dto); }
  @Delete('payslips/:id') @RequireAny(MANAGE) removePayslip(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.removePayslip(u, id); }

  // Any signed-in person: only their own payslips, and only once the month is finalised.
  @Get('me/payslips') myPayslips(@CurrentUser() u: AuthUser) { return this.payroll.myPayslips(u); }
  @Get('me/payslips/:id') myPayslip(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.payroll.myPayslip(u, id); }

  private sendCsv(res: Response, f: { name: string; body: string }) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.send(f.body);
  }
}

@Module({ providers: [PayrollService, AccountingSettingsService], controllers: [PayrollController] })
export class PayrollModule {}
