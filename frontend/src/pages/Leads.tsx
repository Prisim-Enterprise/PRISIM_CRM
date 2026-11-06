import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import clsx from 'clsx';
import { Download, Plus, Search, Upload, UserPlus, AlertCircle, PhoneCall } from 'lucide-react';
import { api, errMsg, Paged } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { LEAD_STATUS, ago, fmtPhone, fmtRelativeDay } from '../lib/format';
import { Avatar, Badge, Button, Card, Empty, Input, PageHeader, Pagination, Select, Spinner, Table, Td, Th } from '../components/ui';
import { AssignModal, CreateLeadModal } from '../components/LeadModals';

export interface LeadRow {
  id: string; fullName: string; phoneE164: string | null; email: string | null; city: string | null; status: string;
  campaignName: string | null; adsetName: string | null; createdAt: string; assignedUser: { id: string; fullName: string } | null;
  source: { key: string; name: string }; nextFollowUpAt: string | null; followUpOverdue: boolean; callCount: number;
}

export default function Leads() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const [search, setSearch] = useState(get('search'));
  const [selected, setSelected] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dir = useDirectory();
  const canAssign = can('leads.assign.all', 'leads.assign.team');

  const query = {
    search: get('search'), status: get('status'), owner: get('owner'), campaign: get('campaign'), source: get('source'),
    from: get('from'), to: get('to'), sort: get('sort'), open: get('open'), page: get('page') || 1, pageSize: 25,
  };
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['leads', query], queryFn: () => api.get<Paged<LeadRow>>('/leads', query), placeholderData: keepPreviousData,
  });
  const opts = useQuery({ queryKey: ['lead-filters'], queryFn: () => api.get<{ campaigns: string[]; sources: { key: string; name: string }[] }>('/leads/filters') });

  const allOnPage = data?.items.map((l) => l.id) ?? [];
  const allChecked = allOnPage.length > 0 && allOnPage.every((id) => selected.includes(id));

  const importCsv = async (file?: File) => {
    if (!file) return;
    const t = toast.loading('Importing leads…');
    try {
      const r = await api.upload<{ created: number; updated: number; skipped: number; failed: number }>('/integrations/leads/import-csv', file);
      toast.success(`Imported: ${r.created} new, ${r.updated} updated, ${r.skipped} unchanged${r.failed ? `, ${r.failed} rejected (see Integrations)` : ''}`, { id: t });
      qc.invalidateQueries({ queryKey: ['leads'] });
    } catch (e) { toast.error(errMsg(e), { id: t }); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const presets = [
    { label: 'All', owner: '', open: '' },
    { label: 'My leads', owner: 'me', open: 'true' },
    ...(canAssign ? [{ label: 'Unassigned', owner: 'unassigned', open: '' }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Meta Ads leads from Google Sheets, plus manual and imported leads"
        actions={
          <>
            {can('leads.export') && <Button variant="secondary" onClick={() => api.download('/leads/export', query, 'leads.csv').catch((e) => toast.error(errMsg(e)))}><Download className="h-4 w-4" />Export</Button>}
            {can('leads.import') && (
              <>
                <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => importCsv(e.target.files?.[0])} />
                <Button variant="secondary" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />Import CSV</Button>
              </>
            )}
            {can('leads.create') && <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />New lead</Button>}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button key={p.label} onClick={() => { const n = new URLSearchParams(sp); p.owner ? n.set('owner', p.owner) : n.delete('owner'); p.open ? n.set('open', p.open) : n.delete('open'); n.delete('page'); setSp(n); }}
            className={clsx('rounded-full px-3 py-1 text-sm font-medium', get('owner') === p.owner && get('open') === p.open ? 'bg-slate-900 text-white' : 'bg-surface text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')}>
            {p.label}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <form onSubmit={(e) => { e.preventDefault(); set('search', search); }} className="relative w-full sm:min-w-56 sm:w-auto sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => search !== get('search') && set('search', search)} placeholder="Search name, phone or email" className="pl-9" />
          </form>
          <Select value={get('status')} onChange={(e) => set('status', e.target.value)} className="w-44">
            <option value="">Any status</option>
            {Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select value={['me', 'unassigned', ''].includes(get('owner')) ? '' : get('owner')} onChange={(e) => set('owner', e.target.value)} className="w-40">
            <option value="">Any owner</option>
            {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
          <Select value={get('campaign')} onChange={(e) => set('campaign', e.target.value)} className="w-48">
            <option value="">All campaigns</option>
            {opts.data?.campaigns.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <Input type="date" value={get('from')} onChange={(e) => set('from', e.target.value)} className="w-36" title="Created from" />
          <Input type="date" value={get('to')} onChange={(e) => set('to', e.target.value)} className="w-36" title="Created to" />
          <Select value={get('sort')} onChange={(e) => set('sort', e.target.value)} className="w-36">
            <option value="">Newest first</option><option value="oldest">Oldest first</option><option value="updated">Recently active</option>
          </Select>
        </div>

        {selected.length > 0 && canAssign && (
          <div className="flex items-center gap-3 border-b border-indigo-100 bg-indigo-50 px-4 py-2 text-sm">
            <span className="font-medium text-indigo-900">{selected.length} selected</span>
            <Button size="sm" onClick={() => setAssignOpen(true)}><UserPlus className="h-4 w-4" />Assign</Button>
            <button className="text-indigo-700 hover:underline" onClick={() => setSelected([])}>Clear</button>
          </div>
        )}

        {isLoading ? <Spinner /> : !data?.items.length ? (
          <Empty title="No leads match these filters">Try clearing filters, or import leads from Google Sheets.</Empty>
        ) : (
          <div className={clsx(isFetching && 'opacity-60 transition')}>
            <Table>
              <thead>
                <tr>
                  {canAssign && <Th className="w-8"><input type="checkbox" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...allOnPage])] : selected.filter((x) => !allOnPage.includes(x)))} /></Th>}
                  <Th>Lead</Th><Th>Status</Th><Th>Campaign</Th><Th>Owner</Th><Th>Next follow-up</Th><Th className="text-right">Calls</Th><Th>Received</Th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((l) => (
                  <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/leads/${l.id}`)}>
                    {canAssign && (
                      <Td><input type="checkbox" checked={selected.includes(l.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected(e.target.checked ? [...selected, l.id] : selected.filter((x) => x !== l.id))} /></Td>
                    )}
                    <Td>
                      <Link to={`/leads/${l.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-slate-900 hover:text-indigo-600">{l.fullName}</Link>
                      <p className="text-xs text-slate-500">{fmtPhone(l.phoneE164)}{l.city ? ` · ${l.city}` : ''}</p>
                    </Td>
                    <Td><Badge className={LEAD_STATUS[l.status]?.color}>{LEAD_STATUS[l.status]?.label}</Badge></Td>
                    <Td><p className="max-w-52 truncate">{l.campaignName ?? <span className="text-slate-400">{l.source.name}</span>}</p>{l.adsetName && <p className="max-w-52 truncate text-xs text-slate-500">{l.adsetName}</p>}</Td>
                    <Td>
                      {l.assignedUser ? (
                        <span className="flex items-center gap-2"><Avatar name={l.assignedUser.fullName} size="sm" /><span className={clsx(l.assignedUser.id === me?.id && 'font-medium')}>{l.assignedUser.id === me?.id ? 'You' : l.assignedUser.fullName}</span></span>
                      ) : <span className="text-amber-600">Unassigned</span>}
                    </Td>
                    <Td>
                      {l.nextFollowUpAt ? (
                        <span className={clsx('flex items-center gap-1', l.followUpOverdue && 'font-medium text-rose-600')}>
                          {l.followUpOverdue && <AlertCircle className="h-3.5 w-3.5" />}{fmtRelativeDay(l.nextFollowUpAt)}
                        </span>
                      ) : <span className="text-slate-400">—</span>}
                    </Td>
                    <Td className="text-right tabular-nums">{l.callCount ? <span className="inline-flex items-center gap-1"><PhoneCall className="h-3 w-3 text-slate-400" />{l.callCount}</span> : <span className="text-slate-400">0</span>}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{ago(l.createdAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={data.page} pages={data.pages} total={data.total} onPage={(p) => set('page', String(p))} />
          </div>
        )}
      </Card>
      <AssignModal open={assignOpen} onClose={() => setAssignOpen(false)} leadIds={selected} onDone={() => setSelected([])} />
      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
