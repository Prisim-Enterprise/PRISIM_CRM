// Reads an invoice's number, dates and total from the text of a PDF (as pdf.js gives it: pieces
// of text with their position). Pure, with no imports, so it can be tested on its own.
//
// Works on PDFs that contain text (made by Tally, accounting software, Word, or printed from the
// CRM). Scanned images have no text to read; the person then types the details in.

export interface TextPiece { str: string; x: number; y: number; page: number }
export interface InvoiceFields { invoiceNumber?: string; invoiceDate?: string; dueDate?: string; amount?: number }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

function isoDate(y: number, m: number, d: number) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "18-Nov-26", "18 November 2026", "18/11/2026" (day first, as in India), "2026-11-18", "Nov 18, 2026". */
export function parseDate(s: string): string | undefined {
  const t = s.trim();
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+([A-Za-z]{3,9})[\s\-/.,']+(\d{2,4})\b/.exec(t);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return isoDate(fullYear(+m[3]), mon, +m[1]);
  }
  m = /([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(t);
  if (m) return isoDate(fullYear(+m[3]), +m[2], +m[1]);
  return undefined;
}

const MONEY = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/gi;
/** Amounts in a piece of text: "₹ 47,200.00" → 47200. */
export function amountsIn(s: string): number[] {
  return [...s.matchAll(MONEY)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
}

/** Pieces grouped into lines (same page, about the same height), each read left to right, top to bottom. */
function lines(pieces: TextPiece[]) {
  const sorted = pieces.filter((p) => p.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: TextPiece[][] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last[0].page === p.page && Math.abs(last[0].y - p.y) < 3) last.push(p);
    else out.push([p]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

/**
 * The value that goes with a label: after it in the same piece ("Invoice No: 123"), to its right
 * on the same line, or just below it (as in a boxed layout like Tally's).
 */
function valueFor(pieces: TextPiece[], label: RegExp, accept: (v: string) => string | undefined, reject?: RegExp) {
  const ordered = [...pieces].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const p of ordered) {
    const m = label.exec(p.str);
    if (!m || (reject && reject.test(p.str))) continue;
    const rest = p.str.slice(m.index + m[0].length).replace(/^[\s:.#-]+/, '');
    const inPiece = rest && accept(rest);
    if (inPiece) return inPiece;
    const right = ordered
      .filter((q) => q.page === p.page && Math.abs(q.y - p.y) < 3 && q.x > p.x)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2);
    for (const q of right) { const v = accept(q.str.replace(/^[\s:.#-]+/, '')); if (v) return v; }
    const below = ordered
      .filter((q) => q.page === p.page && q.y < p.y - 1 && p.y - q.y < 30 && Math.abs(q.x - p.x) < 60)
      .sort((a, b) => b.y - a.y || Math.abs(a.x - p.x) - Math.abs(b.x - p.x));
    for (const q of below.slice(0, 2)) { const v = accept(q.str.replace(/^[\s:.#-]+/, '')); if (v) return v; }
  }
  return undefined;
}

const looksLikeNumber = (v: string) => {
  const t = v.trim().split(/\s{2,}/)[0].replace(/[.,;:]$/, '');
  if (!t || t.length > 30 || /\s/.test(t) || !/\d/.test(t) || !/^[A-Za-z0-9/\-_.#]+$/.test(t)) return undefined;
  if (parseDate(t) && !/[A-Za-z]{2,}/.test(t) && /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(t)) return undefined; // a date, not a number
  return t;
};

export function parseInvoice(pieces: TextPiece[]): InvoiceFields {
  const out: InvoiceFields = {};
  out.invoiceNumber = valueFor(pieces, /\b(?:tax\s+)?invoice\s*(?:no\.?|number|num\.?|#)|\bbill\s*(?:no\.?|number)|\binv\.?\s*no\.?/i, looksLikeNumber);
  out.invoiceDate = valueFor(pieces, /\b(?:invoice\s*date|bill\s*date|dated|date(?:d)?)\b/i, parseDate, /due|delivery|order|dispatch|despatch|supply|payment/i);
  out.dueDate = valueFor(pieces, /\b(?:due\s*date|due\s*on|due\s*by|payment\s*due(?:\s*date)?)\b/i, parseDate);

  // Total: the biggest amount on a line that says total (not sub-total, taxable or tax totals).
  const totals = lines(pieces)
    .map((l) => l.map((p) => p.str).join(' '))
    .filter((t) => /\b(grand\s*total|total\s*amount|amount\s*(?:payable|due)|net\s*payable|invoice\s*total|total)\b/i.test(t))
    .filter((t) => !/sub[\s-]*total|taxable|total\s*tax|tax\s*amount|quantity|\bqty\b/i.test(t))
    .flatMap(amountsIn);
  if (totals.length) out.amount = Math.max(...totals);
  if (out.dueDate && out.invoiceDate && out.dueDate < out.invoiceDate) delete out.dueDate;
  return out;
}

/** The client whose name appears in the invoice, preferring the longest (most specific) name. */
export function findClient<T extends { name: string }>(pieces: TextPiece[], clients: T[]): T | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const text = ` ${norm(pieces.map((p) => p.str).join(' '))} `;
  return clients
    .filter((c) => norm(c.name).length >= 3 && text.includes(` ${norm(c.name)} `))
    .sort((a, b) => b.name.length - a.name.length)[0];
}
