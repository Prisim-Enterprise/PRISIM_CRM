-- Sign-in moved to Clerk: users link to a Clerk account and no longer need a local password.
ALTER TABLE "users" ADD COLUMN "clerkUserId" TEXT;
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
CREATE UNIQUE INDEX "users_clerkUserId_key" ON "users"("clerkUserId");
