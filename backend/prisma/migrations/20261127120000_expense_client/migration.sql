-- Expenses can belong to a client directly, not only through a project.
ALTER TABLE "acct_expenses" ADD COLUMN "clientId" UUID;

ALTER TABLE "acct_expenses" ADD CONSTRAINT "acct_expenses_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "acct_expenses_clientId_idx" ON "acct_expenses"("clientId");

-- Existing project expenses belong to that project's client.
UPDATE "acct_expenses" e SET "clientId" = p."clientId"
FROM "acct_projects" p
WHERE e."projectId" = p."id" AND e."clientId" IS NULL;
