import { LeadStatus } from '@prisma/client';

/** Closed statuses end the lifecycle. Reopening needs edit rights over the lead plus a reason. */
export const CLOSED_STATUSES: LeadStatus[] = ['CONVERTED', 'LOST', 'INVALID', 'DUPLICATE'];

/** Statuses a user may pick by hand. NEW/UNASSIGNED/ASSIGNED are set by the system (sync & assignment). */
export const MANUAL_STATUSES: LeadStatus[] = [
  'CONTACT_ATTEMPTED', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP_REQUIRED', 'CONVERTED', 'LOST', 'INVALID', 'DUPLICATE',
];

export const REASON_REQUIRED: LeadStatus[] = ['LOST', 'INVALID', 'DUPLICATE'];

/** Progress order used for automatic forward-only status updates. */
const RANK: Partial<Record<LeadStatus, number>> = {
  NEW: 0, UNASSIGNED: 0, ASSIGNED: 1, CONTACT_ATTEMPTED: 2, CONTACTED: 3, FOLLOW_UP_REQUIRED: 4, INTERESTED: 5,
};

export const isClosed = (s: LeadStatus) => CLOSED_STATUSES.includes(s);

export function validateManualTransition(from: LeadStatus, to: LeadStatus, reason?: string | null): string | null {
  if (from === to) return 'Lead already has this status';
  if (!MANUAL_STATUSES.includes(to)) return `Status ${to} is managed automatically`;
  if (REASON_REQUIRED.includes(to) && !reason?.trim()) return 'A reason is required for this status';
  if (isClosed(from) && isClosed(to)) return 'Reopen the lead before changing to another closed status';
  if (isClosed(from) && !reason?.trim()) return 'A reason is required to reopen a closed lead';
  return null;
}

/** Returns the status an automatic event should move the lead to, or null to leave it unchanged. */
export function autoAdvance(current: LeadStatus, suggested: LeadStatus): LeadStatus | null {
  if (isClosed(current)) return null;
  const a = RANK[current] ?? 0;
  const b = RANK[suggested];
  return b !== undefined && b > a ? suggested : null;
}

/** Map a call disposition to the lead status it implies. */
export function statusForCallOutcome(outcome?: string | null): LeadStatus {
  switch (outcome) {
    case 'INTERESTED': return 'INTERESTED';
    case 'CALLBACK': return 'FOLLOW_UP_REQUIRED';
    case 'CONNECTED':
    case 'NOT_INTERESTED':
    case 'CONVERTED': return 'CONTACTED';
    default: return 'CONTACT_ATTEMPTED';
  }
}

export const CONNECTED_OUTCOMES = ['CONNECTED', 'INTERESTED', 'CALLBACK', 'NOT_INTERESTED', 'CONVERTED'];
export const CALL_OUTCOMES = [...CONNECTED_OUTCOMES, 'NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER'];
