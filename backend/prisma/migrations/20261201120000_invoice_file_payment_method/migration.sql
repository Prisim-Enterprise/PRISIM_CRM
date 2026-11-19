-- How the amount received on an uploaded invoice was paid.
-- AlterTable
ALTER TABLE "acct_invoice_files" ADD COLUMN     "paymentMethod" "AcctPaymentMethod";

