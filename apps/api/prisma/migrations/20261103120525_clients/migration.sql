-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ClientWorkStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'SUBMITTED', 'DONE');

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "clientWorkId" UUID;

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_work" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ClientWorkStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_work_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_work_assignees" (
    "workId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_work_assignees_pkey" PRIMARY KEY ("workId","userId")
);

-- CreateTable
CREATE TABLE "client_work_updates" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT,
    "fromStatus" "ClientWorkStatus",
    "toStatus" "ClientWorkStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_work_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE INDEX "client_work_clientId_status_idx" ON "client_work"("clientId", "status");

-- CreateIndex
CREATE INDEX "client_work_assignees_userId_idx" ON "client_work_assignees"("userId");

-- CreateIndex
CREATE INDEX "client_work_updates_workId_createdAt_idx" ON "client_work_updates"("workId", "createdAt");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work" ADD CONSTRAINT "client_work_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work" ADD CONSTRAINT "client_work_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work_assignees" ADD CONSTRAINT "client_work_assignees_workId_fkey" FOREIGN KEY ("workId") REFERENCES "client_work"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work_assignees" ADD CONSTRAINT "client_work_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work_updates" ADD CONSTRAINT "client_work_updates_workId_fkey" FOREIGN KEY ("workId") REFERENCES "client_work"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_work_updates" ADD CONSTRAINT "client_work_updates_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_clientWorkId_fkey" FOREIGN KEY ("clientWorkId") REFERENCES "client_work"("id") ON DELETE CASCADE ON UPDATE CASCADE;
