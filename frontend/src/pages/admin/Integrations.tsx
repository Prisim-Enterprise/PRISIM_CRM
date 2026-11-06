import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CheckCircle2, AlertTriangle, Copy, ExternalLink, Globe, RefreshCw, Sheet, PhoneCall, Upload, PlugZap, RotateCcw, Webhook,
} from 'lucide-react';
import { api, errMsg, Paged } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDirectory } from '../../lib/hooks';
import { ago, fmtDateTime } from '../../lib/format';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Pagination, Select, Spinner, Table, Tabs, Td, Th } from '../../components/ui';

interface SheetsStatus {
  key: 'website' | 'meta'; label: string; sourceKey: string; leadCount: number;
  enabled: boolean;
  config: {
    spreadsheetId?: string; sheetName?: string; gid?: string; headerRow?: number; intervalMinutes?: number; mapping: Record<string, string>;
    autoAssign?: { enabled: boolean; method: string; userIds: string[] };
  };
  state: { lastRow?: number; lastSyncAt?: string; lastReconcileAt?: string; lastError?: string | null; readVia?: 'link' | 'service_account' };
  credentialsConfigured: boolean; serviceAccountEmail: string | null; unresolvedErrors: number; running: boolean;
  lastRun: SyncRun | null;
}
interface SyncRun { id: string; trigger: string; source: string | null; status: string; rowsRead: number; created: number; updated: number; skipped: number; failed: number; error: string | null; startedAt: string; finishedAt: string | null }
interface RowError { id: string; rowNumber: number; externalLeadId: string | null; reason: string; rawRow: Record<string, string>; resolved: boolean; createdAt: string }
interface TestResult { ok: boolean; via?: string; headers?: string[]; rowCount?: number; detected?: Record<string, string>; warnings?: string[]; error?: string }
interface WebhookStatus { enabled: boolean; url: string; publicUrlIsLocal: boolean; lastRun: SyncRun | null; leadsReceived: number }

const FIELD_LABELS: Record<string, string> = {
  externalLeadId: 'Lead ID', fullName: 'Full name', phone: 'Phone', email: 'Email', city: 'City', campaignName: 'Campaign',
  adsetName: 'Ad set', adName: 'Ad', formName: 'Form / page', createdTime: 'Created time',
};
const RUN_COLORS: Record<string, string> = { SUCCESS: 'bg-green-100 text-green-800', PARTIAL: 'bg-amber-100 text-amber-800', FAILED: 'bg-rose-100 text-rose-800', RUNNING: 'bg-sky-100 text-sky-800' };
const SOURCE_LABEL: Record<string, string> = { meta_ads: 'Meta Ads', website: 'Website', csv_import: 'CSV', webhook: 'Webhook' };

