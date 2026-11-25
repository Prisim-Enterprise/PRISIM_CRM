-- New permission: assign work to anyone in the organisation, not just own team.
-- Super Admin and Admin / Manager could already do this (through tasks.manage.all), so they get it too.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'tasks.assign.anyone', 'Tasks', 'Assign work to anyone in the organisation, not just own team')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin') AND p."key" = 'tasks.assign.anyone'
ON CONFLICT DO NOTHING;
