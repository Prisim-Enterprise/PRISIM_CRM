-- Who edits and who posts a media entry, and the To-do task each of them gets.
-- AlterTable
ALTER TABLE "media_items" ADD COLUMN     "editTaskId" UUID,
ADD COLUMN     "editorId" UUID,
ADD COLUMN     "postTaskId" UUID,
ADD COLUMN     "posterId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "media_items_editTaskId_key" ON "media_items"("editTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "media_items_postTaskId_key" ON "media_items"("postTaskId");

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_posterId_fkey" FOREIGN KEY ("posterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_editTaskId_fkey" FOREIGN KEY ("editTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_postTaskId_fkey" FOREIGN KEY ("postTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

