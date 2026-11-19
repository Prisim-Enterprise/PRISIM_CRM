-- Payroll: employees, monthly runs and payslips, under Accounting. Super Admin only by default.
-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'FINALISED', 'PAID');

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_employees" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "designation" TEXT,
    "department" TEXT,
    "location" TEXT,
    "dateOfJoining" DATE NOT NULL,
    "dateOfLeaving" DATE,
    "pan" TEXT,
    "uan" TEXT,
    "pfNumber" TEXT,
    "esiNumber" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "ifsc" TEXT,
    "paymentMethod" "AcctPaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "components" JSONB NOT NULL,
    "pfEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pfCapped" BOOLEAN NOT NULL DEFAULT true,
    "esiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ptEnabled" BOOLEAN NOT NULL DEFAULT true,
    "monthlyTds" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "paidOn" DATE,
    "expenseId" UUID,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "finalisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "lopDays" DECIMAL(4,1) NOT NULL DEFAULT 0,
    "extraEarnings" JSONB NOT NULL DEFAULT '[]',
    "otherDeductions" JSONB NOT NULL DEFAULT '[]',
    "tdsOverride" DECIMAL(12,2),
    "remarks" TEXT,
    "calc" JSONB NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "totalDeductions" DECIMAL(12,2) NOT NULL,
    "netPay" DECIMAL(12,2) NOT NULL,
    "employerCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_employees_userId_key" ON "payroll_employees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_employees_code_key" ON "payroll_employees"("code");

-- CreateIndex
CREATE INDEX "payroll_employees_dateOfLeaving_idx" ON "payroll_employees"("dateOfLeaving");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_month_key" ON "payroll_runs"("month");

-- CreateIndex
CREATE INDEX "payslips_employeeId_idx" ON "payslips"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_runId_employeeId_key" ON "payslips"("runId", "employeeId");

-- AddForeignKey
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security on, with no policies: only the CRM's own database connection reads these.
ALTER TABLE "payroll_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payslips" ENABLE ROW LEVEL SECURITY;

-- New permission: run payroll. Super Admin only.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'accounting.payroll.manage', 'Accounting', 'Payroll: employees, salaries, monthly payroll runs and payslips')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" = 'super_admin' AND p."key" = 'accounting.payroll.manage'
ON CONFLICT DO NOTHING;
