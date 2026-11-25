-- A schedule entry can be for several clients.

-- CreateTable
CREATE TABLE "media_item_clients" (
    "itemId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_item_clients_pkey" PRIMARY KEY ("itemId","clientId")
);

-- CreateIndex
CREATE INDEX "media_item_clients_clientId_idx" ON "media_item_clients"("clientId");

-- AddForeignKey
ALTER TABLE "media_item_clients" ADD CONSTRAINT "media_item_clients_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_item_clients" ADD CONSTRAINT "media_item_clients_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep each entry's existing client.
INSERT INTO "media_item_clients" ("itemId", "clientId")
SELECT "id", "clientId" FROM "media_items" WHERE "clientId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "media_items" DROP CONSTRAINT "media_items_clientId_fkey";

-- AlterTable
ALTER TABLE "media_items" DROP COLUMN "clientId";
