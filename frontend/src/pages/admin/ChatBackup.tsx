import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { format, startOfWeek } from 'date-fns';
import { Archive, Download, Mic, Search, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '../../components/ui';

interface Conversation { key: string; label: string; people: { id: string; name: string }[]; count: number; first: string; last: string }
interface ArchivedMessage {
  id: string; senderId: string; senderName: string; recipientId: string | null; recipientName: string | null;
  kind: 'TEXT' | 'VOICE'; body: string | null; hasAudio: boolean; audioType: string | null; durationSec: number | null; createdAt: string; unsentAt: string | null;
}
interface MessagePage { items: ArchivedMessage[]; total: number; page: number; pages: number }
interface Hit extends Omit<ArchivedMessage, 'hasAudio'> { conversation: string }

export default function ChatBackup() {
  const { can } = useAuth();
  if (!can('chat.backup.view')) return <Navigate to="/" replace />;
  return <ChatBackupPage />;
}

function ChatBackupPage() {
  const [convo, setConvo] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [everywhere, setEverywhere] = useState('');
  const list = useQuery({ queryKey: ['chat-backup', 'conversations'], queryFn: () => api.get<Conversation[]>('/chat-backup/conversations') });
  const hits = useQuery({
    queryKey: ['chat-backup', 'search', everywhere],
    queryFn: () => api.get<Hit[]>('/chat-backup/search', { search: everywhere }),
    enabled: everywhere.trim().length >= 2,
  });
  const shown = (list.data ?? []).filter((c) => !filter.trim() || c.label.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = list.data?.find((c) => c.key === convo) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader title="Chat backup" subtitle="Every Team chat message, kept after the weekly reset. Only the Super Admin can see this page, and every view is recorded in the audit log." />
      <Card>
        <form className="flex flex-wrap items-center gap-2 p-3" onSubmit={(e) => { e.preventDefault(); setEverywhere(String(new FormData(e.currentTarget).get('q') ?? '')); }}>
          <Search className="h-4 w-4 text-slate-400" />
          <Input name="q" placeholder="Search all conversations…" className="w-72" aria-label="Search all conversations" />
          <Button type="submit" variant="secondary" size="sm">Search</Button>
          {everywhere && <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setEverywhere('')}>Clear</button>}
        </form>
        {everywhere && (
          <div className="max-h-72 overflow-y-auto border-t border-slate-100">
            {hits.isLoading ? <Spinner /> : hits.error ? <div className="p-3"><ErrorBox error={hits.error} /></div> : !hits.data?.length ? <p className="p-4 text-sm text-slate-500">No messages contain “{everywhere}”.</p> : (
              <ul className="divide-y divide-slate-50">
                {hits.data.map((h) => (
                  <li key={h.id}>
                    <button className="w-full px-4 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { setConvo(h.conversation); setEverywhere(''); }}>
                      <span className="font-medium text-slate-900">{h.senderName}</span> <span className="text-slate-400">→ {h.recipientName ?? 'Everyone'} · {format(new Date(h.createdAt), 'd MMM yyyy, h:mm a')}</span>
                      <p className="truncate text-slate-600">{h.body}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <Card title={`Conversations${list.data ? ` (${list.data.length})` : ''}`}>
          <div className="p-3"><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name…" aria-label="Filter conversations" /></div>
          {list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : !shown.length ? (
            <Empty title={filter ? 'No conversations match' : 'Nothing backed up yet'} icon={<Archive className="h-9 w-9" />} />
          ) : (
            <ul className="scroll-thin max-h-[65vh] overflow-y-auto">
              {shown.map((c) => (
                <li key={c.key}>
                  <button onClick={() => setConvo(c.key)} className={clsx('flex w-full items-start gap-2 border-t border-slate-50 px-4 py-2.5 text-left hover:bg-slate-50', convo === c.key && 'bg-indigo-50')}>
                    {c.key === 'everyone' ? <Users className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" /> : <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{c.label}</span>
                      <span className="block text-xs text-slate-500">{c.count} message{c.count === 1 ? '' : 's'} · last {format(new Date(c.last), 'd MMM yyyy')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current ? <Thread key={current.key} c={current} /> : (
          <Card><Empty title="Pick a conversation" icon={<Archive className="h-9 w-9" />}>Messages are grouped by week, newest first.</Empty></Card>
        )}
      </div>
    </div>
  );
}

function Thread({ c }: { c: Conversation }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = { conversation: c.key, ...(from ? { from: `${from}T00:00:00+05:30` } : {}), ...(to ? { to: `${to}T23:59:59+05:30` } : {}), ...(search.trim() ? { search: search.trim() } : {}) };
  const q = useQuery({ queryKey: ['chat-backup', 'messages', query, page], queryFn: () => api.get<MessagePage>('/chat-backup/messages', { ...query, page }) });

  // Newest week first; inside a week, oldest to newest like a chat.
  const weeks = useMemo(() => {
    const groups = new Map<string, ArchivedMessage[]>();
    for (const m of q.data?.items ?? []) {
      const k = format(startOfWeek(new Date(m.createdAt), { weekStartsOn: 1 }), 'yyyy-MM-dd');
      groups.set(k, [...(groups.get(k) ?? []), m]);
    }
    return [...groups.entries()].map(([k, items]) => ({ week: k, items: [...items].reverse() }));
  }, [q.data]);

  const exportCsv = async () => {
    try { await api.download('/chat-backup/export', query, 'chat-backup.csv'); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <Card title={c.label} actions={<Button size="sm" variant="secondary" onClick={exportCsv}><Download className="h-3.5 w-3.5" />Export CSV</Button>}>
      <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 p-3 text-sm">
        <label className="text-xs text-slate-500">From<Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" /></label>
        <label className="text-xs text-slate-500">To<Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" /></label>
        <label className="text-xs text-slate-500">Search this conversation<Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-56" /></label>
        {q.data && <span className="ml-auto text-xs text-slate-500">{q.data.total} message{q.data.total === 1 ? '' : 's'}</span>}
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <div className="p-4"><ErrorBox error={q.error} /></div> : !weeks.length ? (
        <p className="p-6 text-sm text-slate-500">No messages{search || from || to ? ' match these filters' : ''}.</p>
      ) : (
        <div className="scroll-thin max-h-[65vh] space-y-5 overflow-y-auto p-4">
          {weeks.map((w) => (
            <section key={w.week}>
              <h3 className="sticky top-0 z-10 mb-2 bg-surface py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Week of {format(new Date(`${w.week}T12:00:00`), 'd MMM yyyy')}</h3>
              <ul className="space-y-2">
                {w.items.map((m) => (
                  <li key={m.id} className="rounded-xl border border-slate-100 px-3 py-2">
                    <p className="text-xs text-slate-500">
                      <span className="font-medium text-slate-800">{m.senderName}</span>{c.key === 'everyone' ? '' : ` → ${m.recipientName ?? ''}`} · {format(new Date(m.createdAt), 'EEE d MMM, h:mm a')}
                      {m.unsentAt && <Badge className="ml-2 bg-amber-100 text-amber-800" >Unsent by sender</Badge>}
                    </p>
                    {m.kind === 'VOICE' ? <Voice m={m} /> : <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-800">{m.body}</p>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {q.data && q.data.pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm">
          <Button size="sm" variant="secondary" disabled={page >= q.data.pages} onClick={() => setPage(page + 1)}>Older</Button>
          <span className="text-xs text-slate-500">Page {page} of {q.data.pages}</span>
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
        </div>
      )}
    </Card>
  );
}

function Voice({ m }: { m: ArchivedMessage }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (!m.hasAudio) return <p className="mt-0.5 text-sm italic text-slate-400">Voice message (file not available)</p>;
  if (src) return <audio controls autoPlay src={src} className="mt-1 h-9 w-full max-w-sm" />;
  return (
    <button className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-200" disabled={loading}
      onClick={async () => { setLoading(true); try { setSrc(await api.blobUrl(`/chat-backup/${m.id}/audio`)); } catch (e) { toast.error(errMsg(e)); } finally { setLoading(false); } }}>
      <Mic className="h-3.5 w-3.5" />{loading ? 'Loading…' : `Play voice message${m.durationSec ? ` (${m.durationSec}s)` : ''}`}
    </button>
  );
}