function Stat({ label, value, sub, good, bad, icon }: { label: string; value: string; sub?: string | null; good?: boolean; bad?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
      {icon}
      <div className="min-w-0">
        <p className="text-xs uppercase text-slate-500">{label}</p>
        <p className={`font-semibold ${good ? 'text-green-600' : bad ? 'text-rose-600' : ''}`}>{value}</p>
        {sub && <p className={`truncate text-xs ${bad ? 'text-rose-600' : 'text-slate-500'}`} title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

function SheetConnection({ s, manage }: { s: SheetsStatus; manage: boolean }) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const sheetUrl = s.config.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${s.config.spreadsheetId}/edit${s.config.gid ? `#gid=${s.config.gid}` : ''}` : '';
  const [f, setF] = useState({
    enabled: s.enabled, spreadsheetId: sheetUrl, sheetName: s.config.sheetName ?? '', headerRow: s.config.headerRow ?? 1,
    intervalMinutes: s.config.intervalMinutes ?? 5, mapping: s.config.mapping,
    autoAssign: s.config.autoAssign ?? { enabled: false, method: 'round_robin', userIds: [] as string[] },
  });
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showMapping, setShowMapping] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const refresh = () => { for (const k of ['sheets', 'sync-runs', 'sync-errors', 'leads', 'dashboard']) qc.invalidateQueries({ queryKey: [k] }); };

  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.put(`/integrations/sheets/${s.key}`, f); toast.success('Settings saved'); refresh(); return true; }
    catch (e) { setErr(e); return false; } finally { setBusy(false); }
  };
  const syncNow = async (kind: 'sync' | 'reconcile') => {
    setSyncing(true);
    try {
      const r = await api.post<{ created: number; updated: number; failed: number; rowsRead: number }>(`/integrations/sheets/${s.key}/${kind}`);
      toast.success(`${s.label}: ${r.rowsRead} rows read, ${r.created} new, ${r.updated} updated, ${r.failed} rejected`);
    } catch (e) { toast.error(errMsg(e)); }
    setSyncing(false); refresh();
  };
  const viaText = s.state.readVia ? `read via ${s.state.readVia === 'link' ? 'shared link' : 'service account'}` : null;

  return (
    <div className="space-y-5 p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Status" value={s.enabled ? 'Auto-sync on' : s.config.spreadsheetId ? 'Auto-sync off' : 'Not connected'} good={s.enabled} icon={<Sheet className="h-6 w-6 shrink-0 text-green-600" />} />
        <Stat label="Last sync" value={s.state.lastSyncAt ? ago(s.state.lastSyncAt) : 'Never'} sub={s.state.lastError ?? viaText} bad={!!s.state.lastError} />
        <Stat label="Leads from this sheet" value={String(s.leadCount)} sub={s.state.lastRow ? `processed up to row ${s.state.lastRow}` : null} />
        <Stat label="Rejected rows" value={String(s.unresolvedErrors)} bad={s.unresolvedErrors > 0} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={syncing} disabled={!s.config.spreadsheetId} onClick={() => syncNow('sync')}><RefreshCw className="h-4 w-4" />Sync now</Button>
        {manage && <Button variant="secondary" disabled={syncing || !s.config.spreadsheetId} onClick={() => syncNow('reconcile')} title="Re-read the whole sheet">Full re-read</Button>}
        {sheetUrl && <a href={sheetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 text-sm text-indigo-600 hover:underline"><ExternalLink className="h-4 w-4" />Open sheet</a>}
      </div>

      {manage && (
        <>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <p className="font-medium">How to connect</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-slate-600">
              <li>In Google Sheets click <b>Share</b> → General access → <b>Anyone with the link</b> → <b>Viewer</b>.</li>
              <li>Paste the sheet link below, tick <b>Enable automatic sync</b> and click <b>Save &amp; test</b>.</li>
              <li>Row 1 must hold the column headers. Names like <i>Name, Phone / Mobile, Email, City, Timestamp</i> are recognised automatically.</li>
            </ol>
            {s.credentialsConfigured && <p className="mt-2 text-xs text-slate-500">To keep the sheet private instead, share it with <code className="select-all">{s.serviceAccountEmail}</code> and fill in the tab name.</p>}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Google Sheet link" className="md:col-span-2"><Input value={f.spreadsheetId} onChange={(e) => setF({ ...f, spreadsheetId: e.target.value })} placeholder="https://docs.google.com/spreadsheets/d/…/edit" /></Field>
            <Field label="Tab name (optional)" hint="Leave empty to read the tab in the link (or the first tab)."><Input value={f.sheetName} onChange={(e) => setF({ ...f, sheetName: e.target.value })} placeholder="Sheet1" /></Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Header row"><Input type="number" min={1} value={f.headerRow} onChange={(e) => setF({ ...f, headerRow: Number(e.target.value) })} /></Field>
              <Field label="Check every (min)"><Input type="number" min={1} max={1440} value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })} /></Field>
            </div>
          </div>

          <div>
            <button className="text-sm font-medium text-indigo-600 hover:underline" onClick={() => setShowMapping(!showMapping)}>{showMapping ? 'Hide' : 'Show'} column mapping</button>
            <span className="ml-2 text-xs text-slate-500">Only needed if your headers aren't recognised automatically.</span>
            {showMapping && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {Object.keys(FIELD_LABELS).map((k) => (
                  <Field key={k} label={FIELD_LABELS[k]}><Input value={f.mapping[k] ?? ''} onChange={(e) => setF({ ...f, mapping: { ...f.mapping, [k]: e.target.value } })} /></Field>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={f.autoAssign.enabled} onChange={(e) => setF({ ...f, autoAssign: { ...f.autoAssign, enabled: e.target.checked } })} />
              Auto-assign new leads as they arrive
            </label>
            {f.autoAssign.enabled && (
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <Field label="Method">
                  <Select value={f.autoAssign.method} onChange={(e) => setF({ ...f, autoAssign: { ...f.autoAssign, method: e.target.value } })}>
                    <option value="round_robin">Round-robin</option><option value="workload">Workload-based</option>
                  </Select>
                </Field>
                <div className="md:col-span-2">
                  <span className="mb-1 block text-sm font-medium text-slate-700">Between</span>
                  <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {dir.data?.map((u) => (
                      <label key={u.id} className="flex items-center gap-1.5 text-sm">
                        <input type="checkbox" checked={f.autoAssign.userIds.includes(u.id)} onChange={(e) => setF({ ...f, autoAssign: { ...f.autoAssign, userIds: e.target.checked ? [...f.autoAssign.userIds, u.id] : f.autoAssign.userIds.filter((x) => x !== u.id) } })} />
                        {u.fullName}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {!f.autoAssign.enabled && <p className="mt-1 text-xs text-slate-500">New leads go to the Unassigned queue and managers are notified.</p>}
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Enable automatic sync
          </label>
          <ErrorBox error={err} />
          {test && (
            <div className={`rounded-lg p-3 text-sm ${test.ok ? 'bg-slate-50' : 'bg-rose-50 text-rose-800'}`}>
              {test.ok ? (
                <>
                  <p className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-green-500" />Connected via {test.via === 'link' ? 'the shared link' : 'the service account'}. <b>{test.rowCount}</b> lead rows in the sheet.</p>
                  {!!test.headers?.filter(Boolean).length && <p className="mt-1 text-slate-600">Columns: {test.headers.filter(Boolean).join(', ')}</p>}
                  {test.detected && !!Object.keys(test.detected).length && (
                    <p className="mt-1 text-slate-600">Using: {Object.entries(test.detected).map(([k, v]) => `${FIELD_LABELS[k] ?? k} ← "${v}"`).join(' · ')}</p>
                  )}
                  {test.warnings?.map((w) => <p key={w} className="mt-1 flex items-center gap-1.5 text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" />{w}</p>)}
                </>
              ) : <p>Connection failed: {test.error}</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={save}>Save settings</Button>
            <Button variant="secondary" onClick={async () => { if (!(await save())) return; try { setTest(await api.post(`/integrations/sheets/${s.key}/test`)); } catch (e) { toast.error(errMsg(e)); } }}><PlugZap className="h-4 w-4" />Save &amp; test</Button>
          </div>
        </>
      )}
    </div>
  );
}

function WebhookPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['lead-webhook'], queryFn: () => api.get<WebhookStatus>('/integrations/webhook') });
  const update = async (body: { enabled?: boolean; regenerate?: boolean }) => {
    try { qc.setQueryData(['lead-webhook'], await api.put<WebhookStatus>('/integrations/webhook', body)); toast.success('Saved'); } catch (e) { toast.error(errMsg(e)); }
  };
  if (!data) return <Spinner />;
  const copy = (t: string) => { navigator.clipboard.writeText(t).then(() => toast.success('Copied')); };
  const sample = [
    `curl -X POST "${data.url}&source=website" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"name":"Asha Rao","phone":"9876543210","email":"asha@example.com","city":"Chennai","message":"Need a quote"}'`,
  ].join('\n');
  return (
    <div className="space-y-5 p-5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Badge className={data.enabled ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-700'}>{data.enabled ? 'On' : 'Off'}</Badge>
        <span className="text-slate-600">{data.leadsReceived} leads received{data.lastRun ? ` · last ${ago(data.lastRun.startedAt)}` : ''}</span>
      </div>
      <div>
        <p className="mb-1 font-medium">Webhook URL</p>
        <div className="flex gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs">{data.url}</code>
          <Button variant="secondary" onClick={() => copy(data.url)}><Copy className="h-4 w-4" />Copy</Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Anyone with this URL can add leads, so keep it private. Add <code>&amp;source=website</code> (or <code>justdial</code>, <code>indiamart</code>…) to label where the leads came from.</p>
      </div>
      {data.publicUrlIsLocal && (
        <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-3 text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>This address points to this computer (localhost), so other software can't reach it yet. Once the CRM is deployed, set <code>PUBLIC_API_URL</code> to its public https address and this URL updates automatically.</span></p>
      )}
      <div className="rounded-lg border border-slate-200 p-4">
        <p className="font-medium">How to use it</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
          <li>Method <b>POST</b>, body as <b>JSON</b> or <b>form fields</b>: one lead, a list of leads, or <code>{'{"leads":[…]}'}</code>.</li>
          <li>Field names are matched automatically: <i>name / full_name, phone / mobile, email, city, campaign, created_time…</i> Extra fields (like a message) are kept and shown on the lead.</li>
          <li>Each lead needs a phone number or an email. Sending the same lead again doesn't create a duplicate.</li>
          <li>The reply says how many leads were created and why any were rejected.</li>
        </ul>
        <p className="mb-1 mt-3 font-medium">Test example</p>
        <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs">{sample}</pre>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => update({ enabled: !data.enabled })}>{data.enabled ? 'Turn off' : 'Turn on'}</Button>
        <Button variant="secondary" onClick={() => confirm('Create a new URL? The old one stops working immediately and you must update your software.') && update({ regenerate: true })}><RotateCcw className="h-4 w-4" />New URL</Button>
      </div>
    </div>
  );
}

