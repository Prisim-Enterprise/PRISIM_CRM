import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, Paged } from '../lib/api';
import type { LeadRow } from './Leads';
import { useAuth } from '../lib/auth';
import { useDirectory, useTeams } from '../lib/hooks';
import { CALL_OUTCOMES, LEAD_STATUS, ago, fmtDateTime, fmtDuration, fmtPhone, pct } from '../lib/format';
import { Briefcase, CalendarClock, Globe, KanbanSquare, MessageSquareText, PhoneCall, StickyNote, Users } from 'lucide-react';
import { Avatar, Badge, Card, Input, PageHeader, Select, Spinner, StatCard, Table, Td, Th } from '../components/ui';

interface Dash {
  range: { from: string; to: string };
  scope: 'all' | 'team' | 'own';
  metrics: Record<string, number | null>;
  charts: {
    daily: { date: string; leads: number; calls: number; connected: number }[];
    leadsByStatus: { status: string; count: number }[];
    campaigns: { campaign: string; leads: number; converted: number }[];
    callOutcomes: { outcome: string; count: number }[];
    leadsBySource: { key: string; name: string; leads: number; today: number; converted: number }[];
  };
}
interface EmpRow {
  userId: string; name: string; team: string | null; leadsAssigned: number; openLeads: number; callsMade: number; connectedCalls: number;
  talkTimeSeconds: number; followUpsCompleted: number; missedFollowUps: number; converted: number; conversionPerAssigned: number | null;
  tasksCompleted: number; overdueTasks: number;
}

interface ActivityItem { id: string; at: string; kind: string; actor: { id: string; fullName: string } | null; text: string; detail?: string | null; link: string }
interface ClientSummary { activeClients: number | null; openWork: number; submitted: number; overdue: number; myOpen: number }

const KIND_ICON: Record<string, typeof Users> = {
  lead: Users, note: StickyNote, call: PhoneCall, followup: CalendarClock, task: KanbanSquare, feedback: MessageSquareText, client: Briefcase,
};
const KIND_LABEL: Record<string, string> = {
  '': 'Everything', lead: 'Leads', note: 'Notes', call: 'Calls', followup: 'Follow-ups', task: 'Tasks', feedback: 'Feedback', client: 'Clients',
};

