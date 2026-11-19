import { DEFAULT_LEAD_RULES, idleLabel, inWorkHours, latest, mergeRules, staleAction } from './lead-rules';
import { conversationKey, conversationWhere } from '../messages/chat-backup';

const h = (n: number) => n * 3_600_000;
const now = new Date('2026-11-19T08:00:00Z'); // 13:30 in India
const ago = (hours: number) => new Date(now.getTime() - h(hours));
const r = DEFAULT_LEAD_RULES; // nudge 2h, escalate 24h

describe('staleAction', () => {
  it('nothing while the owner is still inside the window', () => {
    expect(staleAction(ago(1.5), null, null, now, r)).toBeNull();
  });
  it('nudges the owner after 2 hours untouched', () => {
    expect(staleAction(ago(3), null, null, now, r)).toBe('nudge');
  });
  it('nudges only once per quiet spell', () => {
    expect(staleAction(ago(5), ago(2), null, now, r)).toBeNull();
  });
  it('a new quiet spell after fresh activity nudges again', () => {
    // Nudged 10h ago, then worked 4h ago, quiet since: a fresh nudge.
    expect(staleAction(ago(4), ago(10), null, now, r)).toBe('nudge');
  });
  it('escalates after 24 hours, even if the owner was already nudged', () => {
    expect(staleAction(ago(25), ago(20), null, now, r)).toBe('escalate');
  });
  it('escalates once, and does not fall back to nudging afterwards', () => {
    expect(staleAction(ago(30), ago(3), ago(3), now, r)).toBeNull();
  });
});

describe('mergeRules', () => {
  it('fills in defaults and pulls silly values back into range', () => {
    expect(mergeRules(undefined)).toEqual(DEFAULT_LEAD_RULES);
    const m = mergeRules({ nudgeAfterHours: 0, firstFollowUpMinutes: 99999, workStartHour: -3, firstFollowUpEnabled: 'yes' });
    expect(m.nudgeAfterHours).toBe(0.25);
    expect(m.firstFollowUpMinutes).toBe(1440);
    expect(m.workStartHour).toBe(0);
    expect(m.firstFollowUpEnabled).toBe(true); // not a boolean → default
  });
  it("never escalates before the owner's own alert", () => {
    expect(mergeRules({ nudgeAfterHours: 6, escalateAfterHours: 2 }).escalateAfterHours).toBe(6);
  });
});

describe('inWorkHours (India time)', () => {
  const day = { workStartHour: 9, workEndHour: 21 };
  it('inside and outside the working day', () => {
    expect(inWorkHours(new Date('2026-11-19T08:00:00Z'), day)).toBe(true); // 13:30
    expect(inWorkHours(new Date('2026-11-19T03:29:00Z'), day)).toBe(false); // 08:59
    expect(inWorkHours(new Date('2026-11-19T03:30:00Z'), day)).toBe(true); // 09:00
    expect(inWorkHours(new Date('2026-11-19T15:30:00Z'), day)).toBe(false); // 21:00
  });
  it('a night shift that crosses midnight', () => {
    const night = { workStartHour: 20, workEndHour: 6 };
    expect(inWorkHours(new Date('2026-11-19T18:30:00Z'), night)).toBe(true); // 00:00
    expect(inWorkHours(new Date('2026-11-19T08:00:00Z'), night)).toBe(false); // 13:30
  });
  it('0 to 24 means around the clock', () => {
    expect(inWorkHours(new Date('2026-11-19T21:00:00Z'), { workStartHour: 0, workEndHour: 24 })).toBe(true);
  });
});

describe('helpers', () => {
  it('latest ignores blanks', () => {
    expect(latest(null, ago(5), undefined, ago(2))).toEqual(ago(2));
    expect(latest(null, undefined)).toBeNull();
  });
  it('idleLabel', () => {
    expect(idleLabel(ago(0.5), now)).toBe('under an hour');
    expect(idleLabel(ago(1), now)).toBe('1 hour');
    expect(idleLabel(ago(30), now)).toBe('30 hours');
    expect(idleLabel(ago(72), now)).toBe('3 days');
  });
});

describe('chat backup conversations', () => {
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  it('both directions of a direct chat are one conversation', () => {
    expect(conversationKey(a, b)).toBe(conversationKey(b, a));
    expect(conversationKey(a, null)).toBe('everyone');
  });
  it('builds the matching filter', () => {
    expect(conversationWhere('everyone')).toEqual({ recipientId: null });
    expect(conversationWhere(conversationKey(b, a))).toEqual({ OR: [{ senderId: a, recipientId: b }, { senderId: b, recipientId: a }] });
  });
});
