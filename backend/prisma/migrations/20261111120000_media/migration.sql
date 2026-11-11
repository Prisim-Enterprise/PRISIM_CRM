-- Media section: shoot, reel, content and image schedules, and production expenses.

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('SHOOT', 'REEL', 'CONTENT', 'IMAGE');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'READY', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MediaExpenseCategory" AS ENUM ('MODEL', 'LOCATION', 'EQUIPMENT', 'TRAVEL', 'FOOD', 'PROPS', 'OTHER');

-- CreateTable
CREATE TABLE "media_items" (
    "id" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PLANNED',
    "assigneeId" UUID,
    "clientId" UUID,
    "platform" TEXT,
    "location" TEXT,
    "models" TEXT,
    "link" TEXT,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_expenses" (
    "id" UUID NOT NULL,
    "spentOn" DATE NOT NULL,
    "category" "MediaExpenseCategory" NOT NULL,
    "payee" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paidOn" DATE,
    "shootId" UUID,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_items_kind_scheduledAt_idx" ON "media_items"("kind", "scheduledAt");

-- CreateIndex
CREATE INDEX "media_items_assigneeId_idx" ON "media_items"("assigneeId");

-- CreateIndex
CREATE INDEX "media_expenses_spentOn_idx" ON "media_expenses"("spentOn");

-- CreateIndex
CREATE INDEX "media_expenses_shootId_idx" ON "media_expenses"("shootId");

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_expenses" ADD CONSTRAINT "media_expenses_shootId_fkey" FOREIGN KEY ("shootId") REFERENCES "media_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_expenses" ADD CONSTRAINT "media_expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "media_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media_expenses" ENABLE ROW LEVEL SECURITY;

-- New permissions, given to the roles that get them by default.
INSERT INTO "permissions" ("id", "key", "group", "description") VALUES
    (gen_random_uuid(), 'media.view.all', 'Media', 'View the whole media schedule'),
    (gen_random_uuid(), 'media.manage', 'Media', 'Add, edit and assign media schedule entries'),
    (gen_random_uuid(), 'media.expenses', 'Media', 'View and record shoot and model expenses')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin') AND p."key" IN ('media.view.all', 'media.manage', 'media.expenses')
ON CONFLICT DO NOTHING;
