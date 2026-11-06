import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Logger, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Put, Query, UnauthorizedException, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min, ValidateNested,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { auth as gauth, sheets as gsheets } from '@googleapis/sheets';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, Public, RequireAny } from '../common/current-user';
import { NotificationsService } from '../notifications/notifications';
import { PageQuery, paged, skipTake } from '../common/pagination';
import { LeadsModule } from '../leads/leads.controller';
import { LeadsService } from '../leads/leads.service';
import {
  DEFAULT_MAPPING, FieldMapping, headerKey, NormalizedLead, normalizeRow, parseCsv, resolveColumns, RowRejected, rowsToObjects,
} from './lead-ingest';

interface SheetsConfig {
  spreadsheetId?: string;
  sheetName?: string;
  /** Tab id from the sheet URL (#gid=…). Used when reading a sheet shared by link. */
  gid?: string;
  headerRow?: number;
  intervalMinutes?: number;
  mapping?: Partial<FieldMapping>;
  autoAssign?: { enabled: boolean; method: 'round_robin' | 'workload'; userIds: string[] };
}
interface SheetsState { lastRow?: number; lastSyncAt?: string; lastReconcileAt?: string; lastError?: string | null; readVia?: 'link' | 'service_account' }

/** Each Google Sheet feeds one lead source. */
export const CONNECTIONS = {
  meta: { configKey: 'google_sheets', sourceKey: 'meta_ads', sourceName: 'Meta Ads (Google Sheets)', label: 'Meta Ads leads' },
  website: { configKey: 'google_sheets_website', sourceKey: 'website', sourceName: 'Website', label: 'Website leads' },
} as const;
export type ConnectionKey = keyof typeof CONNECTIONS;
const isConnection = (k: string): k is ConnectionKey => k in CONNECTIONS;

class AutoAssignDto {
  @IsBoolean() enabled: boolean;
  @IsIn(['round_robin', 'workload']) method: 'round_robin' | 'workload';
  @IsArray() @IsUUID('all', { each: true }) userIds: string[];
}

class SheetsConfigDto {
  @IsBoolean() enabled: boolean;
  /** The spreadsheet ID or the full sheet URL (the tab's gid is taken from the URL). */
  @IsOptional() @IsString() spreadsheetId?: string;
  @IsOptional() @IsString() sheetName?: string;
  @IsOptional() @IsString() gid?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) headerRow?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) intervalMinutes?: number;
  @IsOptional() @IsObject() mapping?: Partial<FieldMapping>;
  @IsOptional() @ValidateNested() @Type(() => AutoAssignDto) autoAssign?: AutoAssignDto;
}

class ErrorQuery extends PageQuery {
  @IsOptional() @IsIn(['true', 'false']) resolved?: string;
  @IsOptional() @IsUUID() runId?: string;
}

type RowOutcome = 'created' | 'updated' | 'skipped' | 'duplicate';
type Row = { rowNumber: number; data: Record<string, string> };

/** Source-managed fields: sync may update these unless a user has edited them in the CRM. */
const SOURCE_FIELDS = ['fullName', 'phoneE164', 'email', 'city', 'campaignName', 'adsetName', 'adName', 'formName', 'sourceCreatedAt'] as const;

