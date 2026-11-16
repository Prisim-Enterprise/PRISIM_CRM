-- Reports cover every team: Performance Marketer loses organisation-wide report access (Super Admin and Admin only).
DELETE FROM "role_permissions"
WHERE "permissionId" = (SELECT "id" FROM "permissions" WHERE "key" = 'reports.view.all')
  AND "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'performance_marketer');
