import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UploadedFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { FileUpload } from '../common/file-upload';
import { AuthUser, CurrentUser, RequireAny } from '../common/current-user';
import {
  AnalysisQuery, CategoryDto, DeleteManyDto, ExpenseDto, ExpenseQuery, InvoiceDto, InvoiceQuery, LedgerQuery, MonthQuery, NextNumberQuery, PaymentDto, ProjectDto,
  ProjectQuery, ReceiptParams, ReviewDto, SettingsDto, UpdateCategoryDto, UpdateExpenseDto, UpdateInvoiceDto, UpdateProjectDto,
} from './dto';
import { AccountingSettingsService } from './settings.service';
import { AnalysisService } from './analysis.service';
import { ExpensesService } from './expenses.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { ProjectsService } from './projects.service';
import { MANAGE, MAX_INVOICE_FILE_BYTES, MAX_RECEIPT_BYTES } from './shared';

// Routes without @RequireAny(MANAGE) are open to anyone who can submit expenses; the
// service then limits them to their own records (see expenseWhere / ownExpense).
@ApiTags('Accounting')
@ApiBearerAuth()
@Controller('accounting')
export class AccountingController {
  constructor(
    private cfg: AccountingSettingsService, private expenses: ExpensesService, private projects: ProjectsService,
    private invoices: InvoicesService, private ledgerSvc: LedgerService, private analysis: AnalysisService,
  ) {}