/** Accepts a bare spreadsheet ID or any Google Sheets URL. */
export function parseSheetRef(input: string): { spreadsheetId: string; gid?: string } {
  const v = input.trim();
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(v)?.[1] ?? v;
  const gid = /[#?&]gid=(\d+)/.exec(v)?.[1];
  return { spreadsheetId: id, gid };
}

const blank = (r: Row) => !Object.values(r.data).some((v) => v.trim());

@Injectable()
export class LeadSyncService {
  private log = new Logger('LeadSync');
  private running = new Set<ConnectionKey>();

  constructor(
    private prisma: PrismaService,
    private leads: LeadsService,
    private notifications: NotificationsService,
    private audit: AuditService,
  ) {}

  // ───────────── config ─────────────

  async getConfig(conn: ConnectionKey = 'meta') {
    const key = CONNECTIONS[conn].configKey;
    const row = await this.prisma.integrationConfig.upsert({
      where: { key }, update: {},
      create: { key, config: { headerRow: 1, intervalMinutes: 5, mapping: { ...DEFAULT_MAPPING } } as Prisma.InputJsonValue },
    });
    return { row, config: row.config as SheetsConfig, state: row.state as SheetsState };
  }

  private credentials() {
    const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    if (!b64) return null;
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { client_email: string; private_key: string };
    } catch {
      this.log.error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64 JSON');
      return null;
    }
  }

  async status(conn: ConnectionKey) {
    const { row, config, state } = await this.getConfig(conn);
    const creds = this.credentials();
    const source = CONNECTIONS[conn].sourceKey;
    const [lastRun, unresolvedErrors, leadCount] = await Promise.all([
      this.prisma.syncRun.findFirst({ where: { source }, orderBy: { startedAt: 'desc' } }),
      this.prisma.syncRowError.count({ where: { resolved: false, syncRun: { source } } }),
      this.prisma.lead.count({ where: { source: { key: source } } }),
    ]);
    return {
      key: conn,
      label: CONNECTIONS[conn].label,
      sourceKey: source,
      enabled: row.enabled,
      config: { ...config, mapping: { ...DEFAULT_MAPPING, ...config.mapping } },
      state,
      credentialsConfigured: !!creds,
      serviceAccountEmail: creds?.client_email ?? null,
      lastRun,
      unresolvedErrors,
      leadCount,
      running: this.running.has(conn),
    };
  }

  async saveConfig(user: AuthUser, conn: ConnectionKey, dto: SheetsConfigDto) {
    const { row, config } = await this.getConfig(conn);
    const ref = dto.spreadsheetId ? parseSheetRef(dto.spreadsheetId) : null;
    const next: SheetsConfig = {
      ...config,
      spreadsheetId: ref?.spreadsheetId ?? config.spreadsheetId,
      sheetName: dto.sheetName !== undefined ? dto.sheetName.trim() || undefined : config.sheetName,
      gid: dto.gid?.trim() || ref?.gid || (ref ? undefined : config.gid),
      headerRow: dto.headerRow ?? config.headerRow ?? 1,
      intervalMinutes: dto.intervalMinutes ?? config.intervalMinutes ?? 5,
      mapping: { ...DEFAULT_MAPPING, ...config.mapping, ...dto.mapping },
      autoAssign: dto.autoAssign ?? config.autoAssign,
    };
    if (dto.enabled && !next.spreadsheetId) throw new BadRequestException('Paste the Google Sheet link');
    // Changing the sheet resets the cursor.
    const sheetChanged = next.spreadsheetId !== config.spreadsheetId || next.sheetName !== config.sheetName || next.gid !== config.gid;
    await this.prisma.integrationConfig.update({
      where: { key: CONNECTIONS[conn].configKey },
      data: { enabled: dto.enabled, config: next as Prisma.InputJsonValue, ...(sheetChanged ? { state: {} } : {}) },
    });
    await this.audit.record({
      actorId: user.id, action: 'integration.google_sheets_updated', entityType: 'integration', entityId: row.id,
      before: config, after: { connection: conn, ...next, enabled: dto.enabled },
    });
    return this.status(conn);
  }

  // ───────────── Google Sheets I/O ─────────────

  /** Reads through the Sheets API (service account). Needs the sheet shared with that account. */
  private async readViaApi(config: SheetsConfig, creds: { client_email: string; private_key: string }): Promise<string[][]> {
    const client = new gauth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const api = gsheets({ version: 'v4', auth: client });
    const range = `'${config.sheetName!.replace(/'/g, "''")}'!A${config.headerRow ?? 1}:ZZ`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await api.spreadsheets.values.get({ spreadsheetId: config.spreadsheetId, range, valueRenderOption: 'FORMATTED_VALUE' });
        return (res.data.values as string[][]) ?? [];
      } catch (e) {
        const code = Number((e as { code?: number }).code);
        const transient = code === 429 || code >= 500 || !code;
        if (!transient || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  /** Reads a sheet shared as "Anyone with the link can view", as CSV. No Google credentials needed. */
  private async readViaLink(config: SheetsConfig): Promise<string[][]> {
    const id = encodeURIComponent(config.spreadsheetId!);
    const url = config.gid || !config.sheetName
      ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(config.gid ?? '0')}`
      : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(config.sheetName)}`;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        const type = res.headers.get('content-type') ?? '';
        if (res.status === 404) throw new Error('Sheet not found. Check the link.');
        if (res.status === 401 || res.status === 403 || type.includes('text/html')) {
          throw new Error('The sheet is not shared by link. In Google Sheets: Share → General access → "Anyone with the link" → Viewer.');
        }
        if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
        const values = parseCsv(await res.text(), true);
        return values.slice((config.headerRow ?? 1) - 1);
      } catch (e) {
        lastErr = e as Error;
        if (/not shared|not found/.test(lastErr.message)) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr!;
  }

  /** Service account when configured (and a tab name is set); otherwise the shared link. */
  private async readSheet(conn: ConnectionKey, config: SheetsConfig): Promise<{ values: string[][]; via: 'link' | 'service_account' }> {
    if (!config.spreadsheetId) throw new Error('No Google Sheet is connected yet');
    const creds = this.credentials();
    if (creds && config.sheetName) {
      try {
        return { values: await this.readViaApi(config, creds), via: 'service_account' };
      } catch (e) {
        this.log.warn(`${conn}: service account read failed (${(e as Error).message}), trying the shared link`);
      }
    }
    return { values: await this.readViaLink(config), via: 'link' };
  }

  async testConnection(conn: ConnectionKey) {
    const { config } = await this.getConfig(conn);
    try {
      const { values, via } = await this.readSheet(conn, config);
      const { headers, rows } = rowsToObjects(values, config.headerRow ?? 1);
      const mapping = { ...DEFAULT_MAPPING, ...config.mapping };
      const resolved = resolveColumns(headers, mapping);
      const dataRows = rows.filter((r) => !blank(r));
      const warnings: string[] = [];
      if (!headers.some((h) => h.trim())) warnings.push('The sheet is empty: add a header row (e.g. Name, Phone, Email, City, Message, Timestamp).');
      else if (!resolved.phone && !resolved.email) warnings.push('No phone or email column found. Each lead needs at least one of them.');
      return {
        ok: true, via, headers, rowCount: dataRows.length,
        detected: Object.fromEntries(Object.entries(resolved).map(([field, col]) => [field, headers.find((h) => headerKey(h) === col) ?? col])),
        warnings,
        sample: dataRows.slice(-3).map((r) => r.data),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ───────────── processing ─────────────

  private async systemActor(): Promise<AuthUser> {
    const email = 'system@prisim.internal';
    const user = await this.prisma.user.upsert({
      where: { email }, update: {},
      create: { email, fullName: 'System (auto-assign)', isActive: false },
    });
    return { id: user.id, fullName: user.fullName, email, teamId: null, roleKeys: [], permissions: new Set(['leads.assign.all']), teamIds: [] };
  }

  private async processLead(sourceId: string, n: NormalizedLead, raw: Record<string, string>, sourceLabel: string): Promise<{ outcome: RowOutcome; leadId: string }> {
    const existing = await this.prisma.lead.findUnique({ where: { sourceId_externalLeadId: { sourceId, externalLeadId: n.externalLeadId } } });
    if (existing) {
      const data: Prisma.LeadUpdateInput = {};
      let changed = false;
      for (const f of SOURCE_FIELDS) {
        if (existing.editedFields.includes(f)) continue; // CRM-managed after a user edit
        const nv = n[f];
        const ov = existing[f];
        const same = nv instanceof Date && ov instanceof Date ? nv.getTime() === ov.getTime() : nv === ov;
        if (!same && nv !== null) { (data as Record<string, unknown>)[f] = nv; changed = true; }
      }
      if (!changed) return { outcome: 'skipped', leadId: existing.id };
      data.sourceData = raw;
      await this.prisma.lead.update({ where: { id: existing.id }, data });
      return { outcome: 'updated', leadId: existing.id };
    }

    // Cross-source duplicate detection on phone, then email.
    const dup = await this.prisma.lead.findFirst({
      where: {
        status: { not: 'DUPLICATE' },
        OR: [...(n.phoneE164 ? [{ phoneE164: n.phoneE164 }] : []), ...(n.email && !n.phoneE164 ? [{ email: n.email }] : [])],
      },
      select: { id: true, assignedUserId: true, fullName: true },
      orderBy: { createdAt: 'asc' },
    });

    const lead = await this.prisma.$transaction(async (tx) => {
      const status = dup ? 'DUPLICATE' : 'UNASSIGNED';
      const l = await tx.lead.create({
        data: { ...n, sourceId, sourceData: raw, status, duplicateOfId: dup?.id, closeReason: dup ? `Same contact as existing lead ${dup.fullName}` : null },
      });
      await tx.leadStatusHistory.create({
        data: { leadId: l.id, toStatus: status, reason: dup ? `Duplicate detected during ${sourceLabel}` : `Imported from ${sourceLabel}` },
      });
      return l;
    });
    if (dup?.assignedUserId) {
      await this.notifications.notify(dup.assignedUserId, {
        type: 'lead.resubmitted', title: `${dup.fullName} submitted a form again`,
        body: `Via ${sourceLabel}${n.campaignName ? ` · ${n.campaignName}` : ''}`, link: `/leads/${dup.id}`,
      });
    }
    return { outcome: dup ? 'duplicate' : 'created', leadId: lead.id };
  }

  /** Runs one import over the given rows. Row-level failures are stored for review and retry. */
  private async ingest(
    trigger: string, sourceKey: string, sourceName: string, rows: Row[], mapping: FieldMapping,
    autoAssign?: SheetsConfig['autoAssign'],
  ) {
    const source = await this.prisma.leadSource.upsert({ where: { key: sourceKey }, update: {}, create: { key: sourceKey, name: sourceName } });
    const run = await this.prisma.syncRun.create({ data: { trigger, source: sourceKey, rowsRead: rows.length } });
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const createdIds: string[] = [];
    const errors: string[] = [];
    for (const r of rows) {
      try {
        const n = normalizeRow(r.data, mapping);
        const res = await this.processLead(source.id, n, r.data, source.name);
        if (res.outcome === 'created') { counts.created++; createdIds.push(res.leadId); }
        else if (res.outcome === 'duplicate') counts.created++;
        else counts[res.outcome]++;
        // A lead that now imports cleanly resolves earlier failures for the same source id.
        await this.prisma.syncRowError.updateMany({ where: { externalLeadId: n.externalLeadId, resolved: false }, data: { resolved: true } });
      } catch (e) {
        counts.failed++;
        const reason = e instanceof RowRejected ? e.message : `Unexpected error: ${(e as Error).message}`;
        errors.push(reason);
        await this.prisma.syncRowError.create({
          data: { syncRunId: run.id, rowNumber: r.rowNumber, externalLeadId: r.data[headerKey(mapping.externalLeadId)] || null, reason, rawRow: r.data },
        });
      }
    }
    await this.prisma.syncRun.update({
      where: { id: run.id },
      data: { ...counts, status: counts.failed ? (counts.failed === rows.length ? 'FAILED' : 'PARTIAL') : 'SUCCESS', finishedAt: new Date() },
    });
    await this.afterImport(createdIds, source.name, autoAssign);
    return { runId: run.id, ...counts, rowsRead: rows.length, errors };
  }

  private async afterImport(createdIds: string[], sourceName: string, aa?: SheetsConfig['autoAssign']) {
    if (!createdIds.length) return;
    if (aa?.enabled && aa.userIds?.length) {
      try {
        const active = await this.prisma.user.findMany({ where: { id: { in: aa.userIds }, isActive: true }, select: { id: true } });
        if (active.length) {
          await this.leads.assign(await this.systemActor(), { leadIds: createdIds, method: aa.method, userIds: active.map((u) => u.id), reason: 'Auto-assigned on import' });
          return;
        }
      } catch (e) {
        this.log.error(`Auto-assign failed: ${(e as Error).message}`);
      }
    }
    const managers = await this.notifications.usersWithPermission('leads.assign.all');
    await this.notifications.notifyMany(managers, {
      type: 'lead.imported', title: `${createdIds.length} new ${sourceName} lead${createdIds.length > 1 ? 's' : ''} waiting for assignment`,
      link: '/leads?owner=unassigned',
    });
  }

  async syncSheet(conn: ConnectionKey, trigger: 'schedule' | 'manual' | 'reconcile') {
    if (this.running.has(conn)) throw new BadRequestException('A sync is already running');
    this.running.add(conn);
    const { configKey, sourceKey, sourceName, label } = CONNECTIONS[conn];
    try {
      const { config, state } = await this.getConfig(conn);
      const mapping = { ...DEFAULT_MAPPING, ...config.mapping };
      let values: string[][];
      let via: 'link' | 'service_account';
      try {
        ({ values, via } = await this.readSheet(conn, config));
      } catch (e) {
        const msg = (e as Error).message;
        await this.prisma.syncRun.create({ data: { trigger, source: sourceKey, status: 'FAILED', error: msg, finishedAt: new Date() } });
        await this.prisma.integrationConfig.update({ where: { key: configKey }, data: { state: { ...state, lastError: msg } } });
        if (trigger !== 'schedule' || state.lastError !== msg) {
          await this.notifications.notifyMany(await this.notifications.usersWithPermission('integrations.manage'), {
            type: 'sync.failed', title: `${label}: Google Sheets sync failed`, body: msg.slice(0, 200), link: '/admin/integrations',
          });
        }
        throw new BadRequestException(`Sync failed: ${msg}`);
      }
      const { rows: all } = rowsToObjects(values, config.headerRow ?? 1);
      const rows = all.filter((r) => !blank(r));
      const lastRow = state.lastRow ?? 0;
      // Incremental: only rows after the cursor. Reconcile (or a shrunken sheet) re-reads everything;
      // dedup on external id keeps that safe.
      const full = trigger === 'reconcile' || (rows.length > 0 && rows[rows.length - 1].rowNumber < lastRow);
      const todo = full ? rows : rows.filter((r) => r.rowNumber > lastRow);
      const result = await this.ingest(trigger, sourceKey, sourceName, todo, mapping, config.autoAssign);
      const newLast = rows.length ? rows[rows.length - 1].rowNumber : full ? 0 : lastRow;
      await this.prisma.integrationConfig.update({
        where: { key: configKey },
        data: {
          state: {
            ...state, lastRow: newLast, lastSyncAt: new Date().toISOString(), lastError: null, readVia: via,
            ...(trigger === 'reconcile' ? { lastReconcileAt: new Date().toISOString() } : {}),
          },
        },
      });
      if (result.rowsRead) this.log.log(`${conn} ${trigger}: ${JSON.stringify({ ...result, errors: result.errors.length })}`);
      return result;
    } finally {
      this.running.delete(conn);
    }
  }

  async importCsv(user: AuthUser, file: Express.Multer.File, mappingOverride?: Partial<FieldMapping>) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > 10 * 1024 * 1024) throw new BadRequestException('CSV must be under 10 MB');
    const values = parseCsv(file.buffer.toString('utf8'));
    if (values.length < 2) throw new BadRequestException('The CSV has no data rows');
    const { config } = await this.getConfig('meta');
    const { rows } = rowsToObjects(values, 1);
    const res = await this.ingest('csv', 'csv_import', 'CSV import', rows, { ...DEFAULT_MAPPING, ...config.mapping, ...mappingOverride });
    await this.audit.record({ actorId: user.id, action: 'lead.csv_imported', entityType: 'sync_run', entityId: res.runId, after: { ...res, errors: res.errors.slice(0, 20) } });
    return res;
  }

  async retryErrors(user: AuthUser, ids?: string[]) {
    const errors = await this.prisma.syncRowError.findMany({
      where: { resolved: false, ...(ids?.length ? { id: { in: ids } } : {}) }, include: { syncRun: true }, take: 2000,
    });
    if (!errors.length) return { retried: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    // Mark originals resolved; anything that fails again is recorded on the retry run.
    await this.prisma.syncRowError.updateMany({ where: { id: { in: errors.map((e) => e.id) } }, data: { resolved: true } });
    const bySource = new Map<string, typeof errors>();
    for (const e of errors) {
      const k = e.syncRun.source ?? 'meta_ads';
      bySource.set(k, [...(bySource.get(k) ?? []), e]);
    }
    const total = { retried: errors.length, created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const [sourceKey, list] of bySource) {
      const conn = (Object.keys(CONNECTIONS) as ConnectionKey[]).find((c) => CONNECTIONS[c].sourceKey === sourceKey);
      const config = conn ? (await this.getConfig(conn)).config : undefined;
      const source = await this.prisma.leadSource.findUnique({ where: { key: sourceKey } });
      const res = await this.ingest(
        'retry', sourceKey, source?.name ?? sourceKey,
        list.map((e) => ({ rowNumber: e.rowNumber, data: e.rawRow as Record<string, string> })),
        { ...DEFAULT_MAPPING, ...config?.mapping }, config?.autoAssign,
      );
      for (const k of ['created', 'updated', 'skipped', 'failed'] as const) total[k] += res[k];
      await this.audit.record({ actorId: user.id, action: 'sync.retry', entityType: 'sync_run', entityId: res.runId, after: { ...res, errors: res.errors.slice(0, 20) } });
    }
    return total;
  }

  // ───────────── incoming webhook ─────────────

  async webhookConfig() {
    const row = await this.prisma.integrationConfig.upsert({
      where: { key: 'lead_webhook' }, update: {},
      create: { key: 'lead_webhook', enabled: true, config: { token: randomBytes(24).toString('base64url') } as Prisma.InputJsonValue },
    });
    return { row, token: (row.config as { token: string }).token };
  }

  async webhookStatus() {
    const { row, token } = await this.webhookConfig();
    const base = (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
    const [lastRun, leadCount] = await Promise.all([
      this.prisma.syncRun.findFirst({ where: { trigger: 'webhook' }, orderBy: { startedAt: 'desc' } }),
      this.prisma.syncRun.aggregate({ where: { trigger: 'webhook' }, _sum: { created: true } }),
    ]);
    return {
      enabled: row.enabled,
      url: `${base}/api/v1/webhooks/leads?key=${token}`,
      publicUrlIsLocal: /localhost|127\.0\.0\.1/.test(base),
      lastRun,
      leadsReceived: leadCount._sum.created ?? 0,
    };
  }

  async webhookUpdate(user: AuthUser, body: { enabled?: boolean; regenerate?: boolean }) {
    const { row, token } = await this.webhookConfig();
    await this.prisma.integrationConfig.update({
      where: { key: 'lead_webhook' },
      data: {
        enabled: body.enabled ?? row.enabled,
        config: { token: body.regenerate ? randomBytes(24).toString('base64url') : token } as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      actorId: user.id, action: body.regenerate ? 'integration.webhook_key_regenerated' : 'integration.webhook_updated',
      entityType: 'integration', entityId: row.id, after: { enabled: body.enabled ?? row.enabled },
    });
    return this.webhookStatus();
  }

  async assertWebhookKey(key: string | undefined) {
    const { row, token } = await this.webhookConfig();
    const a = Buffer.from(String(key ?? ''));
    const b = Buffer.from(token);
    if (!row.enabled) throw new ForbiddenException('The lead webhook is turned off');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Invalid webhook key');
  }

  /**
   * Leads pushed by other software. Accepts one lead, an array, or {leads|data|records: [...]},
   * as JSON or form fields. Field names are matched like sheet columns (name, phone, mobile, email…).
   */
  async receiveWebhook(body: unknown, sourceParam?: string) {
    const items = toLeadRecords(body);
    if (!items.length) throw new BadRequestException('No lead found in the request body');
    if (items.length > 500) throw new BadRequestException('Send at most 500 leads per request');
    const slug = headerKey(sourceParam || 'webhook').slice(0, 40) || 'webhook';
    const name = slug === 'webhook' ? 'Webhook' : slug === 'website' ? 'Website' : slug.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    const rows = items.map((data, i) => ({ rowNumber: i + 1, data }));
    const res = await this.ingest('webhook', slug, name, rows, DEFAULT_MAPPING);
    return { ok: res.failed < rows.length, received: rows.length, created: res.created, updated: res.updated, unchanged: res.skipped, failed: res.failed, errors: res.errors.slice(0, 20) };
  }

  // ───────────── schedules ─────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduled() {
    for (const conn of Object.keys(CONNECTIONS) as ConnectionKey[]) {
      if (this.running.has(conn)) continue;
      const { row, config, state } = await this.getConfig(conn);
      if (!row.enabled) continue;
      const interval = (config.intervalMinutes ?? 5) * 60_000;
      if (state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() < interval - 5_000) continue;
      try {
        await this.syncSheet(conn, 'schedule');
      } catch (e) {
        this.log.warn(`Scheduled ${conn} sync failed: ${(e as Error).message}`);
        // Record the attempt time so a broken config doesn't retry every minute.
        const fresh = await this.getConfig(conn);
        await this.prisma.integrationConfig.update({ where: { key: CONNECTIONS[conn].configKey }, data: { state: { ...fresh.state, lastSyncAt: new Date().toISOString() } } });
      }
    }
  }

  /** Daily reconciliation: re-reads each whole sheet so any missed or edited rows are caught. */
  @Cron('0 30 2 * * *', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' })
  async reconcile() {
    for (const conn of Object.keys(CONNECTIONS) as ConnectionKey[]) {
      const { row } = await this.getConfig(conn);
      if (!row.enabled || this.running.has(conn)) continue;
      try {
        await this.syncSheet(conn, 'reconcile');
      } catch (e) {
        this.log.warn(`Reconcile ${conn} failed: ${(e as Error).message}`);
      }
    }
  }
}

/** Normalises a webhook body into flat string records keyed like sheet headers. */
export function toLeadRecords(body: unknown): Record<string, string>[] {
  let list: unknown[] = [];
  if (Array.isArray(body)) list = body;
  else if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const nested = b.leads ?? b.records ?? b.entries ?? (Array.isArray(b.data) ? b.data : null);
    list = Array.isArray(nested) ? nested : b.data && typeof b.data === 'object' ? [b.data] : [b];
  }
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map((obj) => {
      const out: Record<string, string> = {};
      const put = (k: string, v: unknown) => {
        const key = headerKey(k);
        if (!key || v === null || v === undefined || typeof v === 'object') return;
        if (!(key in out)) out[key] = String(v).slice(0, 2000);
      };
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'name' in x && 'values' in x)) {
          // Meta / Facebook style: field_data: [{ name: 'phone_number', values: ['…'] }]
          for (const f of v as { name: string; values: unknown[] }[]) put(f.name, f.values?.[0]);
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) put(k2, v2); // one level, e.g. {contact:{phone}}
        } else put(k, v);
      }
      return out;
    })
    .filter((r) => Object.keys(r).length > 0);
}

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller()
export class IntegrationsController {
  constructor(private sync: LeadSyncService, private prisma: PrismaService) {}

