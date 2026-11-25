-- New role: Video Editor. Sees only their own tasks and the media schedule.
INSERT INTO "roles" ("id", "key", "name", "description", "isSystem", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'video_editor', 'Video Editor', 'Sees only Tasks (their own) and Media (the whole schedule; updates the entries assigned to them).', true, now(), now())
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" = 'video_editor' AND p."key" = 'media.view.all'
ON CONFLICT DO NOTHING;