  @Get('settings') @RequireAny(MANAGE) settings() { return this.cfg.settings(); }
  @Put('settings') @RequireAny(MANAGE) saveSettings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) { return this.cfg.saveSettings(u, dto); }
  @Get('lookups') lookups(@CurrentUser() u: AuthUser) { return this.expenses.lookups(u); }
  @Get('ledger') @RequireAny(MANAGE) ledger(@Query() q: LedgerQuery) { return this.ledgerSvc.ledger(q); }
  @Get('analysis/clients') @RequireAny(MANAGE) clientAnalysis(@Query() q: AnalysisQuery) { return this.analysis.clients(q); }
  @Get('analysis/clients/:id') @RequireAny(MANAGE) clientDetailAnalysis(@Param('id', ParseUUIDPipe) id: string, @Query() q: AnalysisQuery) { return this.analysis.client(id, q); }

  @Get('categories') @RequireAny(MANAGE) categories(@Query() q: MonthQuery) { return this.expenses.categories(q); }
  @Post('categories') @RequireAny(MANAGE) createCategory(@CurrentUser() u: AuthUser, @Body() dto: CategoryDto) { return this.expenses.createCategory(u, dto); }
  @Patch('categories/:id') @RequireAny(MANAGE) updateCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) { return this.expenses.updateCategory(u, id, dto); }
  @Delete('categories/:id') @RequireAny(MANAGE) removeCategory(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.removeCategory(u, id); }

  @Get('expenses') listExpenses(@CurrentUser() u: AuthUser, @Query() q: ExpenseQuery) { return this.expenses.listExpenses(u, q); }
  @Get('expenses/export')
  async exportExpenses(@CurrentUser() u: AuthUser, @Query() q: ExpenseQuery, @Res() res: Response) {
    const { name, body } = await this.expenses.exportExpenses(u, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(body);
  }
  @Post('expenses') createExpense(@CurrentUser() u: AuthUser, @Body() dto: ExpenseDto) { return this.expenses.createExpense(u, dto); }
  @Post('expenses/review') @RequireAny(MANAGE) review(@CurrentUser() u: AuthUser, @Body() dto: ReviewDto) { return this.expenses.reviewExpenses(u, dto); }
  @Post('expenses/delete') @RequireAny(MANAGE) removeMany(@CurrentUser() u: AuthUser, @Body() dto: DeleteManyDto) { return this.expenses.removeExpenses(u, dto); }
  @Patch('expenses/:id') updateExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto) { return this.expenses.updateExpense(u, id, dto); }
  @Delete('expenses/:id') removeExpense(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.removeExpense(u, id); }
  @Post('expenses/:id/receipt')
  @FileUpload(MAX_RECEIPT_BYTES)
  attachReceipt(@CurrentUser() u: AuthUser, @Param() p: ReceiptParams, @UploadedFile() file: Express.Multer.File) { return this.expenses.attachReceipt(u, p.id, file); }
  @Get('expenses/:id/receipt') receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.expenses.receipt(u, id, res); }
  @Delete('expenses/:id/receipt') removeReceipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.removeReceipt(u, id); }

  @Get('invoice-files/:clientId') @RequireAny(MANAGE)
  listClientInvoiceFiles(@Param('clientId', ParseUUIDPipe) clientId: string) { return this.invoices.listClientInvoiceFiles(clientId); }
  @Post('invoice-files/:clientId') @RequireAny(MANAGE)
  @FileUpload(MAX_INVOICE_FILE_BYTES)
  uploadClientInvoiceFile(@CurrentUser() u: AuthUser, @Param('clientId', ParseUUIDPipe) clientId: string, @UploadedFile() file: Express.Multer.File) {
    return this.invoices.uploadClientInvoiceFile(u, clientId, file);
  }
  @Get('invoice-files/:id/file') @RequireAny(MANAGE)
  clientInvoiceFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.invoices.clientInvoiceFile(id, res); }
  @Delete('invoice-files/:id') @RequireAny(MANAGE)
  removeClientInvoiceFile(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.invoices.removeClientInvoiceFile(u, id); }

  @Get('projects') @RequireAny(MANAGE) listProjects(@Query() q: ProjectQuery) { return this.projects.listProjects(q); }
  @Get('projects/:id') @RequireAny(MANAGE) getProject(@Param('id', ParseUUIDPipe) id: string) { return this.projects.getProject(id); }
  @Post('projects') @RequireAny(MANAGE) createProject(@CurrentUser() u: AuthUser, @Body() dto: ProjectDto) { return this.projects.createProject(u, dto); }
  @Patch('projects/:id') @RequireAny(MANAGE) updateProject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) { return this.projects.updateProject(u, id, dto); }
  @Delete('projects/:id') @RequireAny(MANAGE) removeProject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.projects.removeProject(u, id); }
  @Post('projects/:id/payments') @RequireAny(MANAGE) addProjectPayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) { return this.projects.addProjectPayment(u, id, dto); }
  @Delete('project-payments/:id') @RequireAny(MANAGE) removeProjectPayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.projects.removeProjectPayment(u, id); }

  @Get('invoices') @RequireAny(MANAGE) listInvoices(@Query() q: InvoiceQuery) { return this.invoices.listInvoices(q); }
  @Get('invoices/next-number') @RequireAny(MANAGE) nextNumber(@Query() q: NextNumberQuery) { return this.invoices.nextInvoiceNumber(q.date?.slice(0, 10)); }
  @Post('invoices/from-quotation/:id') @RequireAny(MANAGE) fromQuotation(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.invoices.invoiceFromQuotation(u, id); }
  @Get('invoices/:id') @RequireAny(MANAGE) getInvoice(@Param('id', ParseUUIDPipe) id: string) { return this.invoices.getInvoice(id); }
  @Post('invoices') @RequireAny(MANAGE) createInvoice(@CurrentUser() u: AuthUser, @Body() dto: InvoiceDto) { return this.invoices.createInvoice(u, dto); }
  @Patch('invoices/:id') @RequireAny(MANAGE) updateInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) { return this.invoices.updateInvoice(u, id, dto); }
  @Delete('invoices/:id') @RequireAny(MANAGE) removeInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.invoices.removeInvoice(u, id); }
  @Post('invoices/:id/payments') @RequireAny(MANAGE) addInvoicePayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto) { return this.invoices.addInvoicePayment(u, id, dto); }
  @Delete('invoice-payments/:id') @RequireAny(MANAGE) removeInvoicePayment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.invoices.removeInvoicePayment(u, id); }
}
