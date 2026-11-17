import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingSettingsService } from './settings.service';
import { ExpensesService } from './expenses.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { ProjectsService } from './projects.service';

// Accounting is split by area:
//   shared.ts            pure money / permission helpers (unit-tested in accounting.spec.ts)
//   dto.ts               request validation
//   settings.service.ts  company details, numbering, financial year
//   expenses.service.ts  expenses, receipts, categories and budgets
//   projects.service.ts  client projects and their payments
//   invoices.service.ts  tax invoices, payments, client invoice files
//   ledger.service.ts    raw figures for the dashboard and reports
@Module({
  providers: [AccountingSettingsService, ExpensesService, ProjectsService, InvoicesService, LedgerService],
  controllers: [AccountingController],
})
export class AccountingModule {}

export { AcctSettingsData, DEFAULT_SETTINGS, invoiceTotals } from './shared';
