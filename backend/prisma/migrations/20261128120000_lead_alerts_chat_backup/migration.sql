-- Lead alerts: untouched leads and long-overdue follow-ups are flagged once per lapse.
ALTER TABLE "leads" ADD COLUMN "nudgedAt" TIMESTAMP(3), ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "follow_ups" ADD COLUMN "escalatedAt" TIMESTAMP(3);

-- Permanent Team chat archive.
CREATE TABLE "chat_archive" (
    "id" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "senderName" TEXT NOT NULL,
    "recipientId" UUID,
    "recipientName" TEXT,
    "kind" "MessageKind" NOT NULL,
    "body" TEXT,
    "audioKey" TEXT,
    "audioType" TEXT,
    "durationSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "unsentAt" TIMESTAMP(3),
    CONSTRAINT "chat_archive_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_archive_createdAt_idx" ON "chat_archive"("createdAt");
CREATE INDEX "chat_archive_recipientId_createdAt_idx" ON "chat_archive"("recipientId", "createdAt");
CREATE INDEX "chat_archive_senderId_createdAt_idx" ON "chat_archive"("senderId", "createdAt");
ALTER TABLE "chat_archive" ENABLE ROW LEVEL SECURITY;

-- Keep everything still in Team chat today.
INSERT INTO "chat_archive" ("id", "senderId", "senderName", "recipientId", "recipientName", "kind", "body", "audioKey", "audioType", "durationSec", "createdAt")
SELECT m."id", m."senderId", s."fullName", m."recipientId", r."fullName", m."kind", m."body", m."audioKey", m."audioType", m."durationSec", m."createdAt"
FROM "messages" m
JOIN "users" s ON s."id" = m."senderId"
LEFT JOIN "users" r ON r."id" = m."recipientId"
ON CONFLICT ("id") DO NOTHING;

-- New permission: read the chat backup. Super Admin only.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'chat.backup.view', 'Team chat', 'Read the full chat backup: every conversation, kept after the weekly reset')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" = 'super_admin' AND p."key" = 'chat.backup.view'
ON CONFLICT DO NOTHING;

-- Calling has been removed from the CRM. Its permissions go (role and per-user links cascade).
-- Past call records and recordings are kept in call_logs; nothing reads them any more.
DELETE FROM "permissions" WHERE "key" IN ('calls.view.all', 'calls.view.team', 'calls.recordings.all', 'calls.recordings.team');
UPDATE "permissions" SET "description" = 'Configure Google Sheets, the lead webhook and lead alerts' WHERE "key" = 'integrations.manage';
UPDATE "roles" SET "description" = replace("description", 'Google Sheets and telephony setup', 'Google Sheets and lead webhook setup') WHERE "description" LIKE '%telephony%';
