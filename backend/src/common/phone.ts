import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';

const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY || 'IN') as CountryCode;

/** Normalises phone input (incl. Meta's "p:+91..." format) to E.164, or null if invalid. */
export function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^p:/i, '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const parsed = parsePhoneNumberFromString(s, DEFAULT_COUNTRY);
  return parsed && parsed.isValid() ? parsed.number : null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Masks a phone for logs: +9198******10 */
export function maskPhone(p?: string | null): string {
  if (!p) return '';
  return p.length > 6 ? p.slice(0, 5) + '*'.repeat(p.length - 7) + p.slice(-2) : '***';
}
