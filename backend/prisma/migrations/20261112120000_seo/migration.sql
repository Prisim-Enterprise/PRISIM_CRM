-- SEO section: who handles which client, and daily updates.

-- CreateEnum
CREATE TYPE "SeoStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');

-- CreateTable
CREATE TABLE "seo_accounts" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "website" TEXT,
    "scope" TEXT,
    "status" "SeoStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_assignees" (
    "accountId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seo_assignees_pkey" PRIMARY KEY ("accountId","userId")
);

-- CreateTable
CREATE TABLE "seo_updates" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "workDate" DATE NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seo_accounts_clientId_idx" ON "seo_accounts"("clientId");

-- CreateIndex
CREATE INDEX "seo_assignees_userId_idx" ON "seo_assignees"("userId");

-- CreateIndex
CREATE INDEX "seo_updates_accountId_workDate_idx" ON "seo_updates"("accountId", "workDate");

-- CreateIndex
CREATE INDEX "seo_updates_authorId_workDate_idx" ON "seo_updates"("authorId", "workDate");

-- AddForeignKey
ALTER TABLE "seo_accounts" ADD CONSTRAINT "seo_accounts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_accounts" ADD CONSTRAINT "seo_accounts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_assignees" ADD CONSTRAINT "seo_assignees_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "seo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_assignees" ADD CONSTRAINT "seo_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_updates" ADD CONSTRAINT "seo_updates_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "seo_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_updates" ADD CONSTRAINT "seo_updates_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "seo_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seo_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seo_updates" ENABLE ROW LEVEL SECURITY;

-- New permissions, given to Super Admin and Admin.
INSERT INTO "permissions" ("id", "key", "group", "description") VALUES
    (gen_random_uuid(), 'seo.view.all', 'SEO', 'View every SEO client and all daily updates'),
    (gen_random_uuid(), 'seo.manage', 'SEO', 'Add SEO clients and choose who handles them')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin') AND p."key" IN ('seo.view.all', 'seo.manage')
ON CONFLICT DO NOTHING;
