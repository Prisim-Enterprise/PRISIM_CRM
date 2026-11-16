-- Quotations in Prisim's format, shared by sales and accounts.

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "validityDays" INTEGER NOT NULL DEFAULT 15,
    "clientId" UUID,
    "clientName" TEXT NOT NULL,
    "address" TEXT,
    "items" JSONB NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "terms" JSONB NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotations_number_key" ON "quotations"("number");

-- CreateIndex
CREATE INDEX "quotations_date_idx" ON "quotations"("date");

-- CreateIndex
CREATE INDEX "quotations_clientId_idx" ON "quotations"("clientId");

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;

-- New permission: Super Admin, Admin and Sales Employee by default.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'quotations.manage', 'Quotations', 'Create, edit and print quotations')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin', 'employee') AND p."key" = 'quotations.manage'
ON CONFLICT DO NOTHING;