  private conn(k: string): ConnectionKey {
    if (!isConnection(k)) throw new NotFoundException('Unknown sheet connection');
    return k;
  }

  @Get('integrations/sheets')
  @RequireAny('integrations.manage', 'leads.import')
  async all() { return Promise.all((Object.keys(CONNECTIONS) as ConnectionKey[]).map((c) => this.sync.status(c))); }

  @Get('integrations/sheets/:conn')
  @RequireAny('integrations.manage', 'leads.import')
  status(@Param('conn') c: string) { return this.sync.status(this.conn(c)); }

  @Put('integrations/sheets/:conn')
  @RequireAny('integrations.manage')
  save(@CurrentUser() u: AuthUser, @Param('conn') c: string, @Body() dto: SheetsConfigDto) { return this.sync.saveConfig(u, this.conn(c), dto); }

  @Post('integrations/sheets/:conn/test')
  @RequireAny('integrations.manage')
  test(@Param('conn') c: string) { return this.sync.testConnection(this.conn(c)); }

  @Post('integrations/sheets/:conn/sync')
  @RequireAny('integrations.manage', 'leads.import')
  run(@Param('conn') c: string) { return this.sync.syncSheet(this.conn(c), 'manual'); }

  @Post('integrations/sheets/:conn/reconcile')
  @RequireAny('integrations.manage')
  reconcile(@Param('conn') c: string) { return this.sync.syncSheet(this.conn(c), 'reconcile'); }

