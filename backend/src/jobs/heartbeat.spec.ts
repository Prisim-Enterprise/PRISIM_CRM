import { jobsDue, tickHealth, TICK_STALE_MS } from './heartbeat';

const at = (iso: string) => new Date(iso);

describe('jobsDue', () => {
  it('every minute: follow-up reminders, lead alerts and lead sync', () => {
    expect(jobsDue(at('2026-11-17T10:03:00Z'))).toEqual(['followUps', 'leadAlerts', 'leadSync']);
  });
  it('every ten minutes: also overdue tasks, chat purge and the posting calendar', () => {
    expect(jobsDue(at('2026-11-17T10:20:00Z'))).toEqual(['followUps', 'leadAlerts', 'leadSync', 'overdueTasks', 'purgeMessages', 'postingCalendar']);
  });
  it('02:30 IST (21:00 UTC): the nightly reconciliation too', () => {
    expect(jobsDue(at('2026-11-17T21:00:00Z'))).toContain('reconcile');
    expect(jobsDue(at('2026-11-17T21:01:00Z'))).not.toContain('reconcile');
  });
});

describe('tickHealth', () => {
  const now = at('2026-11-17T10:00:00Z');
  it('never ticked', () => expect(tickHealth(undefined, now)).toBe('never'));
  it('recent tick is ok', () => expect(tickHealth(new Date(now.getTime() - 60_000).toISOString(), now)).toBe('ok'));
  it('exactly at the limit is still ok', () => expect(tickHealth(new Date(now.getTime() - TICK_STALE_MS).toISOString(), now)).toBe('ok'));
  it('older than the limit is stale', () => expect(tickHealth(new Date(now.getTime() - TICK_STALE_MS - 1).toISOString(), now)).toBe('stale'));
  it('garbage is stale, not ok', () => expect(tickHealth('not a date', now)).toBe('stale'));
});
