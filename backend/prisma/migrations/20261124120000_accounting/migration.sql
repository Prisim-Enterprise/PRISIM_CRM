-- Accounting, built into the CRM: expenses, approvals, categories & budgets, client projects, invoices.

-- CreateEnum
CREATE TYPE "AcctExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "AcctPaymentMethod" AS ENUM ('BANK_TRANSFER', 'UPI', 'CASH', 'CARD', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "AcctProjectStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "acct_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acct_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "monthlyBudget" DECIMAL(14,2),
    "annualBudget" DECIMAL(14,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acct_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_vendors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acct_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_expenses" (
    "id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "dateIncurred" DATE NOT NULL,
    "datePaid" DATE,
    "categoryId" UUID,
    "vendorId" UUID,
    "projectId" UUID,
    "paymentMethod" "AcctPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "status" "AcctExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "receiptKey" TEXT,
    "receiptName" TEXT,
    "receiptType" TEXT,
    "submittedById" UUID NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acct_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_projects" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "meetingDate" DATE,
    "shootStart" DATE,
    "shootEnd" DATE,
    "quotedAmount" DECIMAL(14,2),
    "status" "AcctProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acct_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_project_payments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "AcctPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acct_project_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dueDate" DATE,
    "clientId" UUID,
    "clientName" TEXT NOT NULL,
    "clientDetails" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "notes" TEXT,
    "terms" JSONB NOT NULL,
    "preparedBy" TEXT,
    "quotationId" UUID,
    "projectId" UUID,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acct_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acct_invoice_payments" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "AcctPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acct_invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acct_categories_parentId_idx" ON "acct_categories"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "acct_vendors_name_key" ON "acct_vendors"("name");

-- CreateIndex
CREATE INDEX "acct_expenses_dateIncurred_idx" ON "acct_expenses"("dateIncurred");

-- CreateIndex
CREATE INDEX "acct_expenses_status_idx" ON "acct_expenses"("status");

-- CreateIndex
CREATE INDEX "acct_expenses_categoryId_idx" ON "acct_expenses"("categoryId");

-- CreateIndex
CREATE INDEX "acct_expenses_vendorId_idx" ON "acct_expenses"("vendorId");

-- CreateIndex
CREATE INDEX "acct_expenses_projectId_idx" ON "acct_expenses"("projectId");

-- CreateIndex
CREATE INDEX "acct_expenses_submittedById_idx" ON "acct_expenses"("submittedById");

-- CreateIndex
CREATE INDEX "acct_projects_clientId_idx" ON "acct_projects"("clientId");

-- CreateIndex
CREATE INDEX "acct_project_payments_projectId_idx" ON "acct_project_payments"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "acct_invoices_number_key" ON "acct_invoices"("number");

-- CreateIndex
CREATE INDEX "acct_invoices_date_idx" ON "acct_invoices"("date");

-- CreateIndex
CREATE INDEX "acct_invoices_clientId_idx" ON "acct_invoices"("clientId");

-- CreateIndex
CREATE INDEX "acct_invoices_projectId_idx" ON "acct_invoices"("projectId");

-- CreateIndex
CREATE INDEX "acct_invoice_payments_invoiceId_idx" ON "acct_invoice_payments"("invoiceId");

-- AddForeignKey
ALTER TABLE "acct_categories" ADD CONSTRAINT "acct_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "acct_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "acct_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "acct_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "acct_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_projects" ADD CONSTRAINT "acct_projects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_projects" ADD CONSTRAINT "acct_projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_project_payments" ADD CONSTRAINT "acct_project_payments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "acct_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_invoices" ADD CONSTRAINT "acct_invoices_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_invoices" ADD CONSTRAINT "acct_invoices_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_invoices" ADD CONSTRAINT "acct_invoices_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "acct_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_invoices" ADD CONSTRAINT "acct_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acct_invoice_payments" ADD CONSTRAINT "acct_invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "acct_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "acct_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_project_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_invoice_payments" ENABLE ROW LEVEL SECURITY;

-- Permissions: full accounting for the Super Admin; submitting expenses can be granted to anyone.
INSERT INTO "permissions" ("id", "key", "group", "description") VALUES
  (gen_random_uuid(), 'accounting.manage', 'Accounting', 'Full accounting: every section, approve expenses, invoices and settings'),
  (gen_random_uuid(), 'accounting.expenses.submit', 'Accounting', 'Submit own expenses for approval')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" = 'super_admin' AND p."key" IN ('accounting.manage', 'accounting.expenses.submit')
ON CONFLICT DO NOTHING;

-- Starter categories (no budgets yet; set them under Categories & Budgets).
WITH parents AS (
  INSERT INTO "acct_categories" ("id", "name", "sortOrder") VALUES
    (gen_random_uuid(), 'Production', 1),
    (gen_random_uuid(), 'Operations', 2),
    (gen_random_uuid(), 'Payroll & People', 3),
    (gen_random_uuid(), 'Marketing', 4),
    (gen_random_uuid(), 'Travel', 5),
    (gen_random_uuid(), 'Office & Facilities', 6),
    (gen_random_uuid(), 'Professional Services', 7),
    (gen_random_uuid(), 'Miscellaneous', 8)
  RETURNING "id", "name"
)
INSERT INTO "acct_categories" ("id", "name", "parentId", "sortOrder")
SELECT gen_random_uuid(), c.child, p."id", c.ord
FROM parents p
JOIN (VALUES
  ('Production', 'Model fees', 1), ('Production', 'Equipment rental', 2), ('Production', 'Location & props', 3), ('Production', 'Food on shoot', 4),
  ('Operations', 'Software & SaaS', 1), ('Operations', 'Cloud & hosting', 2), ('Operations', 'Hardware', 3),
  ('Payroll & People', 'Salaries', 1), ('Payroll & People', 'Freelancers', 2), ('Payroll & People', 'Training', 3),
  ('Marketing', 'Advertising', 1), ('Marketing', 'Events', 2),
  ('Travel', 'Fuel & local travel', 1), ('Travel', 'Flights & trains', 2), ('Travel', 'Lodging', 3), ('Travel', 'Meals', 4),
  ('Office & Facilities', 'Rent', 1), ('Office & Facilities', 'Electricity & internet', 2), ('Office & Facilities', 'Supplies', 3),
  ('Professional Services', 'Legal', 1), ('Professional Services', 'Accounting & tax', 2)
) AS c(parent, child, ord) ON c.parent = p."name";
