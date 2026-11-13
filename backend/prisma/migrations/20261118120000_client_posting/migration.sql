-- Client posting calendar: lead periods and the reel / AI poster for each date, with reminders.

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('NONE', 'NOT_YET', 'DONE');

-- CreateTable
CREATE TABLE "posting_periods" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "leadStart" DATE NOT NULL,
    "leadEnd" DATE NOT NULL,
    "shootDate" DATE,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting_slots" (
    "id" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "video" TEXT,
    "videoStatus" "PostingStatus" NOT NULL DEFAULT 'NONE',
    "poster" TEXT,
    "posterStatus" "PostingStatus" NOT NULL DEFAULT 'NONE',
    "leads" TEXT,
    "reminderSentOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posting_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posting_periods_clientId_leadStart_idx" ON "posting_periods"("clientId", "leadStart");

-- CreateIndex
CREATE INDEX "posting_slots_periodId_date_idx" ON "posting_slots"("periodId", "date");

-- CreateIndex
CREATE INDEX "posting_slots_date_idx" ON "posting_slots"("date");

-- AddForeignKey
ALTER TABLE "posting_periods" ADD CONSTRAINT "posting_periods_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_periods" ADD CONSTRAINT "posting_periods_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_slots" ADD CONSTRAINT "posting_slots_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "posting_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "posting_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "posting_slots" ENABLE ROW LEVEL SECURITY;

-- New permission, given to Super Admin and Admin.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'clients.posting', 'Clients', 'Edit client posting calendars and get their reminders')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin') AND p."key" = 'clients.posting'
ON CONFLICT DO NOTHING;