function Runs() {
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['sync-runs', page], queryFn: () => api.get<Paged<SyncRun>>('/integrations/sync-runs', { page, pageSize: 15 }), refetchInterval: 15_000 });
  if (!data) return <Spinner />;
  return (
    <>
      <Table>
        <thead><tr><Th>Started</Th><Th>Source</Th><Th>Trigger</Th><Th>Result</Th><Th className="text-right">Read</Th><Th className="text-right">New</Th><Th className="text-right">Updated</Th><Th className="text-right">Unchanged</Th><Th className="text-right">Rejected</Th><Th>Error</Th></tr></thead>
        <tbody>
          {data.items.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{fmtDateTime(r.startedAt)}</Td>
              <Td>{r.source ? SOURCE_LABEL[r.source] ?? r.source : '—'}</Td>
              <Td className="capitalize">{r.trigger}</Td>
              <Td><Badge className={RUN_COLORS[r.status]}>{r.status.toLowerCase()}</Badge></Td>
              <Td className="text-right tabular-nums">{r.rowsRead}</Td><Td className="text-right tabular-nums">{r.created}</Td>
              <Td className="text-right tabular-nums">{r.updated}</Td><Td className="text-right tabular-nums">{r.skipped}</Td>
              <Td className={`text-right tabular-nums ${r.failed ? 'font-semibold text-rose-600' : ''}`}>{r.failed}</Td>
              <Td className="max-w-xs truncate text-xs text-rose-600">{r.error}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
    </>
  );
}

