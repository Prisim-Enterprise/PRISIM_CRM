-- Invoice in the tax-invoice format: header boxes and a separate consignee (ship to).

-- AlterTable
ALTER TABLE "acct_invoices" ADD COLUMN     "extra" JSONB,
ADD COLUMN     "shipTo" JSONB;
