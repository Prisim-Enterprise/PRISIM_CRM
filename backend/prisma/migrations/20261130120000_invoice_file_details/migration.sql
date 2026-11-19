-- Uploaded invoices get their own details (number, dates, amount, amount received),
-- so they list and total alongside the invoices made in the CRM.
-- AlterTable
ALTER TABLE "acct_invoice_files" ADD COLUMN     "amount" DECIMAL(14,2),
ADD COLUMN     "amountReceived" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "invoiceDate" DATE,
ADD COLUMN     "invoiceNumber" TEXT;

