import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PostingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { localDateKey } from '../common/time';

/**
 * Reads the posting calendar Google Sheet and mirrors it into the CRM. The sheet is the master copy:
 * each tab is one client's lead period, re-read on every sync. The raw cells are kept too, so the CRM
 * can show each tab exactly as it is in the sheet.
 */
const KEY = 'posting_sheet';
const STALE_MS = 60_000;
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

export interface SheetTab {
  name: string; gid: string; clientId: string | null; client: string | null; periodId: string | null;
  headers: string[]; rows: string[][]; problems: string[];
}
interface SheetState { lastSyncAt?: string; lastError?: string | null; tabs?: SheetTab[] }
interface SheetConfig { sheetId?: string; url?: string }

const named = (s?: string | null) => !!s && !/^[\s\-–—_.]*$/.test(s);
const clean = (s?: string | null) => (named(s) ? s!.trim().replace(/\s+/g, ' ') : null);
/** "✅ Done" -> DONE, "Not Yet Done" -> NOT_YET, "—" or blank -> NONE. */
const statusOf = (s?: string): PostingStatus => {
  const t = (s ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bnot\b/.test(t)) return 'NOT_YET';
  if (/\bdone\b/.test(t) || t === 'true' || t === 'yes') return 'DONE';
  return 'NONE';
};
const titleCase = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** "22-Sep", "Sep 22", "Oct 5", "05/10/2026", "2026-10-05" -> month/day (year if given). */
function parseDay(raw?: string): { y?: number; m: number; d: number } | null {
  const s = (raw ?? '').trim();
  let m: RegExpExecArray | null;
  const mon = (w: string) => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s))) return { y: +m[3] < 100 ? 2000 + +m[3] : +m[3], m: +m[2] - 1, d: +m[1] };
  if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,})\.?(?:[-\s,]+(\d{4}))?$/.exec(s)) && mon(m[2]) !== undefined) return { d: +m[1], m: mon(m[2]), y: m[3] ? +m[3] : undefined };
  if ((m = /^([A-Za-z]{3,})\.?[-\s](\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s)) && mon(m[1]) !== undefined) return { d: +m[2], m: mon(m[1]), y: m[3] ? +m[3] : undefined };
  return null;
}
/** Picks the year for a date without one: the one that puts it nearest the anchor (handles Dec -> Jan). */
function withYear(p: { y?: number; m: number; d: number } | null, anchor: string): string | null {
  if (!p) return null;
  if (p.y) return iso(p.y, p.m, p.d);
  const [ay, am] = anchor.split('-').map(Number);
  let y = ay;
  if (p.m - (am - 1) < -6) y++;
  if (p.m - (am - 1) > 6) y--;
  return iso(y, p.m, p.d);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Which column holds what, found from the heading row. */
function columns(rows: string[][]) {
  const header = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /video|reel/i.test(c)));
  if (header < 0) return null;
  const h = rows[header].map((c) => c.trim().toLowerCase());
  const find = (re: RegExp) => { const i = h.findIndex((c) => re.test(c)); return i < 0 ? null : i; };
  const after = (i: number | null) => (i !== null && i + 1 < h.length && /update|status/.test(h[i + 1]) ? i + 1 : null);
  const video = find(/video|reel/), poster = find(/poster|image/);
  return {
    header, company: find(/company|client/), start: find(/start/), end: find(/end/),
    date: find(/schedule|posting|post date/) ?? find(/^date$/),
    video, videoStatus: find(/video status/) ?? after(video),
    poster, posterStatus: find(/poster status|image status/) ?? after(poster),
    leads: find(/lead/),
    // One Update column after the poster and none after the video: it covers both.
    shared: after(video) === null && find(/video status/) === null,
  };
}

export const sheetIdFrom = (v: string) => /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(v)?.[1] ?? (/^[a-zA-Z0-9_-]{20,}$/.test(v) ? v : null);

@Injectable()
export class PostingSheetService {
  private log = new Logger('PostingSheet');
  private running: Promise<unknown> | null = null;
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async row() {
    const r = await this.prisma.integrationConfig.findUnique({ where: { key: KEY } });
    return { enabled: !!r?.enabled, config: (r?.config ?? {}) as SheetConfig, state: (r?.state ?? {}) as SheetState };
  }

  /** What the Media tab shows: the link, when it last synced, and each tab's cells. */
  async status() {
    const { enabled, config, state } = await this.row();
    return { connected: enabled && !!config.sheetId, url: config.url ?? null, lastSyncAt: state.lastSyncAt ?? null, lastError: state.lastError ?? null, tabs: state.tabs ?? [] };
  }

