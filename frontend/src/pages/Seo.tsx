import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format, isToday, isYesterday, subDays } from 'date-fns';
import { ExternalLink, Globe, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { ago } from '../lib/format';
import {
  Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, Tabs, Textarea,
} from '../components/ui';

type Status = 'ACTIVE' | 'PAUSED' | 'ENDED';
interface Person { id: string; fullName: string }
interface Account {
  id: string; website: string | null; scope: string | null; status: Status;
  client: { id: string; name: string; company: string | null };
  assignees: { userId: string; user: Person }[];
  _count: { updates: number };
  lastUpdate: { at: string; by: Person; workDate: string } | null;
  updatesToday: number;
  permissions: { canManage: boolean; canPost: boolean };
}
interface Update {
  id: string; workDate: string; body: string; link: string | null; createdAt: string; updatedAt: string;
  author: Person; account: { id: string; website: string | null; client: { id: string; name: string } };
  permissions: { canEdit: boolean; canDelete: boolean };
}

const STATUS: Record<Status, { label: string; color: string }> = {
  ACTIVE: { label: 'Active', color: 'bg-green-100 text-green-800' },
  PAUSED: { label: 'Paused', color: 'bg-amber-100 text-amber-800' },
  ENDED: { label: 'Ended', color: 'bg-slate-200 text-slate-600' },
};
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
/** Date-only values come back as midnight UTC; read them as that calendar day. */
const dateOnly = (s: string) => new Date(s.slice(0, 10) + 'T00:00');
const dayHeading = (d: Date) => (isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEEE d MMMM'));
const label = (a: { client: { name: string }; website: string | null }) => a.client.name + (a.website ? ` · ${a.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}` : '');
const href = (url: string) => (/^https?:\/\//.test(url) ? url : `https://${url}`);
const invalidate = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ['seo-accounts', 'seo-updates']) qc.invalidateQueries({ queryKey: [k] }); };

export default function Seo() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'clients' | 'updates') || 'clients';
  const manage = can('seo.manage');
  const seesAll = manage || can('seo.view.all');
  const accounts = useQuery({ queryKey: ['seo-accounts'], queryFn: () => api.get<Account[]>('/seo/accounts') });
  const [editing, setEditing] = useState<Partial<Account> | null>(null);
  const [posting, setPosting] = useState<{ accountId?: string; update?: Update } | null>(null);
  const [accountFilter, setAccountFilter] = useState('');

  // A notification links to /seo?account=<id>: show that client's updates.
  useEffect(() => {
    const a = params.get('account');
    if (a) { setAccountFilter(a); setParams({ tab: 'updates' }, { replace: true }); }
  }, [params, setParams]);

  const list = accounts.data ?? [];
  const active = list.filter((a) => a.status === 'ACTIVE');
  const postable = list.filter((a) => a.permissions.canPost && a.status !== 'ENDED');
  const setTab = (v: 'clients' | 'updates') => setParams(v === 'clients' ? {} : { tab: v }, { replace: true });
  const showUpdates = (accountId: string) => { setAccountFilter(accountId); setTab('updates'); };

  return (
    <div className="space-y-5">
      <PageHeader
        title="SEO"
        subtitle={seesAll ? 'Who handles SEO for which client, and the daily updates they post' : 'The clients you handle SEO for, and your daily updates'}
        actions={<>
          {postable.length > 0 && <Button variant={manage ? 'secondary' : 'primary'} onClick={() => setPosting({ accountId: postable.length === 1 ? postable[0].id : undefined })}><Pencil className="h-4 w-4" />Post today's update</Button>}
          {manage && <Button onClick={() => setEditing({ status: 'ACTIVE' })}><Plus className="h-4 w-4" />Add SEO client</Button>}
        </>}
      />

      {seesAll && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Active SEO clients" value={accounts.data ? active.length : '—'} />
          <StatCard label="Updated today" value={accounts.data ? `${active.filter((a) => a.updatesToday > 0).length} of ${active.length}` : '—'} tone="good" />
          <StatCard label="No update yet today" value={accounts.data ? active.filter((a) => !a.updatesToday).length : '—'} tone={active.some((a) => !a.updatesToday) ? 'warn' : 'default'} />
          <StatCard label="People handling SEO" value={accounts.data ? new Set(active.flatMap((a) => a.assignees.map((x) => x.userId))).size : '—'} />
        </div>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'clients', label: 'Clients', count: list.length }, { value: 'updates', label: 'Daily updates' }]} />

      {tab === 'clients' ? (
        accounts.isLoading ? <Spinner /> : accounts.error ? <ErrorBox error={accounts.error} /> : !list.length ? (
          <Card><Empty title={manage ? 'No SEO clients yet' : 'No SEO clients assigned to you'} icon={<Globe className="h-8 w-8" />}>
            {manage ? <Button className="mt-3" onClick={() => setEditing({ status: 'ACTIVE' })}><Plus className="h-4 w-4" />Add SEO client</Button> : 'When you are given a client to handle, it shows up here.'}
          </Empty></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((a) => <AccountCard key={a.id} a={a} onEdit={() => setEditing(a)} onPost={() => setPosting({ accountId: a.id })} onUpdates={() => showUpdates(a.id)} />)}
          </div>
        )
      ) : (
        <UpdatesFeed accounts={list} accountId={accountFilter} setAccountId={setAccountFilter} seesAll={seesAll} onEdit={(u) => setPosting({ accountId: u.account.id, update: u })} />
      )}

      {editing && <AccountModal account={editing} onClose={() => setEditing(null)} onSaved={() => invalidate(qc)} />}
      {posting && <UpdateModal accounts={postable} initial={posting} onClose={() => setPosting(null)} onSaved={() => invalidate(qc)} />}
    </div>
  );
}

