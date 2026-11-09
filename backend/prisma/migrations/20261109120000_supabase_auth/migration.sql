-- Sign-in moved from Clerk to Supabase Auth. Old Clerk ids mean nothing there, so each
-- person links again by verified email on their first sign-in.
ALTER TABLE "users" RENAME COLUMN "clerkUserId" TO "authUserId";
UPDATE "users" SET "authUserId" = NULL;
ALTER INDEX "users_clerkUserId_key" RENAME TO "users_authUserId_key";