  /** Period ids that come from the sheet, so the CRM doesn't let them be edited by hand. */
  async linkedPeriodIds(): Promise<Set<string>> {
    const { enabled, state } = await this.row();
    return new Set(enabled ? (state.tabs ?? []).map((t) => t.periodId).filter((x): x is string => !!x) : []);
  }

  async connect(actorId: string, url: string) {
    const sheetId = sheetIdFrom(url.trim());
    if (!sheetId) throw new BadRequestException('That doesn\'t look like a Google Sheets link');
    await this.prisma.integrationConfig.upsert({
      where: { key: KEY },
      create: { key: KEY, enabled: true, config: { sheetId, url: url.trim() } },
      update: { enabled: true, config: { sheetId, url: url.trim() } },
    });
    await this.audit.record({ actorId, action: 'posting.sheet.connected', entityType: 'integration', entityId: actorId, after: { url } });
    return this.sync(true);
  }

  async disconnect(actorId: string) {
    await this.prisma.integrationConfig.updateMany({ where: { key: KEY }, data: { enabled: false } });
    await this.audit.record({ actorId, action: 'posting.sheet.disconnected', entityType: 'integration', entityId: actorId });
    return this.status();
  }

  /** Syncs if the last sync is older than a minute (or always, when forced). One sync at a time. */
  async sync(force = false) {
    const { enabled, config, state } = await this.row();
    if (!enabled || !config.sheetId) return this.status();
    if (!force && state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() < STALE_MS) return this.status();
    if (!this.running) this.running = this.run(config.sheetId, state).finally(() => { this.running = null; });
    await this.running;
    return this.status();
  }

  private async run(sheetId: string, prev: SheetState) {
    try {
      const tabs = await this.readTabs(sheetId);
      const out: SheetTab[] = [];
      for (const t of tabs) out.push(await this.syncTab(sheetId, t, prev.tabs?.find((p) => p.gid === t.gid)));
      await this.save({ lastSyncAt: new Date().toISOString(), lastError: null, tabs: out });
      this.log.log(`Synced ${out.length} tabs`);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.error(`Posting sheet sync failed: ${msg}`);
      await this.save({ ...prev, lastSyncAt: new Date().toISOString(), lastError: msg });
    }
  }

  private save(state: SheetState) {
    return this.prisma.integrationConfig.update({ where: { key: KEY }, data: { state: state as unknown as Prisma.InputJsonValue } });
  }

  private async readTabs(sheetId: string) {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`);
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      throw new Error('The sheet can\'t be read. In Google Sheets: Share → General access → "Anyone with the link" → Viewer.');
    }
    if (!r.ok) throw new Error(`Google Sheets answered ${r.status}`);
    const html = await r.text();
    const tabs = [...html.matchAll(/\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:[^}]*?gid:\s*"(\d+)"/g)].map((m) => ({ name: JSON.parse(`"${m[1]}"`) as string, gid: m[2] }));
    if (!tabs.length) throw new Error('No tabs found in the sheet');
    return tabs;
  }

  private async syncTab(sheetId: string, tab: { name: string; gid: string }, prev?: SheetTab): Promise<SheetTab> {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${tab.gid}`);
    if (!res.ok) throw new Error(`Couldn't read the "${tab.name}" tab (${res.status})`);
    const all = parseCsv(await res.text());
    const nonEmpty = all.filter((r) => r.some((c) => c.trim()));
    const col = columns(nonEmpty);
    const width = Math.max(0, ...nonEmpty.map((r) => r.length));
    const base: SheetTab = { name: tab.name.trim(), gid: tab.gid, clientId: prev?.clientId ?? null, client: prev?.client ?? null, periodId: prev?.periodId ?? null, headers: [], rows: [], problems: [] };
    if (!col || col.date === null) return { ...base, rows: nonEmpty.map((r) => [...r, ...Array(width - r.length).fill('')]), problems: ['No heading row with a date and a video column, so this tab is shown but not added to the calendar.'] };
    const at = (r: string[], i: number | null) => (i === null ? '' : r[i] ?? '');
    const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')].map((c) => c.trim());
    const body = nonEmpty.slice(col.header + 1).filter((r) => at(r, col.date).trim() || at(r, col.video).trim() || at(r, col.poster).trim());
    const shown: SheetTab = { ...base, headers: pad(nonEmpty[col.header]), rows: body.map(pad) };

