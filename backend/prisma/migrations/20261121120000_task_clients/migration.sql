-- Tasks can be linked to one or more clients.

-- CreateTable
CREATE TABLE "task_clients" (
    "taskId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_clients_pkey" PRIMARY KEY ("taskId","clientId")
);

-- CreateIndex
CREATE INDEX "task_clients_clientId_idx" ON "task_clients"("clientId");

-- AddForeignKey
ALTER TABLE "task_clients" ADD CONSTRAINT "task_clients_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_clients" ADD CONSTRAINT "task_clients_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "task_clients" ENABLE ROW LEVEL SECURITY;
