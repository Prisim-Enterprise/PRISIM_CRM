import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarCheck } from 'lucide-react';
import { api, Paged } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { FOLLOW_UP_TYPES, LEAD_STATUS, fmtDateTime, fmtPhone, fmtRelativeDay } from '../lib/format';
import { Avatar, Badge, Card, Empty, PageHeader, Pagination, Select, Spinner, StatCard, Table, Tabs, Td, Th } from '../components/ui';
import { CompleteFollowUpModal } from '../components/LeadModals';
import { FollowUpActions, RescheduleModal } from './LeadDetail';

interface FU {
  id: string; dueAt: string; type: string; note: string | null; status: string; outcome: string | null; completedAt: string | null;
  isOverdue: boolean; rescheduleCount: number; cancelReason: string | null;
  lead: { id: string; fullName: string; phoneE164: string | null; status: string; campaignName: string | null };
  owner: { id: string; fullName: string };
}
type View = 'today' | 'overdue' | 'upcoming' | 'completed' | 'cancelled';

export default function FollowUps() {
  const { me, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view = (sp.get('view') as View) || 'today';
  const [owner, setOwner] = useState(can('followups.view.all', 'followups.view.team') ? '' : 'me');
  const [page, setPage] = useState(1);
  const [complete, setComplete] = useState<FU | null>(null);
  const [resched, setResched] = useState<FU | null>(null);
  const dir = useDirectory();
  const summary = useQuery({ queryKey: ['fu-summary', owner], queryFn: () => api.get<Record<string, number>>('/follow-ups/summary', { owner }) });
  const { data, isLoading } = useQuery({
    queryKey: ['follow-ups', view, owner, page],
    queryFn: () => api.get<Paged<FU>>('/follow-ups', { view, owner, page, pageSize: 25 }),
  });
  const s = summary.data;
  const setView = (v: View) => { setSp({ view: v }); setPage(1); };
  const isManager = can('followups.view.all', 'followups.view.team');

  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Your daily call list. Complete each one with an outcome and the next step."
        actions={isManager && (
          <Select value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }} className="w-48">
            <option value="">Everyone I manage</option>
            <option value="me">Only mine</option>
            {dir.data?.filter((u) => u.id !== me?.id && (can('followups.view.all') || me?.teamIds.includes(u.teamId ?? ''))).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </Select>
        )} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Due today" value={s?.dueToday ?? '–'} onClick={() => setView('today')} />
        <StatCard label="Overdue" value={s?.overdue ?? '–'} tone={s?.overdue ? 'bad' : 'default'} onClick={() => setView('overdue')} />
        <StatCard label="Upcoming" value={s?.upcoming ?? '–'} onClick={() => setView('upcoming')} />
        <StatCard label="Completed today" value={s?.completedToday ?? '–'} tone="good" onClick={() => setView('completed')} />
      </div>
      <Card>
        <div className="px-4 pt-2">
          <Tabs value={view} onChange={setView} tabs={[
            { value: 'today', label: 'Today', count: s?.dueToday }, { value: 'overdue', label: 'Overdue', count: s?.overdue },
            { value: 'upcoming', label: 'Upcoming', count: s?.upcoming }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' },
          ]} />
        </div>
        {isLoading ? <Spinner /> : !data?.items.length ? (
          <Empty title={view === 'overdue' ? 'Nothing overdue. Nice work!' : 'No follow-ups here'} icon={<CalendarCheck className="h-10 w-10" />} />
        ) : (
          <>
            <Table>
              <thead><tr><Th>When</Th><Th>Lead</Th><Th>Action</Th>{isManager && <Th>Owner</Th>}<Th>{view === 'completed' ? 'Outcome' : ''}</Th></tr></thead>
              <tbody>
                {data.items.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50">
                    <Td className="whitespace-nowrap">
                      <span className={clsx('font-medium', f.isOverdue && 'text-rose-600')}>{fmtRelativeDay(f.dueAt)}</span>
                      {f.rescheduleCount > 0 && <p className="text-xs text-slate-400">rescheduled {f.rescheduleCount}×</p>}
                    </Td>
                    <Td>
                      <Link to={`/leads/${f.lead.id}`} className="font-medium hover:text-indigo-600">{f.lead.fullName}</Link>
                      <p className="flex items-center gap-2 text-xs text-slate-500">
                        {f.lead.phoneE164 && <a href={`tel:${f.lead.phoneE164}`} className="hover:underline">{fmtPhone(f.lead.phoneE164)}</a>}
                        <Badge className={LEAD_STATUS[f.lead.status]?.color}>{LEAD_STATUS[f.lead.status]?.label}</Badge>
                      </p>
                    </Td>
                    <Td><Badge className="bg-violet-50 text-violet-700">{FOLLOW_UP_TYPES[f.type] ?? f.type}</Badge>{f.note && <p className="mt-0.5 max-w-sm text-sm text-slate-600">{f.note}</p>}</Td>
                    {isManager && <Td><span className="flex items-center gap-2"><Avatar name={f.owner.fullName} size="sm" />{f.owner.id === me?.id ? 'You' : f.owner.fullName}</span></Td>}
                    <Td>
                      {f.status === 'PENDING' ? <FollowUpActions fu={f} onComplete={() => setComplete(f)} onReschedule={() => setResched(f)} />
                        : f.status === 'COMPLETED' ? <span className="text-sm text-emerald-700">{f.outcome}<span className="block text-xs text-slate-400">{fmtDateTime(f.completedAt)}</span></span>
                        : <span className="text-sm text-slate-500">{f.cancelReason}</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CompleteFollowUpModal open={!!complete} onClose={() => setComplete(null)} followUp={complete} />
      <RescheduleModal fu={resched} onClose={() => setResched(null)} />
    </div>
  );
}
