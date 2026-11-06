import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PhoneIncoming, PhoneOutgoing, Search } from 'lucide-react';
import { api, Paged } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { CALL_OUTCOMES, CALL_STATUS, fmtDateTime, fmtDuration, fmtPhone } from '../lib/format';
import { Avatar, Badge, Card, Empty, Input, PageHeader, Pagination, Select, Spinner, Table, Td, Th } from '../components/ui';
import { RecordingPlayer } from '../components/Recording';

interface CallRow {
  id: string; direction: string; status: string; outcome: string | null; notes: string | null; provider: string;
  durationSeconds: number | null; startedAt: string | null; createdAt: string; fromNumber: string | null; toNumber: string | null;
  hasRecording: boolean; canPlayRecording: boolean;
  user: { id: string; fullName: string }; lead: { id: string; fullName: string; phoneE164: string | null };
}

export default function Calls() {
  const { me, can } = useAuth();
  const dir = useDirectory();
  const [f, setF] = useState({ userId: '', outcome: '', from: '', to: '', search: '', hasRecording: '' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = { ...f, page, pageSize: 25 };
  const { data, isLoading } = useQuery({ queryKey: ['calls', q], queryFn: () => api.get<Paged<CallRow>>('/calls', q), placeholderData: keepPreviousData });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setPage(1); };
  const isManager = can('calls.view.all', 'calls.view.team');

  return (
    <div>
      <PageHeader title="Calls" subtitle={isManager ? 'Who called whom, when, for how long, the outcome and the recording' : 'Your call history'} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <form onSubmit={(e) => { e.preventDefault(); setF({ ...f, search }); setPage(1); }} className="relative w-full sm:min-w-56 sm:w-auto sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer name or phone" className="pl-9" />
          </form>
          {isManager && (
            <Select value={f.userId} onChange={set('userId')} className="w-44">
              <option value="">All employees</option>
              <option value="me">My calls</option>
              {dir.data?.filter((u) => can('calls.view.all') || me?.teamIds.includes(u.teamId ?? '')).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          )}
          <Select value={f.outcome} onChange={set('outcome')} className="w-44">
            <option value="">Any outcome</option>
            {Object.entries(CALL_OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select value={f.hasRecording} onChange={set('hasRecording')} className="w-40">
            <option value="">All calls</option><option value="true">With recording</option>
          </Select>
          <Input type="date" value={f.from} onChange={set('from')} className="w-36" />
          <Input type="date" value={f.to} onChange={set('to')} className="w-36" />
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? <Empty title="No calls found" /> : (
          <>
            <Table>
              <thead><tr><Th>When</Th><Th>Employee</Th><Th>Customer</Th><Th>Result</Th><Th>Duration</Th><Th>Notes</Th><Th>Recording</Th></tr></thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap text-sm">{fmtDateTime(c.startedAt ?? c.createdAt)}</Td>
                    <Td><span className="flex items-center gap-2"><Avatar name={c.user.fullName} size="sm" />{c.user.id === me?.id ? 'You' : c.user.fullName}</span></Td>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {c.direction === 'INBOUND' ? <PhoneIncoming className="h-3.5 w-3.5 text-sky-500" /> : <PhoneOutgoing className="h-3.5 w-3.5 text-emerald-500" />}
                        <Link to={`/leads/${c.lead.id}`} className="font-medium hover:text-indigo-600">{c.lead.fullName}</Link>
                      </span>
                      <p className="text-xs text-slate-500">{fmtPhone(c.lead.phoneE164)}{c.provider !== 'manual' && ` · ${c.provider === 'mock' ? 'simulated' : c.provider}`}</p>
                    </Td>
                    <Td>
                      <div className="flex flex-col items-start gap-1">
                        <Badge className={CALL_STATUS[c.status]?.color}>{CALL_STATUS[c.status]?.label}</Badge>
                        {c.outcome && <Badge className="bg-indigo-50 text-indigo-700">{CALL_OUTCOMES[c.outcome] ?? c.outcome}</Badge>}
                      </div>
                    </Td>
                    <Td className="tabular-nums">{fmtDuration(c.durationSeconds)}</Td>
                    <Td><p className="line-clamp-2 max-w-xs text-sm text-slate-600">{c.notes ?? <span className="text-slate-400">—</span>}</p></Td>
                    <Td className="min-w-48">{c.hasRecording ? <RecordingPlayer callId={c.id} canPlay={c.canPlayRecording} /> : <span className="text-xs text-slate-400">None</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