  @Get('integrations/webhook')
  @RequireAny('integrations.manage')
  webhook() { return this.sync.webhookStatus(); }

  @Put('integrations/webhook')
  @RequireAny('integrations.manage')
  webhookUpdate(@CurrentUser() u: AuthUser, @Body() body: { enabled?: boolean; regenerate?: boolean }) { return this.sync.webhookUpdate(u, body ?? {}); }

  @Post('integrations/leads/import-csv')
  @RequireAny('integrations.manage', 'leads.import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  importCsv(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) { return this.sync.importCsv(u, file); }

  @Get('integrations/sync-runs')
  @RequireAny('integrations.manage', 'leads.import')
  async runs(@Query() q: PageQuery) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, ...skipTake(q) }),
      this.prisma.syncRun.count(),
    ]);
    return paged(items, total, q);
  }

  @Get('integrations/sync-errors')
  @RequireAny('integrations.manage', 'leads.import')
  async errors(@Query() q: ErrorQuery) {
    const where: Prisma.SyncRowErrorWhereInput = {
      ...(q.resolved ? { resolved: q.resolved === 'true' } : {}), ...(q.runId ? { syncRunId: q.runId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.syncRowError.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.syncRowError.count({ where }),
    ]);
    return paged(items, total, q);
  }

  @Post('integrations/sync-errors/retry')
  @RequireAny('integrations.manage', 'leads.import')
  retry(@CurrentUser() u: AuthUser, @Body() body: { ids?: string[] }) { return this.sync.retryErrors(u, body?.ids); }

  @Post('integrations/sync-errors/:id/dismiss')
  @RequireAny('integrations.manage', 'leads.import')
  async dismiss(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.prisma.syncRowError.updateMany({ where: { id }, data: { resolved: true } });
    if (!r.count) throw new NotFoundException();
    return { ok: true };
  }

  @Get('integrations/telephony')
  @RequireAny('integrations.manage')
  telephony() {
    const provider = process.env.TELEPHONY_PROVIDER === 'exotel' ? 'exotel' : 'mock';
    const base = (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
    return {
      provider,
      configured: provider === 'mock' || !!(process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY && process.env.EXOTEL_API_TOKEN && process.env.EXOTEL_CALLER_ID),
      callerId: process.env.EXOTEL_CALLER_ID || null,
      webhookUrl: `${base}/api/v1/telephony/webhooks/${provider}?token=••••••`,
      publicUrlIsLocal: /localhost|127\.0\.0\.1/.test(base),
    };
  }

  @Get('audit')
  @RequireAny('audit.view')
  async auditLog(@Query() q: PageQuery & { entityType?: string; actorId?: string }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.actorId ? { actorId: q.actorId } : {}),
    };
    const page = { page: Number(q.page) || 1, pageSize: Math.min(Number(q.pageSize) || 50, 200) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, include: { actor: { select: { id: true, fullName: true } } }, ...skipTake(page) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paged(items, total, page);
  }
}

/**
 * Public endpoint other software posts leads to. Authenticated by the webhook key in the URL
 * (?key=) or the X-Webhook-Key header. Optional ?source=… names the lead source (default "Webhook").
 */
@ApiTags('Lead webhook')
@Controller('webhooks/leads')
export class LeadWebhookController {
  constructor(private sync: LeadSyncService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  async receive(@Query('key') key: string | undefined, @Headers('x-webhook-key') hkey: string | undefined, @Query('source') source: string | undefined, @Body() body: unknown) {
    await this.sync.assertWebhookKey(key ?? hkey);
    return this.sync.receiveWebhook(body, source);
  }

  /** Some tools check the URL with a GET before saving it. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get()
  async ping(@Query('key') key: string | undefined, @Headers('x-webhook-key') hkey: string | undefined) {
    await this.sync.assertWebhookKey(key ?? hkey);
    return { ok: true, message: 'Prisim CRM lead webhook is ready. POST leads to this URL.' };
  }
}

@Module({ imports: [LeadsModule], providers: [LeadSyncService], controllers: [IntegrationsController, LeadWebhookController] })
export class IntegrationsModule {}
