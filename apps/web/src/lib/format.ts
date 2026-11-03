import { format, formatDistanceToNowStrict, isToday, isTomorrow, isYesterday } from 'date-fns';

export const LEAD_STATUS: Record<string, { label: string; color: string }> = {
  NEW: { label: 'New', color: 'bg-sky-100 text-sky-800' },
  UNASSIGNED: { label: 'Unassigned', color: 'bg-amber-100 text-amber-800' },
  ASSIGNED: { label: 'Assigned', color: 'bg-indigo-100 text-indigo-800' },
  CONTACT_ATTEMPTED: { label: 'Contact attempted', color: 'bg-orange-100 text-orange-800' },
  CONTACTED: { label: 'Contacted', color: 'bg-cyan-100 text-cyan-800' },
  INTERESTED: { label: 'Interested', color: 'bg-emerald-100 text-emerald-800' },
  FOLLOW_UP_REQUIRED: { label: 'Follow-up required', color: 'bg-violet-100 text-violet-800' },
  CONVERTED: { label: 'Converted', color: 'bg-green-600 text-white' },
  LOST: { label: 'Lost', color: 'bg-slate-200 text-slate-700' },
  INVALID: { label: 'Invalid', color: 'bg-rose-100 text-rose-800' },
  DUPLICATE: { label: 'Duplicate', color: 'bg-stone-200 text-stone-700' },
};

export const CALL_OUTCOMES: Record<string, string> = {
  CONNECTED: 'Connected',
  INTERESTED: 'Interested',
  CALLBACK: 'Call back later',
  NOT_INTERESTED: 'Not interested',
  CONVERTED: 'Converted',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off / unreachable',
  WRONG_NUMBER: 'Wrong number',
};

export const CALL_STATUS: Record<string, { label: string; color: string }> = {
  INITIATED: { label: 'Ringing you…', color: 'bg-sky-100 text-sky-800' },
  RINGING: { label: 'Ringing', color: 'bg-sky-100 text-sky-800' },
  IN_PROGRESS: { label: 'In progress', color: 'bg-emerald-100 text-emerald-800' },
  COMPLETED: { label: 'Completed', color: 'bg-green-100 text-green-800' },
  NO_ANSWER: { label: 'No answer', color: 'bg-amber-100 text-amber-800' },
  BUSY: { label: 'Busy', color: 'bg-amber-100 text-amber-800' },
  FAILED: { label: 'Failed', color: 'bg-rose-100 text-rose-800' },
  CANCELED: { label: 'Cancelled', color: 'bg-slate-200 text-slate-700' },
};

export const TASK_STATUS: Record<string, { label: string; color: string; dot: string }> = {
  TODO: { label: 'To do', color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  IN_PROGRESS: { label: 'In progress', color: 'bg-blue-100 text-blue-800', dot: 'bg-blue-500' },
  REVIEW: { label: 'Review', color: 'bg-violet-100 text-violet-800', dot: 'bg-violet-500' },
  DONE: { label: 'Done', color: 'bg-green-100 text-green-800', dot: 'bg-green-500' },
  BLOCKED: { label: 'Blocked', color: 'bg-rose-100 text-rose-800', dot: 'bg-rose-500' },
};

export const PRIORITY: Record<string, { label: string; color: string }> = {
  LOW: { label: 'Low', color: 'bg-slate-100 text-slate-600' },
  MEDIUM: { label: 'Medium', color: 'bg-sky-100 text-sky-700' },
  HIGH: { label: 'High', color: 'bg-orange-100 text-orange-700' },
  CRITICAL: { label: 'Critical', color: 'bg-rose-600 text-white' },
};

export const FEEDBACK_STATUS: Record<string, { label: string; color: string }> = {
  SUBMITTED: { label: 'Submitted', color: 'bg-sky-100 text-sky-800' },
  UNDER_REVIEW: { label: 'Under review', color: 'bg-amber-100 text-amber-800' },
  IN_PROGRESS: { label: 'In progress', color: 'bg-blue-100 text-blue-800' },
  RESOLVED: { label: 'Resolved', color: 'bg-green-100 text-green-800' },
  CLOSED: { label: 'Closed', color: 'bg-slate-200 text-slate-700' },
};

export const FOLLOW_UP_TYPES: Record<string, string> = {
  call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting / site visit', other: 'Other',
};

export const fmtDate = (d?: string | Date | null) => (d ? format(new Date(d), 'd MMM yyyy') : '—');
export const fmtDateTime = (d?: string | Date | null) => (d ? format(new Date(d), 'd MMM yyyy, h:mm a') : '—');
export const fmtTime = (d?: string | Date | null) => (d ? format(new Date(d), 'h:mm a') : '—');
export const ago = (d?: string | Date | null) => (d ? formatDistanceToNowStrict(new Date(d), { addSuffix: true }) : '—');

export function fmtRelativeDay(d?: string | Date | null) {
  if (!d) return '—';
  const date = new Date(d);
  if (isToday(date)) return `Today, ${format(date, 'h:mm a')}`;
  if (isTomorrow(date)) return `Tomorrow, ${format(date, 'h:mm a')}`;
  if (isYesterday(date)) return `Yesterday, ${format(date, 'h:mm a')}`;
  return format(date, 'd MMM, h:mm a');
}

export function fmtDuration(s?: number | null) {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtPhone(p?: string | null) {
  if (!p) return '—';
  const m = p.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Value for <input type="datetime-local"> */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const initials = (name?: string | null) =>
  (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');

export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