    const company = body.map((r) => at(r, col.company).trim()).find(Boolean) || titleCase(tab.name);
    const year = new Date().getUTCFullYear();
    const sp = parseDay(body.map((r) => at(r, col.start)).find((v) => parseDay(v)));
    const ep = parseDay(body.map((r) => at(r, col.end)).find((v) => parseDay(v)));
    const problems: string[] = [];
    const slotsRaw = body.map((r, i) => ({ r, i }));
    const anchorGuess = sp ? (withYear({ ...sp, y: sp.y ?? year }, `${year}-01`) as string) : `${year}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    const slots = slotsRaw.map(({ r, i }) => {
      const date = withYear(parseDay(at(r, col.date)), anchorGuess);
      if (!date) { if (at(r, col.date).trim()) problems.push(`Row ${col.header + i + 2}: "${at(r, col.date)}" isn't a date, so it was left out.`); return null; }
      return {
        date, video: clean(at(r, col.video)),
        videoStatus: statusOf(at(r, col.shared && named(at(r, col.video)) ? col.posterStatus : col.videoStatus)),
        poster: clean(at(r, col.poster)),
        posterStatus: col.shared && !named(at(r, col.poster)) ? 'NONE' as PostingStatus : statusOf(at(r, col.posterStatus)),
        leads: clean(at(r, col.leads)),
      };
    }).filter((s): s is NonNullable<typeof s> => !!s);
    if (!slots.length) return { ...shown, client: company, problems: [...problems, 'No dated rows yet.'] };
    const dates = slots.map((s) => s.date).sort();
    const leadStart = sp ? withYear(sp, dates[0])! : dates[0];
    let leadEnd = ep ? withYear(ep, leadStart)! : dates[dates.length - 1];
    if (leadEnd < leadStart) leadEnd = iso(Number(leadEnd.slice(0, 4)) + 1, Number(leadEnd.slice(5, 7)) - 1, Number(leadEnd.slice(8)));
    if (dates[0] < leadStart || dates[dates.length - 1] > leadEnd) problems.push(`The schedule dates (${dates[0]} to ${dates[dates.length - 1]}) go outside the start and end dates (${leadStart} to ${leadEnd}).`);

    // Find the client and period this tab feeds: remembered from last time, else the earlier one-off import, else by name.
    let clientId = prev?.clientId && (await this.prisma.client.count({ where: { id: prev.clientId } })) ? prev.clientId : null;
    let periodId = prev?.periodId && (await this.prisma.postingPeriod.count({ where: { id: prev.periodId } })) ? prev.periodId : null;
    if (!periodId) {
      const imported = await this.prisma.postingPeriod.findFirst({ where: { notes: { contains: `sheet tab "${tab.name}"` } } });
      if (imported) { periodId = imported.id; clientId = imported.clientId; }
    }
    if (!clientId) clientId = (await this.prisma.client.findFirst({ where: { name: { equals: company, mode: 'insensitive' } } }))?.id ?? null;
    const creator = await this.prisma.user.findFirst({ where: { isActive: true, deletedAt: null, roles: { some: { role: { key: 'super_admin' } } } }, orderBy: { createdAt: 'asc' } });
    if (!creator) throw new Error('No active Super Admin to record the sheet sync against');
    if (!clientId) {
      clientId = (await this.prisma.client.create({ data: { name: company, status: 'ACTIVE', createdById: creator.id, notes: `Added from the posting calendar sheet (tab "${tab.name}").` } })).id;
    }
    const today = day(localDateKey(new Date()));
    const clientName = (await this.prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true } })).name;
    await this.prisma.$transaction(async (tx) => {
      if (periodId) {
        await tx.postingPeriod.update({ where: { id: periodId }, data: { clientId: clientId!, leadStart: day(leadStart), leadEnd: day(leadEnd) } });
      } else {
        periodId = (await tx.postingPeriod.create({ data: { clientId: clientId!, leadStart: day(leadStart), leadEnd: day(leadEnd), createdById: creator.id, notes: `Synced from the sheet tab "${tab.name}".` } })).id;
      }
      // Keep which days were already reminded, so a sync doesn't send reminders again.
      const old = await tx.postingSlot.findMany({ where: { periodId }, select: { date: true, reminderSentOn: true } });
      const reminded = new Map(old.map((o) => [o.date.toISOString().slice(0, 10), o.reminderSentOn]));
      await tx.postingSlot.deleteMany({ where: { periodId } });
      await tx.postingSlot.createMany({
        data: slots.map((s) => ({
          periodId: periodId!, date: day(s.date), video: s.video, videoStatus: s.videoStatus, poster: s.poster, posterStatus: s.posterStatus, leads: s.leads,
          // Past days count as reminded, so connecting an old sheet doesn't send a burst of reminders.
          reminderSentOn: reminded.get(s.date) ?? (day(s.date) < today ? today : null),
        })),
      });
    });
    return { ...shown, clientId, client: clientName, periodId, problems };
  }
}
