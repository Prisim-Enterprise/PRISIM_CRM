import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EyeOff, HelpCircle, MessageSquareText, Paperclip, Send } from 'lucide-react';
import clsx from 'clsx';
import { api, Paged } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { FEEDBACK_STATUS, PRIORITY, ago } from '../lib/format';
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Pagination, Select, Spinner, Table, Tabs, Td, Textarea, Th } from '../components/ui';

export interface FeedbackRow {
  id: string; kind: 'FEEDBACK' | 'QUERY'; category: string; subject: string; status: string; priority: string; isAnonymous: boolean;
  createdAt: string; updatedAt: string; submittedBy: { id: string; fullName: string } | null; assignedAdmin: { id: string; fullName: string } | null;
  _count: { responses: number };
}

function SubmitForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['fb-cats'], queryFn: () => api.get<string[]>('/feedback/categories'), staleTime: Infinity });
  const [f, setF] = useState({ kind: 'QUERY', category: '', subject: '', description: '', isAnonymous: false, priority: 'MEDIUM' });
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ id: string }>('/feedback', { ...f, category: f.category || cats.data?.[0] });
      if (file) await api.upload(`/feedback/${created.id}/attachments`, file);
      return created;
    },
    onSuccess: () => {
      toast.success(f.kind === 'QUERY' ? 'Query sent to admins' : 'Thank you. Your feedback was submitted.');
      setF({ ...f, subject: '', description: '' }); setFile(null);
      qc.invalidateQueries({ queryKey: ['fb-mine'] });
      onDone();
    },
  });
  return (
    <Card className="max-w-2xl">
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-2">
          {([['QUERY', 'Ask a question / raise an issue', HelpCircle], ['FEEDBACK', 'Share feedback or a suggestion', MessageSquareText]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setF({ ...f, kind: k })}
              className={clsx('flex items-center gap-2 rounded-lg border p-3 text-left text-sm', f.kind === k ? 'border-indigo-500 bg-indigo-50 text-indigo-900 ring-1 ring-indigo-500' : 'border-slate-200 hover:bg-slate-50')}>
              <Icon className="h-5 w-5 shrink-0" />{label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={f.category || cats.data?.[0] || ''} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {cats.data?.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Urgency">
            <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="Short summary" /></Field>
        <Field label="Details"><Textarea rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Describe the issue, question or idea…" /></Field>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" />{file ? file.name : 'Attach screenshot / document'}</Button>
          {file && <button className="text-xs text-slate-500 hover:underline" onClick={() => setFile(null)}>remove</button>}
        </div>
        <label className={clsx('flex items-start gap-3 rounded-lg border p-3 text-sm', f.isAnonymous ? 'border-amber-300 bg-amber-50' : 'border-slate-200')}>
          <input type="checkbox" className="mt-0.5" checked={f.isAnonymous} onChange={(e) => setF({ ...f, isAnonymous: e.target.checked })} />
          <span>
            <span className="flex items-center gap-1.5 font-medium"><EyeOff className="h-4 w-4" />Submit anonymously</span>
            <span className="text-slate-500">Admins won't see your name. You can still follow replies under "My submissions". Avoid personal details in the text or attachments if you want to stay anonymous.</span>
          </span>
        </label>
        <ErrorBox error={m.error} />
        <div className="flex justify-end">
          <Button loading={m.isPending} disabled={f.subject.trim().length < 3 || f.description.trim().length < 5} onClick={() => m.mutate()}><Send className="h-4 w-4" />Submit</Button>
        </div>
      </div>
    </Card>
  );
}

function FeedbackTable({ items, showSubmitter, onOpen }: { items: FeedbackRow[]; showSubmitter: boolean; onOpen: (id: string) => void }) {
  return (
    <Table>
      <thead><tr><Th>Subject</Th><Th>Type</Th><Th>Status</Th><Th>Priority</Th>{showSubmitter && <Th>From</Th>}{showSubmitter && <Th>Owner</Th>}<Th>Replies</Th><Th>Updated</Th></tr></thead>
      <tbody>
        {items.map((f) => (
          <tr key={f.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(f.id)}>
            <Td><p className="font-medium">{f.subject}</p><p className="text-xs text-slate-500">{f.category}</p></Td>
            <Td><Badge className={f.kind === 'QUERY' ? 'bg-sky-50 text-sky-700' : 'bg-teal-50 text-teal-700'}>{f.kind === 'QUERY' ? 'Query' : 'Feedback'}</Badge></Td>
            <Td><Badge className={FEEDBACK_STATUS[f.status].color}>{FEEDBACK_STATUS[f.status].label}</Badge></Td>
            <Td><Badge className={PRIORITY[f.priority].color}>{PRIORITY[f.priority].label}</Badge></Td>
            {showSubmitter && <Td>{f.isAnonymous ? <span className="flex items-center gap-1 text-slate-500"><EyeOff className="h-3.5 w-3.5" />Anonymous</span> : <span className="flex items-center gap-2"><Avatar name={f.submittedBy?.fullName} size="sm" />{f.submittedBy?.fullName}</span>}</Td>}
            {showSubmitter && <Td>{f.assignedAdmin?.fullName ?? <span className="text-amber-600">Unassigned</span>}</Td>}
            <Td className="tabular-nums">{f._count.responses}</Td>
            <Td className="whitespace-nowrap text-slate-500">{ago(f.updatedAt)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function Feedback() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const isAdmin = can('feedback.view.all');
  const tab = (sp.get('tab') as 'new' | 'mine' | 'inbox') || (isAdmin ? 'inbox' : 'new');
  const setTab = (t: string) => setSp({ tab: t });
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ state: 'open', kind: '', assigned: '', category: '' });
  const dir = useDirectory();

  const mine = useQuery({ queryKey: ['fb-mine', page], queryFn: () => api.get<Paged<FeedbackRow>>('/feedback/mine', { page }), enabled: tab === 'mine' });
  const inbox = useQuery({
    queryKey: ['fb-inbox', f, page],
    queryFn: () => api.get<Paged<FeedbackRow> & { statusCounts: Record<string, number> }>('/admin/feedback', { ...f, page }),
    enabled: tab === 'inbox' && isAdmin,
  });

  return (
    <div>
      <PageHeader title="Feedback & Queries" subtitle="Raise questions or issues and share feedback. Admins respond here and every item is tracked to resolution." />
      <div className="mb-4">
        <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[
          { value: 'new', label: 'Submit new' }, { value: 'mine', label: 'My submissions' },
          ...(isAdmin ? [{ value: 'inbox' as const, label: 'Admin inbox', count: inbox.data ? (inbox.data.statusCounts.SUBMITTED ?? 0) : undefined }] : []),
        ]} />
      </div>
      {tab === 'new' && <SubmitForm onDone={() => setTab('mine')} />}
      {tab === 'mine' && (
        <Card>
          {mine.isLoading ? <Spinner /> : !mine.data?.items.length ? <Empty title="You haven't submitted anything yet" /> : (
            <><FeedbackTable items={mine.data.items} showSubmitter={false} onOpen={(id) => nav(`/feedback/${id}`)} />
              <Pagination page={mine.data.page} pages={mine.data.pages} total={mine.data.total} onPage={setPage} /></>
          )}
        </Card>
      )}
      {tab === 'inbox' && isAdmin && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
            <Select value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} className="w-36"><option value="open">Open</option><option value="closed">Resolved / closed</option><option value="">All</option></Select>
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="w-36"><option value="">All types</option><option value="QUERY">Queries</option><option value="FEEDBACK">Feedback</option></Select>
            <Select value={f.assigned} onChange={(e) => setF({ ...f, assigned: e.target.value })} className="w-44">
              <option value="">Any owner</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
              {dir.data?.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {Object.entries(FEEDBACK_STATUS).map(([k, v]) => <Badge key={k} className={v.color}>{v.label}: {inbox.data?.statusCounts[k] ?? 0}</Badge>)}
            </div>
          </div>
          {inbox.isLoading ? <Spinner /> : !inbox.data?.items.length ? <Empty title="Inbox is clear" /> : (
            <><FeedbackTable items={inbox.data.items} showSubmitter onOpen={(id) => nav(`/feedback/${id}`)} />
              <Pagination page={inbox.data.page} pages={inbox.data.pages} total={inbox.data.total} onPage={setPage} /></>
          )}
        </Card>
      )}
    </div>
  );
}
