// Pure scheduling rules for /internal/tick, kept apart from Nest so they can be unit-tested.

/** integration_configs row holding the last tick time (state.lastTickAt). */
export const JOBS_KEY = 'jobs';

/** Ticks arrive every minute; after this long without one, reminders and syncs have stopped. */
export const TICK_STALE_MS = 5 * 60_000;

export type JobName = 'followUps' | 'leadAlerts' | 'leadSync' | 'overdueTasks' | 'purgeMessages' | 'reconcile';

/** Which jobs a tick at this moment should run. */
export function jobsDue(now: Date): JobName[] {
  const jobs: JobName[] = ['followUps', 'leadAlerts', 'leadSync'];
  if (now.getUTCMinutes() % 10 === 0) jobs.push('overdueTasks', 'purgeMessages');
  if (now.getUTCHours() === 21 && now.getUTCMinutes() === 0) jobs.push('reconcile'); // 02:30 IST
  return jobs;
}

/** Quick checks (reminders and alerts) that may also run when someone has the CRM open. */
export const QUICK_JOBS_KEY = 'jobs_quick';
export const QUICK_JOBS_EVERY_MS = 60_000;

/** Health of the external scheduler. Only meaningful where ticks drive the jobs (Vercel). */
export function tickHealth(lastTickAt: string | undefined | null, now: Date): 'ok' | 'stale' | 'never' {
  if (!lastTickAt) return 'never';
  const t = Date.parse(lastTickAt);
  return Number.isFinite(t) && now.getTime() - t <= TICK_STALE_MS ? 'ok' : 'stale';
}