function Errors() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const { data } = useQuery({ queryKey: ['sync-errors', page], queryFn: () => api.get<Paged<RowError>>('/integrations/sync-errors', { resolved: 'false', page, pageSize: 20 }) });
  const refresh = () => { for (const k of ['sync-errors', 'sync-runs', 'sheets', 'leads']) qc.invalidateQueries({ queryKey: [k] }); };
  if (!data) return <Spinner />;
  return (
    <>
      <div className="flex items-center justify-between p-3">
        <p className="text-sm text-slate-600">Rows that could not be imported. Fix the data at the source, then retry.</p>
        <Button size="sm" variant="secondary" disabled={!data.total} onClick={async () => {
          try { const r = await api.post<{ created: number; failed: number }>('/integrations/sync-errors/retry', {}); toast.success(`Retried: ${r.created} imported, ${r.failed} still failing`); refresh(); } catch (e) { toast.error(errMsg(e)); }
        }}><RotateCcw className="h-4 w-4" />Retry all</Button>
      </div>
      {!data.items.length ? <p className="px-4 pb-6 text-sm text-slate-500">No rejected rows.</p> : (
        <Table>
          <thead><tr><Th>Row</Th><Th>Reason</Th><Th>Data</Th><Th>When</Th><Th /></tr></thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id}>
                <Td className="tabular-nums">{e.rowNumber}</Td>
                <Td className="text-rose-700">{e.reason}</Td>
                <Td className="max-w-md truncate font-mono text-xs text-slate-500">{Object.entries(e.rawRow).filter(([, v]) => v).slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  ')}</Td>
                <Td className="whitespace-nowrap text-slate-500">{ago(e.createdAt)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={async () => { try { await api.post('/integrations/sync-errors/retry', { ids: [e.id] }); refresh(); } catch (er) { toast.error(errMsg(er)); } }}>Retry</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { await api.post(`/integrations/sync-errors/${e.id}/dismiss`); refresh(); }}>Dismiss</Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
    </>
  );
}

function Telephony() {
  const { data } = useQuery({ queryKey: ['telephony'], queryFn: () => api.get<{ provider: string; configured: boolean; callerId: string | null; webhookUrl: string; publicUrlIsLocal: boolean }>('/integrations/telephony') });
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4 p-5 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Active provider:</span>
        <Badge className={data.provider === 'mock' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}>{data.provider === 'mock' ? 'Simulator (no real calls)' : 'Exotel'}</Badge>
        {data.provider !== 'mock' && (data.configured ? <Badge className="bg-green-100 text-green-800">configured</Badge> : <Badge className="bg-rose-100 text-rose-800">missing credentials</Badge>)}
      </div>
      {data.provider === 'mock' ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p>The simulator lets you try the full call flow: ringing, connected or no answer, duration and a sample recording, without placing real calls.</p>
          <p className="mt-2 font-medium">To make real recorded calls with Exotel:</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-700">
            <li>Create an Exotel account and buy an ExoPhone (virtual number). Enable call recording.</li>
            <li>In the server <code>.env</code> set <code>TELEPHONY_PROVIDER=exotel</code>, <code>EXOTEL_SID</code>, <code>EXOTEL_API_KEY</code>, <code>EXOTEL_API_TOKEN</code>, <code>EXOTEL_CALLER_ID</code> and <code>EXOTEL_SUBDOMAIN</code>.</li>
            <li>Set <code>PUBLIC_API_URL</code> to the public HTTPS address of the API so Exotel can post call results back.</li>
            <li>Make sure every employee has their phone number set (Users page or their profile).</li>
          </ol>
        </div>
      ) : (
        <dl className="grid grid-cols-3 gap-y-2">
          <dt className="text-slate-500">Caller ID</dt><dd className="col-span-2">{data.callerId ?? '—'}</dd>
          <dt className="text-slate-500">Status callback</dt><dd className="col-span-2 font-mono text-xs">{data.webhookUrl}</dd>
        </dl>
      )}
      {data.publicUrlIsLocal && data.provider !== 'mock' && <p className="text-amber-700">PUBLIC_API_URL points to localhost, so the provider can't reach it. Call results won't arrive until it's a public URL.</p>}
      <p className="text-xs text-slate-500">Before recording calls, make sure customers are notified (e.g. an IVR announcement) and agree a retention period, as required by Indian telecom and privacy rules.</p>
    </div>
  );
}

