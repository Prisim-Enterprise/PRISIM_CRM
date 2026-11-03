import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import clsx from 'clsx';
import { ArrowLeft, EyeOff, FileText, Lock, Paperclip } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useDirectory } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { FEEDBACK_STATUS, PRIORITY, ago, fmtBytes, fmtDateTime } from '../lib/format';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Select, Spinner, Textarea } from '../components/ui';

interface Detail {
  id: string; kind: string; category: string; subject: string; description: string; status: string; priority: string; isAnonymous: boolean;
  createdAt: string; resolvedAt: string | null; submittedBy: { id: string; fullName: string } | null; assignedAdmin: { id: string; fullName: string } | null;
  responses: { id: string; body: string; isInternal: boolean; fromSubmitter: boolean; statusChange: string | null; createdAt: string; author: { id: string; fullName: string } | null }[];
  attachments: { id: string; fileName: string; sizeBytes: number }[];
  viewer: { isAdmin: boolean; isOwner: boolean; canManage: boolean };
}

export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const dir = useDirectory();
  const { data: f, isLoading, error } = useQuery({ queryKey: ['feedback', id], queryFn: () => api.get<Detail>(`/feedback/${id}`) });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['feedback', id] }); qc.invalidateQueries({ queryKey: ['fb-inbox'] }); qc.invalidateQueries({ queryKey: ['fb-mine'] }); };
  const reply = useMutation({
    mutationFn: () => api.post(`/feedback/${id}/responses`, { body, ...(f?.viewer.canManage && !f.viewer.isOwner ? { isInternal: internal, status: newStatus || undefined } : {}) }),
    onSuccess: () => { setBody(''); setNewStatus(''); setInternal(false); refresh(); toast.success('Reply sent'); },
  });
  const update = async (data: object) => {
    try { await api.patch(`/admin/feedback/${id}`, data); refresh(); toast.success('Updated'); } catch (e) { toast.error(errMsg(e)); }
  };

  if (isLoading) return <Spinner />;
  if (error || !f) return <ErrorBox error={error ?? 'Not found'} />;
  const manage = f.viewer.canManage && !f.viewer.isOwner;
  const closed = ['RESOLVED', 'CLOSED'].includes(f.status);
  const submitterName = f.isAnonymous ? (f.viewer.isOwner ? 'You (anonymous)' : 'Anonymous employee') : f.submittedBy?.fullName;

  return (
    <div className="max-w-5xl">
      <Link to={`/feedback?tab=${f.viewer.isOwner ? 'mine' : 'inbox'}`} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" />Feedback & Queries</Link>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="p-5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge className={f.kind === 'QUERY' ? 'bg-sky-50 text-sky-700' : 'bg-teal-50 text-teal-700'}>{f.kind === 'QUERY' ? 'Query' : 'Feedback'}</Badge>
                <Badge className={FEEDBACK_STATUS[f.status].color}>{FEEDBACK_STATUS[f.status].label}</Badge>
                <span className="text-xs text-slate-500">{f.category}</span>
              </div>
              <h1 className="text-lg font-semibold">{f.subject}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                {f.isAnonymous && <EyeOff className="h-3.5 w-3.5" />}{submitterName} · {fmtDateTime(f.createdAt)}
              </p>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{f.description}</p>
              {f.attachments.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {f.attachments.map((a) => (
                    <button key={a.id} onClick={async () => { try { window.open(await api.blobUrl(`/attachments/${a.id}`), '_blank'); } catch (e) { toast.error(errMsg(e)); } }}
                      className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs hover:bg-slate-50">
                      <FileText className="h-3.5 w-3.5 text-slate-400" />{a.fileName} <span className="text-slate-400">{fmtBytes(a.sizeBytes)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <div className="space-y-3">
            {f.responses.map((r) => {
              const fromSubmitter = r.fromSubmitter;
              const name = fromSubmitter ? submitterName : r.author?.fullName ?? 'Admin';
              if (r.statusChange && !r.body.trim().length) return null;
              return (
                <div key={r.id} className={clsx('flex gap-3', fromSubmitter && 'flex-row-reverse')}>
                  <Avatar name={fromSubmitter && f.isAnonymous ? '?' : name} size="sm" />
                  <div className={clsx('max-w-[85%] rounded-xl px-4 py-2.5', r.isInternal ? 'border border-dashed border-amber-300 bg-amber-50' : fromSubmitter ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-surface')}>
                    <p className={clsx('text-xs', fromSubmitter ? 'text-indigo-200' : 'text-slate-500')}>
                      <b className={fromSubmitter ? 'text-white' : 'text-slate-700'}>{name}</b> · {ago(r.createdAt)}
                      {r.isInternal && <span className="ml-1 inline-flex items-center gap-0.5 text-amber-700"><Lock className="h-3 w-3" />internal note</span>}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm">{r.body}</p>
                    {r.statusChange && <p className={clsx('mt-1 text-xs', fromSubmitter ? 'text-indigo-200' : 'text-slate-500')}>Status → {FEEDBACK_STATUS[r.statusChange]?.label}</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {(!closed || manage) && (
            <Card>
              <div className="space-y-3 p-4">
                <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={manage ? 'Reply to the employee…' : 'Add more details or reply…'} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    {manage && (
                      <>
                        <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /><Lock className="h-3.5 w-3.5" />Internal note</label>
                        <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="w-48">
                          <option value="">Keep status</option>
                          {Object.entries(FEEDBACK_STATUS).filter(([k]) => k !== f.status).map(([k, v]) => <option key={k} value={k}>Set: {v.label}</option>)}
                        </Select>
                      </>
                    )}
                    {f.viewer.isOwner && (
                      <>
                        <input ref={fileRef} type="file" hidden onChange={async (e) => {
                          const file = e.target.files?.[0]; if (!file) return;
                          try { await api.upload(`/feedback/${id}/attachments`, file); refresh(); toast.success('Attached'); } catch (er) { toast.error(errMsg(er)); }
                        }} />
                        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" />Attach</Button>
                      </>
                    )}
                  </div>
                  <Button loading={reply.isPending} disabled={!body.trim()} onClick={() => reply.mutate()}>Send</Button>
                </div>
                <ErrorBox error={reply.error} />
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Details">
            <div className="space-y-3 p-4 text-sm">
              {manage ? (
                <>
                  <Field label="Status">
                    <Select value={f.status} onChange={(e) => update({ status: e.target.value })}>
                      {Object.entries(FEEDBACK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Owner">
                    <Select value={f.assignedAdmin?.id ?? ''} onChange={(e) => update({ assignedAdminId: e.target.value || null })}>
                      <option value="">Unassigned</option>
                      {dir.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
                    </Select>
                  </Field>
                  <Field label="Priority">
                    <Select value={f.priority} onChange={(e) => update({ priority: e.target.value })}>
                      {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                  </Field>
                </>
              ) : (
                <dl className="grid grid-cols-2 gap-y-2">
                  <dt className="text-slate-500">Status</dt><dd><Badge className={FEEDBACK_STATUS[f.status].color}>{FEEDBACK_STATUS[f.status].label}</Badge></dd>
                  <dt className="text-slate-500">Handled by</dt><dd>{f.assignedAdmin?.fullName ?? 'Not yet assigned'}</dd>
                  <dt className="text-slate-500">Priority</dt><dd>{PRIORITY[f.priority].label}</dd>
                </dl>
              )}
              {f.resolvedAt && <p className="text-xs text-slate-500">Resolved {fmtDateTime(f.resolvedAt)}</p>}
            </div>
          </Card>
          {f.isAnonymous && can('feedback.view.all') && !f.viewer.isOwner && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="flex items-center gap-1 font-semibold"><EyeOff className="h-3.5 w-3.5" />Anonymous submission</p>
              <p className="mt-1">The system does not store who sent this, so it can't be revealed. Replies reach the submitter in their "My submissions" list.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
