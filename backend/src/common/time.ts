// Timezone-aware day boundaries. Storage is UTC; "today" follows the business timezone.
export const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Start of the local business day containing `date`, as a UTC Date. */
export function startOfLocalDay(date = new Date(), tz = APP_TZ): Date {
  const local = new Date(date.getTime() + tzOffsetMs(date, tz));
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightAsUtc - tzOffsetMs(new Date(midnightAsUtc), tz));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function localDayRange(date = new Date(), tz = APP_TZ) {
  const start = startOfLocalDay(date, tz);
  return { start, end: addDays(start, 1) };
}

/** Local calendar date string (YYYY-MM-DD) for grouping in reports. */
export function localDateKey(date: Date, tz = APP_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Parse a YYYY-MM-DD local date to the UTC instant of its local midnight. */
export function parseLocalDate(s: string, tz = APP_TZ): Date {
  const [y, m, d] = s.split('-').map(Number);
  return startOfLocalDay(new Date(Date.UTC(y, m - 1, d, 12)), tz);
}

/** A wall-clock time in the business timezone, as a UTC instant. */
export function localWallTimeToUtc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, tz = APP_TZ): Date {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(asUtc - tzOffsetMs(new Date(asUtc), tz));
}
