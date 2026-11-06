import { createHash } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../common/phone';
import { localWallTimeToUtc } from '../common/time';

/** Maps CRM fields to sheet column headers. Defaults match Meta Lead Ads sheet exports. */
export interface FieldMapping {
  externalLeadId: string;
  fullName: string;
  phone: string;
  email: string;
  city: string;
  campaignName: string;
  adsetName: string;
  adName: string;
  formName: string;
  createdTime: string;
}

export const DEFAULT_MAPPING: FieldMapping = {
  externalLeadId: 'id',
  fullName: 'full_name',
  phone: 'phone_number',
  email: 'email',
  city: 'city',
  campaignName: 'campaign_name',
  adsetName: 'adset_name',
  adName: 'ad_name',
  formName: 'form_name',
  createdTime: 'created_time',
};

export interface NormalizedLead {
  externalLeadId: string;
  fullName: string;
  phoneE164: string | null;
  email: string | null;
  city: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  formName: string | null;
  sourceCreatedAt: Date | null;
}

export class RowRejected extends Error {}

const clean = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s.length ? s : null;
};

/** "Phone No.", "phone_no" and "PHONE NO" all become "phone_no". */
export const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Common column names used by website forms (Google Forms, Elementor, WPForms, Zapier…).
 * Used only when the mapped column isn't in the sheet, so an explicit mapping always wins.
 */
export const COLUMN_ALIASES: Record<keyof FieldMapping, string[]> = {
  externalLeadId: ['id', 'lead_id', 'submission_id', 'entry_id', 'response_id'],
  fullName: ['full_name', 'name', 'your_name', 'customer_name', 'client_name', 'contact_name', 'first_name'],
  phone: ['phone_number', 'phone', 'mobile', 'mobile_number', 'mobile_no', 'phone_no', 'contact_number', 'contact_no', 'contact', 'whatsapp', 'whatsapp_number', 'your_phone', 'your_mobile', 'number'],
  email: ['email', 'email_address', 'e_mail', 'your_email', 'mail', 'email_id'],
  city: ['city', 'location', 'your_city', 'town', 'area'],
  campaignName: ['campaign_name', 'campaign', 'utm_campaign'],
  adsetName: ['adset_name', 'ad_set', 'utm_medium'],
  adName: ['ad_name', 'utm_content'],
  formName: ['form_name', 'form', 'page', 'page_name', 'page_url', 'service', 'interested_in', 'requirement', 'subject'],
  createdTime: ['created_time', 'timestamp', 'submitted_at', 'submission_date', 'created_at', 'date', 'date_time', 'time'],
};

/** Finds which sheet column feeds each CRM field (mapped column first, then known aliases). */
export function resolveColumns(headers: string[], mapping: FieldMapping): Partial<Record<keyof FieldMapping, string>> {
  const keys = new Set(headers.map(headerKey));
  const out: Partial<Record<keyof FieldMapping, string>> = {};
  for (const field of Object.keys(COLUMN_ALIASES) as (keyof FieldMapping)[]) {
    const mapped = headerKey(mapping[field] || '');
    const hit = mapped && keys.has(mapped) ? mapped : COLUMN_ALIASES[field].find((a) => keys.has(a));
    if (hit) out[field] = hit;
  }
  return out;
}

/** Validates and normalises one source row. Throws RowRejected with a readable reason. */
export function normalizeRow(row: Record<string, string>, mapping: FieldMapping): NormalizedLead {
  const get = (field: keyof FieldMapping) => {
    const mapped = headerKey(mapping[field] || '');
    if (mapped && mapped in row) return clean(row[mapped]);
    const alias = COLUMN_ALIASES[field].find((a) => a in row);
    return alias ? clean(row[alias]) : null;
  };
  const rawPhone = get('phone');
  const rawEmail = get('email');
  const phoneE164 = normalizePhone(rawPhone);
  const email = normalizeEmail(rawEmail);
  const fullName = get('fullName');

  if (!fullName && !phoneE164 && !email) throw new RowRejected('Row is empty or missing name, phone and email');
  if (!phoneE164 && !email) {
    throw new RowRejected(rawPhone ? `Invalid phone number "${rawPhone}" and no valid email` : 'Missing phone number and email');
  }

  let sourceCreatedAt: Date | null = null;
  const created = get('createdTime');
  if (created) {
    // Meta writes offsets as +0530; make them ISO (+05:30) before parsing.
    sourceCreatedAt = parseSheetDate(created);
  }

  // Prefer the Meta lead id. Without it, derive a stable key from the lead's own data,
  // never from the row number (rows can move).
  const externalLeadId =
    get('externalLeadId') ??
    'h:' + createHash('sha256').update([phoneE164, email, created, fullName].join('|')).digest('hex').slice(0, 32);

  return {
    externalLeadId,
    fullName: fullName ?? (email ? email.split('@')[0] : 'Unknown'),
    phoneE164,
    email,
    city: get('city'),
    campaignName: get('campaignName'),
    adsetName: get('adsetName'),
    adName: get('adName'),
    formName: get('formName'),
    sourceCreatedAt,
  };
}

/**
 * Parses sheet timestamps: ISO / Meta ("2026-11-03T10:15:00+0530") and the day-first
 * format Google Forms and Indian locales write ("03/11/2026 10:15:00"), read as business time.
 */
export function parseSheetDate(v: string): Date | null {
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?)?$/i.exec(v.trim());
  if (dmy) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0', ap] = dmy;
    let h = Number(hh);
    if (ap) h = (h % 12) + (/p/i.test(ap) ? 12 : 0);
    if (Number(m) > 12 || Number(d) > 31) return null;
    const out = localWallTimeToUtc(Number(y), Number(m), Number(d), h, Number(mm), Number(ss));
    return isNaN(out.getTime()) ? null : out;
  }
  const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d.getTime()) ? null : d;
}

/** Converts a 2D values array (first row = headers) to header-keyed objects with sheet row numbers. */
export function rowsToObjects(values: string[][], headerRow: number) {
  const [headers = [], ...rest] = values;
  const keys = headers.map((h) => headerKey(String(h ?? '')));
  return {
    headers: headers.map(String),
    rows: rest.map((r, i) => ({
      rowNumber: headerRow + 1 + i,
      data: Object.fromEntries(keys.map((k, j) => [k, r[j] === undefined ? '' : String(r[j])])) as Record<string, string>,
    })),
  };
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string, keepBlankRows = false): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (keepBlankRows || row.some((x) => x !== '')) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) out.push(row);
  return out;
}