function ActivityFeed({ userId, teamId, title }: { userId: string; teamId: string; title: string }) {
  const nav = useNavigate();
  const [kind, setKind] = useState('');
  const q = useQuery({
    queryKey: ['activity', userId, teamId], queryFn: () => api.get<ActivityItem[]>('/reports/activity', { userId, teamId, limit: '100' }),
    refetchInterval: 30_000,
  });
  const items = (q.data ?? []).filter((i) => !kind || i.kind === kind);
  return (
    <Card title={title} actions={
      <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-36">
        {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
    }>
      {q.isLoading ? <Spinner /> : !items.length ? <p className="p-4 text-sm text-slate-500">No activity yet.</p> : (
        <ul className="scroll-thin max-h-[28rem] divide-y divide-slate-100 overflow-y-auto">
          {items.map((i) => {
            const Icon = KIND_ICON[i.kind] ?? Users;
            return (
              <li key={i.id}>
                <button onClick={() => nav(i.link)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50">
                  <span className="relative mt-0.5"><Avatar name={i.actor?.fullName ?? '?'} size="sm" /><Icon className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-surface p-px text-indigo-500" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm"><span className="font-medium">{i.actor?.fullName ?? 'Anonymous'}</span> {i.text}</span>
                    {i.detail && <span className="block truncate text-xs text-slate-500">{i.detail}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400" title={fmtDateTime(i.at)}>{ago(i.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const STATUS_COLORS: Record<string, string> = {
  NEW: '#0ea5e9', UNASSIGNED: '#f59e0b', ASSIGNED: '#262626', CONTACT_ATTEMPTED: '#fb923c', CONTACTED: '#06b6d4', INTERESTED: '#10b981',
  FOLLOW_UP_REQUIRED: '#8b5cf6', CONVERTED: '#16a34a', LOST: '#94a3b8', INVALID: '#f43f5e', DUPLICATE: '#a8a29e',
};
const OUTCOME_COLORS = ['#10b981', '#ff7a00', '#8b5cf6', '#f59e0b', '#16a34a', '#94a3b8', '#fb923c', '#f43f5e', '#64748b', '#cbd5e1'];

export default function Dashboard() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const [from, setFrom] = useState(format(subDays(new Date(), 29), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [userId, setUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [campaign, setCampaign] = useState('');
  const [source, setSource] = useState('');
  const isManager = can('reports.view.all', 'reports.view.team');
  const filters = { from, to, userId, teamId, campaign, source };

  const { data, isLoading } = useQuery({ queryKey: ['dashboard', filters], queryFn: () => api.get<Dash>('/reports/dashboard', filters) });
  const emps = useQuery({ queryKey: ['emp-report', filters], queryFn: () => api.get<EmpRow[]>('/reports/employees', filters), enabled: isManager });
  const opts = useQuery({ queryKey: ['lead-filters'], queryFn: () => api.get<{ campaigns: string[]; sources: { key: string; name: string }[] }>('/leads/filters') });
  const websiteLeads = useQuery({
    queryKey: ['leads', 'website-latest'], refetchInterval: 60_000,
    queryFn: () => api.get<Paged<LeadRow>>('/leads', { source: 'website', pageSize: 8, sort: 'newest' }),
  });
  const dir = useDirectory();
  const teams = useTeams();
  const clients = useQuery({ queryKey: ['client-summary'], queryFn: () => api.get<ClientSummary>('/clients/summary') });

  const m = data?.metrics;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <PageHeader
        title={`${greeting}, ${me?.fullName.split(' ')[0]}`}
        subtitle={data ? (data.scope === 'all' ? 'Organisation overview' : data.scope === 'team' ? 'Your team overview' : 'Your personal overview') : ' '}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
            <span className="text-slate-400">–</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
            <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-40">
              <option value="">All sources</option>
              {opts.data?.sources.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </Select>
            <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="w-44">
              <option value="">All campaigns</option>
              {opts.data?.campaigns.map((c) => <option key={c}>{c}</option>)}
            </Select>
            {can('reports.view.all') && (
              <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="w-36">
                <option value="">All teams</option>
                {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
            {isManager && (
              <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-40">
                <option value="">All employees</option>
                {dir.data?.filter((u) => can('reports.view.all') || me?.teamIds.includes(u.teamId ?? '')).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            )}
          </div>
        }
      />
      {isLoading || !m ? <Spinner /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <StatCard label="Leads in period" value={m.leadsTotal} sub={`${m.newToday} new today`} onClick={() => nav('/leads')} />
            {(() => {
              const w = data.charts.leadsBySource.find((x) => x.key === 'website');
              return <StatCard label="Website leads" value={w?.leads ?? 0} sub={`${w?.today ?? 0} today`} tone={w?.today ? 'good' : 'default'} onClick={() => nav('/leads?source=website')} />;
            })()}
            {m.unassigned !== null && <StatCard label="Unassigned" value={m.unassigned} tone={m.unassigned ? 'warn' : 'default'} sub="waiting for an owner" onClick={() => nav('/leads?owner=unassigned')} />}
            <StatCard label="Active assigned" value={m.assigned} sub="open leads with owner" />
            <StatCard label="Converted" value={m.converted} tone="good" sub={`${pct(m.conversionRate ?? 0)} of period's leads`} />
            <StatCard label="Lost" value={m.lost} sub="closed without conversion" />
            <StatCard label="Calls made" value={m.callsMade} sub={`${m.connectedCalls} connected · ${fmtDuration(m.talkTimeSeconds)} talk`} onClick={() => nav('/calls')} />
            <StatCard label="Follow-ups today" value={m.followUpsToday} onClick={() => nav('/follow-ups?view=today')} />
            <StatCard label="Overdue follow-ups" value={m.overdueFollowUps} tone={m.overdueFollowUps ? 'bad' : 'default'} onClick={() => nav('/follow-ups?view=overdue')} />
            <StatCard label="Follow-ups done" value={m.followUpsCompleted} sub="in period" />
            <StatCard label="Open tasks" value={m.pendingTasks} onClick={() => nav('/tasks')} />
            <StatCard label="Overdue tasks" value={m.overdueTasks} tone={m.overdueTasks ? 'bad' : 'default'} onClick={() => nav('/tasks?due=overdue')} />
            {m.openFeedback !== null && <StatCard label="Open feedback" value={m.openFeedback} tone={m.openFeedback ? 'warn' : 'default'} onClick={() => nav('/feedback?tab=inbox')} />}
            {clients.data && (clients.data.activeClients !== null ? (
              <>
                <StatCard label="Active clients" value={clients.data.activeClients} sub={`${clients.data.openWork} open work items`} onClick={() => nav('/clients')} />
                <StatCard label="Client work to review" value={clients.data.submitted} tone={clients.data.submitted ? 'warn' : 'default'} sub={clients.data.overdue ? `${clients.data.overdue} overdue` : 'submitted by the team'} onClick={() => nav('/clients?tab=work')} />
              </>
            ) : (
              <StatCard label="My client work" value={clients.data.myOpen} tone={clients.data.overdue ? 'bad' : 'default'} sub={clients.data.overdue ? `${clients.data.overdue} overdue` : 'open items'} onClick={() => nav('/clients?tab=work')} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card title="Leads by source" actions={<span className="text-xs text-slate-500">in period</span>}>
              {!data.charts.leadsBySource.length ? <p className="p-4 text-sm text-slate-500">No leads in this period.</p> : (
                <ul className="space-y-3 p-4">
                  {data.charts.leadsBySource.map((s) => {
                    const max = Math.max(...data.charts.leadsBySource.map((x) => x.leads));
                    return (
                      <li key={s.key}>
                        <button className="w-full text-left" onClick={() => nav(`/leads?source=${s.key}`)}>
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="font-medium">{s.name}</span>
                            <span className="tabular-nums"><b>{s.leads}</b><span className="ml-2 text-xs text-slate-500">{s.today} today · {s.converted} converted</span></span>
                          </div>
                          <div className="mt-1 h-2 rounded-full bg-slate-100"><div className={`h-2 rounded-full ${s.key === 'website' ? 'bg-emerald-500' : 'bg-indigo-500'}`} style={{ width: `${(s.leads / max) * 100}%` }} /></div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title={<span className="flex items-center gap-1.5"><Globe className="h-4 w-4 text-emerald-600" />Latest website leads</span>} className="xl:col-span-2"
              actions={<button className="text-xs text-indigo-700 hover:underline" onClick={() => nav('/leads?source=website')}>View all</button>}>
              {websiteLeads.isLoading ? <Spinner /> : !websiteLeads.data?.items.length ? (
                <p className="p-4 text-sm text-slate-500">No website leads yet. They appear here as soon as they reach the website Google Sheet or the lead webhook.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {websiteLeads.data.items.map((l) => (
                    <li key={l.id}>
                      <button onClick={() => nav(`/leads/${l.id}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50">
                        <Avatar name={l.fullName} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{l.fullName}</span>
                          <span className="block truncate text-xs text-slate-500">{[fmtPhone(l.phoneE164), l.email, l.city].filter((x) => x && x !== '—').join(' · ')}</span>
                        </span>
                        <span className="hidden text-xs text-slate-500 sm:block">{l.assignedUser?.fullName ?? <span className="text-amber-600">Unassigned</span>}</span>
                        <Badge className={LEAD_STATUS[l.status]?.color}>{LEAD_STATUS[l.status]?.label ?? l.status}</Badge>
                        <span className="w-20 shrink-0 text-right text-xs text-slate-400">{ago(l.createdAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <ActivityFeed userId={userId} teamId={teamId} title={data.scope === 'all' ? 'Recent activity across the team' : data.scope === 'team' ? "Your team's recent activity" : 'Your recent activity'} />

          <div className="grid gap-5 xl:grid-cols-3">
            <Card title="Leads & calls per day" className="xl:col-span-2">
              <div className="h-72 p-3">
                <ResponsiveContainer>
                  <AreaChart data={data.charts.daily}>
                    <defs>
                      <linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff7a00" stopOpacity={0.3} /><stop offset="100%" stopColor="#ff7a00" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eaeaea" />
                    <XAxis dataKey="date" tickFormatter={(d) => format(new Date(d), 'd MMM')} tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
                    <Tooltip labelFormatter={(d) => format(new Date(String(d)), 'd MMM yyyy')} />
                    <Legend />
                    <Area type="monotone" dataKey="leads" name="New leads" stroke="#ff7a00" fill="url(#gl)" strokeWidth={2} />
                    <Area type="monotone" dataKey="calls" name="Calls" stroke="#0ea5e9" fill="transparent" strokeWidth={2} />
                    <Area type="monotone" dataKey="connected" name="Connected" stroke="#10b981" fill="transparent" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Lead status (period cohort)">
              <div className="h-72 p-3">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={data.charts.leadsByStatus} dataKey="count" nameKey="status" innerRadius={55} outerRadius={90} paddingAngle={2} isAnimationActive={false}>
                      {data.charts.leadsByStatus.map((s) => <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? '#94a3b8'} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [v, LEAD_STATUS[n as string]?.label ?? n]} />
                    <Legend formatter={(v) => LEAD_STATUS[v]?.label ?? v} wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Campaign performance">
              <div className="h-72 p-3">
                <ResponsiveContainer>
                  <BarChart data={data.charts.campaigns} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eaeaea" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="campaign" width={150} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="leads" name="Leads" fill="#ff7a00" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="converted" name="Converted" fill="#16a34a" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="Call outcomes">
              <div className="h-72 p-3">
                <ResponsiveContainer>
                  <BarChart data={data.charts.callOutcomes.map((o) => ({ ...o, label: CALL_OUTCOMES[o.outcome] ?? 'Not recorded' }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eaeaea" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={30} />
                    <Tooltip />
                    <Bar dataKey="count" name="Calls" radius={[4, 4, 0, 0]}>
                      {data.charts.callOutcomes.map((_, i) => <Cell key={i} fill={OUTCOME_COLORS[i % OUTCOME_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          {isManager && (
            <Card title="Employee performance" actions={<span className="text-xs text-slate-500">Compare with lead volume in mind</span>}>
              <Table>
                <thead>
                  <tr>
                    <Th>Employee</Th><Th className="text-right">Assigned</Th><Th className="text-right">Open leads</Th><Th className="text-right">Calls</Th>
                    <Th className="text-right">Connected</Th><Th className="text-right">Talk time</Th><Th className="text-right">Follow-ups done</Th>
                    <Th className="text-right">Missed</Th><Th className="text-right">Converted</Th><Th className="text-right">Tasks done</Th><Th className="text-right">Overdue tasks</Th>
                  </tr>
                </thead>
                <tbody>
                  {emps.data?.map((e) => (
                    <tr key={e.userId} className="hover:bg-slate-50">
                      <Td><p className="font-medium">{e.name}</p><p className="text-xs text-slate-500">{e.team ?? 'No team'}</p></Td>
                      <Td className="text-right tabular-nums">{e.leadsAssigned}</Td>
                      <Td className="text-right tabular-nums">{e.openLeads}</Td>
                      <Td className="text-right tabular-nums">{e.callsMade}</Td>
                      <Td className="text-right tabular-nums">{e.connectedCalls}{e.callsMade ? <span className="ml-1 text-xs text-slate-400">({Math.round((e.connectedCalls / e.callsMade) * 100)}%)</span> : null}</Td>
                      <Td className="text-right tabular-nums">{fmtDuration(e.talkTimeSeconds)}</Td>
                      <Td className="text-right tabular-nums">{e.followUpsCompleted}</Td>
                      <Td className={`text-right tabular-nums ${e.missedFollowUps ? 'font-semibold text-rose-600' : ''}`}>{e.missedFollowUps}</Td>
                      <Td className="text-right tabular-nums">{e.converted}</Td>
                      <Td className="text-right tabular-nums">{e.tasksCompleted}</Td>
                      <Td className={`text-right tabular-nums ${e.overdueTasks ? 'font-semibold text-rose-600' : ''}`}>{e.overdueTasks}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
