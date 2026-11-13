-- People can belong to several teams. users.teamId stays as their main team.

-- CreateTable
CREATE TABLE "team_members" (
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;

-- Everyone keeps the team they are in now.
INSERT INTO "team_members" ("teamId", "userId", "createdAt")
SELECT "teamId", "id", "createdAt" FROM "users" WHERE "teamId" IS NOT NULL
ON CONFLICT DO NOTHING;
