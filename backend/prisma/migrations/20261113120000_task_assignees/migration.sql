-- Tasks can have several assignees. tasks.assigneeId stays as the first of them.

-- CreateTable
CREATE TABLE "task_assignees" (
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_assignees_pkey" PRIMARY KEY ("taskId","userId")
);

-- CreateIndex
CREATE INDEX "task_assignees_userId_idx" ON "task_assignees"("userId");

-- AddForeignKey
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "task_assignees" ENABLE ROW LEVEL SECURITY;

-- Existing tasks keep their assignee.
INSERT INTO "task_assignees" ("taskId", "userId", "createdAt")
SELECT "id", "assigneeId", "createdAt" FROM "tasks" WHERE "assigneeId" IS NOT NULL
ON CONFLICT DO NOTHING;
