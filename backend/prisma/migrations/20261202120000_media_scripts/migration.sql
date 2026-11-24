-- Scripts written for clients in Media: due date, and whether the client approved them.
-- CreateEnum
CREATE TYPE "MediaScriptStatus" AS ENUM ('WRITTEN', 'APPROVED');

-- CreateTable
CREATE TABLE "media_scripts" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "MediaScriptStatus" NOT NULL DEFAULT 'WRITTEN',
    "approvedAt" TIMESTAMP(3),
    "clientId" UUID NOT NULL,
    "writerId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_scripts_scheduledAt_idx" ON "media_scripts"("scheduledAt");

-- CreateIndex
CREATE INDEX "media_scripts_clientId_idx" ON "media_scripts"("clientId");

-- CreateIndex
CREATE INDEX "media_scripts_writerId_idx" ON "media_scripts"("writerId");

-- AddForeignKey
ALTER TABLE "media_scripts" ADD CONSTRAINT "media_scripts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_scripts" ADD CONSTRAINT "media_scripts_writerId_fkey" FOREIGN KEY ("writerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
