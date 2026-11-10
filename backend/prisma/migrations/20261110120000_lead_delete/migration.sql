-- Leads can be deleted. The source ids of deleted leads are kept so imports don't recreate them.
CREATE TABLE "deleted_leads" (
    "sourceId" UUID NOT NULL,
    "externalLeadId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deleted_leads_pkey" PRIMARY KEY ("sourceId", "externalLeadId")
);
ALTER TABLE "deleted_leads" ADD CONSTRAINT "deleted_leads_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "lead_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Blocks Supabase's Data API, like every other table.
ALTER TABLE "deleted_leads" ENABLE ROW LEVEL SECURITY;

-- New permission, given to the roles that get it by default.
INSERT INTO "permissions" ("id", "key", "group", "description")
VALUES (gen_random_uuid(), 'leads.delete', 'Leads', 'Delete leads permanently')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM "roles" r, "permissions" p
WHERE r."key" IN ('super_admin', 'admin') AND p."key" = 'leads.delete'
ON CONFLICT DO NOTHING;
