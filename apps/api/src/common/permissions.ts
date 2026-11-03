// Central permission catalog. Roles are configurable bundles of these keys.
// "Own" access (own leads, own tasks, own calls, own feedback) is always implied.
export const PERMISSIONS = {
  // Leads
  'leads.view.all': ['Leads', 'View all leads'],
  'leads.view.team': ['Leads', 'View leads owned by own team'],
  'leads.edit.all': ['Leads', 'Edit any lead (status, notes, details)'],
  'leads.edit.team': ['Leads', 'Edit leads owned by own team'],
  'leads.create': ['Leads', 'Create leads manually'],
  'leads.import': ['Leads', 'Import leads / trigger Google Sheets sync'],
  'leads.assign.all': ['Leads', 'Assign or reassign any lead'],
  'leads.assign.team': ['Leads', 'Assign leads within own team'],
  'leads.export': ['Leads', 'Export lead data'],
  // Follow-ups
  'followups.view.all': ['Follow-ups', "View everyone's follow-ups"],
  'followups.view.team': ['Follow-ups', "View own team's follow-ups"],
  // Calls
  'calls.view.all': ['Calls', 'View all call logs'],
  'calls.view.team': ['Calls', "View own team's call logs"],
  'calls.recordings.all': ['Calls', 'Listen to all call recordings'],
  'calls.recordings.team': ['Calls', "Listen to own team's recordings"],
  // Tasks
  'tasks.view.all': ['Tasks', 'View all tasks'],
  'tasks.view.team': ['Tasks', "View own team's tasks"],
  'tasks.manage.all': ['Tasks', 'Edit, reassign and review any task'],
  'tasks.manage.team': ['Tasks', 'Edit, reassign and review team tasks'],
  'tasks.create_for_others': ['Tasks', 'Create tasks for other people'],
  // Feedback
  'feedback.view.all': ['Feedback', 'View all feedback and queries'],
  'feedback.manage': ['Feedback', 'Respond to, assign and resolve feedback'],
  // Clients
  'clients.view.all': ['Clients', 'View every client, work item and update'],
  'clients.manage': ['Clients', 'Add clients and post work to anyone'],
  // Reports
  'reports.view.all': ['Reports', 'View organisation-wide reports'],
  'reports.view.team': ['Reports', 'View team reports'],
  // Administration
  'users.view': ['Administration', 'View user directory'],
  'users.manage': ['Administration', 'Create and edit users, reset passwords'],
  'teams.manage': ['Administration', 'Create and edit teams'],
  'roles.manage': ['Administration', 'Edit roles and permissions'],
  'integrations.manage': ['Administration', 'Configure Google Sheets and telephony'],
  'audit.view': ['Administration', 'View the audit log'],
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: PermissionKey[] }[] = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Full system access including roles, integrations and audit.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'admin',
    name: 'Admin / Manager',
    description: 'Manages leads, assignment, follow-ups, tasks, feedback and reports.',
    // Sees every client and update; posting client work stays with the Super Admin by default.
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'roles.manage' && p !== 'clients.manage'),
  },
  {
    key: 'team_leader',
    name: 'Team Leader',
    description: 'Monitors and distributes work within their team.',
    permissions: [
      'leads.view.all', 'leads.edit.team', 'leads.assign.team',
      'followups.view.team', 'calls.view.team', 'calls.recordings.team',
      'tasks.view.team', 'tasks.manage.team', 'tasks.create_for_others',
      'reports.view.team', 'users.view',
    ],
  },
  {
    key: 'tech',
    name: 'Tech',
    description: 'Runs the system: Google Sheets and telephony setup, lead imports, sync troubleshooting and audit review.',
    permissions: ['integrations.manage', 'leads.import', 'leads.view.all', 'users.view', 'audit.view'],
  },
  {
    key: 'employee',
    name: 'Sales Employee',
    description: 'Works assigned leads, logs calls and follow-ups, manages own tasks and feedback.',
    // Product decision: employees can view all leads but edit only their own.
    permissions: ['leads.view.all'],
  },
];
