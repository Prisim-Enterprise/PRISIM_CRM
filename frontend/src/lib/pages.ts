/**
 * Roles that only open a few pages. Someone whose every role is listed here sees just those pages
 * (plus their own profile and payslips); anyone with another role as well sees the full app.
 * What they can see on those pages still comes from their permissions.
 */
const LIMITED_ROLES: Record<string, string[]> = {
  video_editor: ['/tasks', '/media'],
};
const ALWAYS = ['/profile', '/payslips'];

/** The pages this person may open, or null when they are not limited. */
export function allowedPages(roles: string[] | undefined): string[] | null {
  if (!roles?.length || !roles.every((r) => r in LIMITED_ROLES)) return null;
  return [...new Set(roles.flatMap((r) => LIMITED_ROLES[r]))];
}

export function canOpen(allowed: string[] | null, path: string) {
  if (!allowed) return true;
  return [...allowed, ...ALWAYS].some((p) => path === p || path.startsWith(p + '/'));
}
