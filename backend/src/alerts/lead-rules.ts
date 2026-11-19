import { APP_TZ } from '../common/time';

// Rules for chasing leads. Pure, so they can be unit-tested; the alerts service applies them.

export const LEAD_RULES_KEY = 'lead_rules';

export interface LeadRules {
  /** Create a "First call" follow-up when a lead is assigned. */
  firstFollowUpEnabled: boolean;
  /** …due this many minutes after assignment. */
  firstFollowUpMinutes: number;
  /** Alert the owner when they haven't worked an assigned lead for this many hours. */
  nudgeAfterHours: number;
  /** Alert their team leader and managers after this many hours. */
  escalateAfterHours: number;
  /** Alert the team leader and managers when a follow-up is this many hours overdue. */
  followUpEscalateHours: number;
  /** Only send these alerts between these local hours (24h clock), so nobody is woken at night. */
  workStartHour: number;
  workEndHour: number;
}

export const DEFAULT_LEAD_RULES: LeadRules = {
  firstFollowUpEnabled: true,
  firstFollowUpMinutes: 15,
  nudgeAfterHours: 2,
  escalateAfterHours: 24,
  followUpEscalateHours: 4,
  workStartHour: 9,
  workEndHour: 21,
};

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Stored settings over the defaults, with anything out of range pulled back in. */
export function mergeRules(stored: unknown): LeadRules {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<LeadRules>;
  const d = DEFAULT_LEAD_RULES;
  const nudge = clamp(s.nudgeAfterHours, 0.25, 168, d.nudgeAfterHours);
  return {
    firstFollowUpEnabled: typeof s.firstFollowUpEnabled === 'boolean' ? s.firstFollowUpEnabled : d.firstFollowUpEnabled,
    firstFollowUpMinutes: clamp(s.firstFollowUpMinutes, 1, 1440, d.firstFollowUpMinutes),
    nudgeAfterHours: nudge,
    // Escalation can never come before the owner's own alert.
    escalateAfterHours: Math.max(nudge, clamp(s.escalateAfterHours, 0.25, 720, d.escalateAfterHours)),
    followUpEscalateHours: clamp(s.followUpEscalateHours, 0.25, 168, d.followUpEscalateHours),
    workStartHour: clamp(s.workStartHour, 0, 23, d.workStartHour),
    workEndHour: clamp(s.workEndHour, 1, 24, d.workEndHour),
  };
}

/** Local hour (0–23) in the business timezone. */
export function localHour(now: Date, tz = APP_TZ) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' }).format(now));
}

/** Whether alerts may go out now. Start == end means around the clock. */
export function inWorkHours(now: Date, r: Pick<LeadRules, 'workStartHour' | 'workEndHour'>, tz = APP_TZ) {
  if (r.workStartHour === r.workEndHour || (r.workStartHour === 0 && r.workEndHour === 24)) return true;
  const h = localHour(now, tz);
  return r.workStartHour < r.workEndHour ? h >= r.workStartHour && h < r.workEndHour : h >= r.workStartHour || h < r.workEndHour;
}

/** The latest of several moments, ignoring blanks. */
export function latest(...dates: (Date | null | undefined)[]): Date | null {
  let out: Date | null = null;
  for (const d of dates) if (d && (!out || d > out)) out = d;
  return out;
}

/**
 * What to do about an assigned lead, given when its owner last worked it.
 * Each alert fires once per quiet spell: a flag set after the last activity means "already told".
 */
export function staleAction(lastActivity: Date, nudgedAt: Date | null, escalatedAt: Date | null, now: Date, r: LeadRules): 'escalate' | 'nudge' | null {
  const idleH = (now.getTime() - lastActivity.getTime()) / 3_600_000;
  const done = (flag: Date | null) => !!flag && flag >= lastActivity;
  if (idleH >= r.escalateAfterHours && !done(escalatedAt)) return 'escalate';
  if (idleH >= r.nudgeAfterHours && !done(nudgedAt) && !done(escalatedAt)) return 'nudge';
  return null;
}

/** "3 hours", "1 day", "2 days" */
export function idleLabel(lastActivity: Date, now: Date) {
  const h = Math.floor((now.getTime() - lastActivity.getTime()) / 3_600_000);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}