function AccountCard({ a, onEdit, onPost, onUpdates }: { a: Account; onEdit: () => void; onPost: () => void; onUpdates: () => void }) {
  return (
    <Card className="flex flex-col">
      <div className="flex-1 space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{a.client.name}</p>
            {a.website && <a href={href(a.website)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-xs text-indigo-700 hover:underline"><Globe className="h-3 w-3 shrink-0" />{a.website}</a>}
          </div>
          <Badge className={STATUS[a.status].color}>{STATUS[a.status].label}</Badge>
        </div>
        {a.scope && <p className="line-clamp-2 text-sm text-slate-600">{a.scope}</p>}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Handled by</p>
          {a.assignees.length ? (
            <div className="flex flex-wrap gap-1.5">
              {a.assignees.map((x) => <span key={x.userId} className="flex items-center gap-1.5 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-2.5 text-xs text-slate-700"><Avatar name={x.user.fullName} size="sm" />{x.user.fullName}</span>)}
            </div>
          ) : <p className="text-sm text-amber-700">No one assigned</p>}
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
          {a.status === 'ACTIVE' && (a.updatesToday
            ? <p className="font-medium text-emerald-700">Updated today{a.updatesToday > 1 ? ` · ${a.updatesToday} updates` : ''}</p>
            : <p className="font-medium text-amber-700">No update yet today</p>)}
          <p className="text-slate-500">{a.lastUpdate ? <>Last update by {a.lastUpdate.by.fullName}, {format(new Date(a.lastUpdate.at), 'd MMM, h:mm a')} ({ago(a.lastUpdate.at)})</> : 'No updates posted yet'}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2.5">
        <Button size="sm" variant="ghost" onClick={onUpdates}>See updates ({a._count.updates})</Button>
        <span className="flex-1" />
        {a.permissions.canManage && <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>}
        {a.permissions.canPost && a.status !== 'ENDED' && <Button size="sm" variant="secondary" onClick={onPost}><Pencil className="h-3.5 w-3.5" />Post update</Button>}
      </div>
    </Card>
  );
}

function UpdatesFeed({ accounts, accountId, setAccountId, seesAll, onEdit }: {
  accounts: Account[]; accountId: string; setAccountId: (v: string) => void; seesAll: boolean; onEdit: (u: Update) => void;
}) {
  const qc = useQueryClient();
  const dir = useDirectory();
  const [authorId, setAuthorId] = useState('');
  const [from, setFrom] = useState(ymd(subDays(new Date(), 6)));
  const [to, setTo] = useState(ymd(new Date()));
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['seo-updates', accountId, authorId, from, to],
    queryFn: () => api.get<Update[]>('/seo/updates', { accountId: accountId || undefined, authorId: authorId || undefined, from: from || undefined, to: to || undefined }),
  });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((u) => !s || u.body.toLowerCase().includes(s) || u.account.client.name.toLowerCase().includes(s));
  }, [q.data, search]);
  const groups = useMemo(() => {
    const m = new Map<string, Update[]>();
    for (const u of rows) { const k = u.workDate.slice(0, 10); m.set(k, [...(m.get(k) ?? []), u]); }
    return [...m.entries()];
  }, [rows]);
  const remove = async (u: Update) => {
    if (!confirm('Delete this update?')) return;
    try { await api.del(`/seo/updates/${u.id}`); invalidate(qc); toast.success('Update deleted'); } catch (e) { toast.error(errMsg(e)); }
  };
  // People who handle any of the visible clients, for the person filter.
  const handlers = [...new Map(accounts.flatMap((a) => a.assignees.map((x) => [x.userId, x.user] as const))).values()].sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Client"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-56">
          <option value="">All clients</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
        </Select></Field>
        {seesAll && <Field label="Person"><Select value={authorId} onChange={(e) => setAuthorId(e.target.value)} className="w-44">
          <option value="">Everyone</option>
          {(handlers.length ? handlers : dir.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </Select></Field>}
        <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" /></Field>
        <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" /></Field>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search updates…" className="w-52 pl-9" />
        </div>
      </div>

      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !groups.length ? (
        <Card><Empty title="No updates for these filters">Try a wider date range, or another client or person.</Empty></Card>
      ) : groups.map(([dayKey, list]) => (
        <section key={dayKey}>
          <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-700">{dayHeading(dateOnly(dayKey))} <span className="font-normal text-slate-400">· {list.length} update{list.length === 1 ? '' : 's'}</span></h3>
          <Card>
            <ul className="divide-y divide-slate-100">
              {list.map((u) => {
                const posted = new Date(u.createdAt);
                const late = ymd(posted) !== dayKey; // Written on a later day than the work it describes.
                const edited = new Date(u.updatedAt).getTime() - posted.getTime() > 60_000;
                return (
                  <li key={u.id} className="flex gap-3 px-4 py-3">
                    <Avatar name={u.author.fullName} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-semibold text-slate-900">{u.author.fullName}</span>
                        <span className="text-slate-500">for</span>
                        <span className="font-medium text-slate-800">{label(u.account)}</span>
                        <span className="text-xs text-slate-500" title={format(posted, 'd MMM yyyy, h:mm:ss a')}>
                          {format(posted, 'h:mm a')}{late && ` · posted ${format(posted, 'd MMM')}`}{edited && ` · edited ${format(new Date(u.updatedAt), 'd MMM, h:mm a')}`}
                        </span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{u.body}</p>
                      {u.link && <a href={href(u.link)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-indigo-700 hover:underline"><ExternalLink className="h-3 w-3" />{u.link}</a>}
                    </div>
                    <div className="flex shrink-0 items-start gap-1">
                      {u.permissions.canEdit && <button onClick={() => onEdit(u)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Edit update"><Pencil className="h-4 w-4" /></button>}
                      {u.permissions.canDelete && <button onClick={() => remove(u)} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Delete update"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  );
}

function UpdateModal({ accounts, initial, onClose, onSaved }: {
  accounts: Account[]; initial: { accountId?: string; update?: Update }; onClose: () => void; onSaved: () => void;
}) {
  const editing = initial.update;
  const [accountId, setAccountId] = useState(initial.accountId ?? '');
  const [workDate, setWorkDate] = useState(editing ? editing.workDate.slice(0, 10) : ymd(new Date()));
  const [body, setBody] = useState(editing?.body ?? '');
  const [link, setLink] = useState(editing?.link ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (editing) await api.patch(`/seo/updates/${editing.id}`, { body: body.trim(), link: link || null });
      else await api.post('/seo/updates', { accountId, workDate, body: body.trim(), link: link || null });
      toast.success(editing ? 'Update saved' : 'Update posted'); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={editing ? 'Edit your update' : "Post an SEO update"} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!accountId || body.trim().length < 2} onClick={save}>{editing ? 'Save' : 'Post update'}</Button>
    </>}>
      <Field label="Client">
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!!editing}>
          <option value="">Choose a client…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
          {editing && !accounts.some((a) => a.id === editing.account.id) && <option value={editing.account.id}>{label(editing.account)}</option>}
        </Select>
      </Field>
      <Field label="Work done on" hint={editing ? undefined : 'The time is recorded automatically when you post.'}>
        <Input type="date" value={workDate} max={ymd(new Date())} onChange={(e) => setWorkDate(e.target.value)} disabled={!!editing} />
      </Field>
      <Field label="What did you do?">
        <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} autoFocus
          placeholder={'e.g. Fixed 12 broken links\nPublished blog: 5 interior trends\nKeyword "modular kitchen Bangalore" moved from #14 to #9'} />
      </Field>
      <Field label="Link (optional)"><Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Report, Search Console, published page…" /></Field>
      {editing && <p className="text-xs text-slate-500">Admins can see that the update was edited, and when.</p>}
    </Modal>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: Partial<Account>; onClose: () => void; onSaved: () => void }) {
  const isNew = !account.id;
  const dir = useDirectory();
  const clients = useQuery({ queryKey: ['clients', '', ''], queryFn: () => api.get<{ id: string; name: string }[]>('/clients', {}), staleTime: 60_000 });
  const [clientId, setClientId] = useState(account.client?.id ?? '');
  const [website, setWebsite] = useState(account.website ?? '');
  const [scope, setScope] = useState(account.scope ?? '');
  const [status, setStatus] = useState<Status>(account.status ?? 'ACTIVE');
  const [people, setPeople] = useState<string[]>(account.assignees?.map((x) => x.userId) ?? []);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPeople(people.includes(id) ? people.filter((p) => p !== id) : [...people, id]);
  const save = async () => {
    setBusy(true);
    try {
      const body = { website: website || null, scope: scope || null, status, assigneeIds: people };
      if (isNew) await api.post('/seo/accounts', { clientId, ...body }); else await api.patch(`/seo/accounts/${account.id}`, body);
      toast.success(isNew ? 'SEO client added' : 'Saved'); onSaved(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Remove SEO for ${account.client?.name}? All ${account._count?.updates ?? 0} of its daily updates are deleted too. This cannot be undone.`)) return;
    setBusy(true);
    try { await api.del(`/seo/accounts/${account.id}`); toast.success('Removed'); onSaved(); onClose(); } catch (e) { toast.error(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal open wide onClose={onClose} title={isNew ? 'Add an SEO client' : `SEO for ${account.client?.name}`} footer={<>
      {!isNew && <Button variant="ghost" className="mr-auto text-rose-600 hover:bg-rose-50" onClick={remove} disabled={busy}><Trash2 className="h-4 w-4" />Remove</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!clientId} onClick={save}>{isNew ? 'Add' : 'Save'}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client" hint={isNew && clients.data && !clients.data.length ? 'Add the client on the Clients page first.' : undefined}>
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!isNew}>
            <option value="">Choose a client…</option>
            {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {account.client && !clients.data?.some((c) => c.id === account.client!.id) && <option value={account.client.id}>{account.client.name}</option>}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Website"><Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" /></Field>
      <Field label="What the SEO work covers (optional)"><Textarea rows={2} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="On-page, backlinks, Google Business Profile, monthly report…" /></Field>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Handled by</p>
        <div className="scroll-thin grid max-h-56 gap-1 overflow-y-auto rounded-xl border border-slate-200 p-2 sm:grid-cols-2">
          {dir.data?.map((u) => (
            <label key={u.id} className={clsx('flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm', people.includes(u.id) ? 'bg-indigo-50 text-slate-900' : 'hover:bg-slate-50')}>
              <input type="checkbox" checked={people.includes(u.id)} onChange={() => toggle(u.id)} />
              <Avatar name={u.fullName} size="sm" />{u.fullName}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">{people.length ? `${people.length} selected. They can post daily updates for this client.` : 'Pick who handles this client.'}</p>
      </div>
    </Modal>
  );
}