type Tab = 'website' | 'meta' | 'webhook' | 'runs' | 'errors' | 'telephony';

export default function AdminIntegrations() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('integrations.manage');
  const [tab, setTab] = useState<Tab>('website');
  const { data: sheets, isLoading } = useQuery({ queryKey: ['sheets'], queryFn: () => api.get<SheetsStatus[]>('/integrations/sheets'), refetchInterval: 15_000 });
  const fileRef = useRef<HTMLInputElement>(null);

  if (isLoading || !sheets) return <Spinner />;
  const errors = sheets.reduce((n, s) => n + s.unresolvedErrors, 0);
  const current = sheets.find((s) => s.key === tab);
  return (
    <div>
      <PageHeader title="Integrations" subtitle="Where leads come from: website and Meta Ads Google Sheets, a webhook for other software, and CSV import"
        actions={
          <>
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={async (e) => {
              const file = e.target.files?.[0]; if (!file) return;
              try { const r = await api.upload<{ created: number; failed: number }>('/integrations/leads/import-csv', file); toast.success(`CSV: ${r.created} new, ${r.failed} rejected`); for (const k of ['sync-runs', 'sync-errors', 'leads']) qc.invalidateQueries({ queryKey: [k] }); }
              catch (er) { toast.error(errMsg(er)); }
              e.target.value = '';
            }} />
            <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Import CSV</Button>
          </>
        } />
      <Card>
        <div className="px-4 pt-2">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'website', label: <span className="flex items-center gap-1"><Globe className="h-3.5 w-3.5" />Website leads</span> },
            { value: 'meta', label: <span className="flex items-center gap-1"><Sheet className="h-3.5 w-3.5" />Meta Ads leads</span> },
            ...(manage ? [{ value: 'webhook' as const, label: <span className="flex items-center gap-1"><Webhook className="h-3.5 w-3.5" />Lead webhook</span> }] : []),
            { value: 'runs', label: 'Sync history' }, { value: 'errors', label: 'Rejected rows', count: errors },
            ...(manage ? [{ value: 'telephony' as const, label: <span className="flex items-center gap-1"><PhoneCall className="h-3.5 w-3.5" />Telephony</span> }] : []),
          ]} />
        </div>
        {current && <SheetConnection key={current.key} s={current} manage={manage} />}
        {tab === 'webhook' && <WebhookPanel />}
        {tab === 'runs' && <Runs />}
        {tab === 'errors' && <Errors />}
        {tab === 'telephony' && <Telephony />}
      </Card>
    </div>
  );
}
