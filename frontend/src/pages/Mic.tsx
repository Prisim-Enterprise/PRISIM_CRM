import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns';
import { ArrowLeft, Loader2, Megaphone, Mic as MicIcon, Pause, Play, Send, Square, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDirectory } from '../lib/hooks';
import { Avatar, Card, Empty, ErrorBox, PageHeader, Select, Spinner } from '../components/ui';

interface Person { id: string; fullName: string }
interface Summary { kind: 'TEXT' | 'VOICE'; body: string | null; durationSec: number | null; at: string; mine: boolean; senderName: string }
interface Threads { resetsAt: string; everyone: { last: Summary | null; unread: number }; people: { user: Person; last: Summary; unread: number }[] }
interface Message {
  id: string; kind: 'TEXT' | 'VOICE'; body: string | null; durationSec: number | null; createdAt: string;
  sender: Person; senderId: string; recipientId: string | null; hasAudio: boolean; mine: boolean; seenBy?: number;
}

const MAX_SECONDS = 300;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const preview = (s: Summary) => (s.mine ? 'You: ' : '') + (s.kind === 'VOICE' ? `Voice message (${clock(s.durationSec ?? 0)})` : s.body ?? '');
const when = (d: string) => { const t = new Date(d); return isToday(t) ? format(t, 'h:mm a') : isYesterday(t) ? 'Yesterday' : format(t, 'EEE'); };

export default function Mic() {
  const { me } = useAuth();
  const dir = useDirectory();
  const [params, setParams] = useSearchParams();
  const open = params.get('with'); // "everyone" | user id | null
  const setOpen = (w: string | null) => setParams(w ? { with: w } : {}, { replace: true });
  const threads = useQuery({ queryKey: ['mic-threads'], queryFn: () => api.get<Threads>('/messages/threads'), refetchInterval: 10_000 });

  const others = (dir.data ?? []).filter((u) => u.id !== me?.id);
  const people = threads.data?.people ?? [];
  const withoutChat = others.filter((u) => !people.some((p) => p.user.id === u.id));
  const openName = open === 'everyone' ? 'Everyone' : others.find((u) => u.id === open)?.fullName ?? people.find((p) => p.user.id === open)?.user.fullName;
  const resets = threads.data ? new Date(threads.data.resetsAt) : null;

  return (
    <div className="space-y-4">
      <PageHeader title="Mic" subtitle={<>Chat and voice messages with anyone, or with everyone at once.{resets && <> Everything is cleared every Monday at 12:00 AM · next clear {formatDistanceToNowStrict(resets, { addSuffix: true })}.</>}</>} />
      <Card className="flex h-[calc(100vh-13rem)] min-h-[460px] overflow-hidden">
        {/* Conversations */}
        <aside className={clsx('flex w-full shrink-0 flex-col border-r border-slate-200 md:w-80', open && 'hidden md:flex')}>
          <div className="border-b border-slate-100 p-3">
            <Select value="" onChange={(e) => e.target.value && setOpen(e.target.value)} aria-label="Start a chat">
              <option value="">+ New chat with…</option>
              {withoutChat.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          </div>
          <div className="scroll-thin flex-1 overflow-y-auto">
            {threads.isLoading ? <Spinner /> : threads.error ? <div className="p-3"><ErrorBox error={threads.error} /></div> : <>
              <ThreadRow active={open === 'everyone'} onClick={() => setOpen('everyone')} unread={threads.data?.everyone.unread ?? 0}
                icon={<span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white"><Megaphone className="h-4 w-4" /></span>}
                name="Everyone" sub={threads.data?.everyone.last ? `${threads.data.everyone.last.mine ? '' : threads.data.everyone.last.senderName.split(' ')[0] + ': '}${preview({ ...threads.data.everyone.last, mine: false })}` : 'Send to the whole team at once'}
                at={threads.data?.everyone.last?.at} />
              {people.map((p) => (
                <ThreadRow key={p.user.id} active={open === p.user.id} onClick={() => setOpen(p.user.id)} unread={p.unread}
                  icon={<Avatar name={p.user.fullName} />} name={p.user.fullName} sub={preview(p.last)} at={p.last.at} />
              ))}
              {!people.length && <p className="px-4 py-6 text-center text-sm text-slate-400">No chats yet this week. Pick someone above to start one.</p>}
            </>}
          </div>
        </aside>

        {/* Open conversation */}
        <section className={clsx('min-w-0 flex-1 flex-col', open ? 'flex' : 'hidden md:flex')}>
          {open && openName ? <Conversation key={open} withKey={open} name={openName} onBack={() => setOpen(null)} /> : (
            <div className="flex flex-1 items-center justify-center">
              <Empty title="Pick a chat" icon={<MicIcon className="h-10 w-10" />}>Choose Everyone to talk to the whole team, or a person for a private chat. Tap the mic to send a voice message.</Empty>
            </div>
          )}
        </section>
      </Card>
    </div>
  );
}

function ThreadRow({ active, onClick, icon, name, sub, at, unread }: { active: boolean; onClick: () => void; icon: React.ReactNode; name: string; sub: string; at?: string; unread: number }) {
  return (
    <button onClick={onClick} className={clsx('flex w-full items-center gap-3 border-b border-slate-50 px-3 py-2.5 text-left transition', active ? 'bg-indigo-50' : 'hover:bg-slate-50')}>
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={clsx('truncate text-sm', unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-800')}>{name}</span>
          {at && <span className="shrink-0 text-[11px] text-slate-400">{when(at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={clsx('truncate text-xs', unread ? 'text-slate-700' : 'text-slate-500')}>{sub}</span>
          {unread > 0 && <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
        </div>
      </div>
    </button>
  );
}

function Conversation({ withKey, name, onBack }: { withKey: string; name: string; onBack: () => void }) {
  const qc = useQueryClient();
  const everyone = withKey === 'everyone';
  const msgs = useQuery({ queryKey: ['mic-thread', withKey], queryFn: () => api.get<Message[]>('/messages', { with: withKey }), refetchInterval: 4000 });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const list = msgs.data ?? [];
  const lastId = list[list.length - 1]?.id;

  // New messages: scroll down and mark them read.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
    if (list.some((m) => !m.mine)) {
      api.post('/messages/read', { with: withKey }).then(() => { qc.invalidateQueries({ queryKey: ['mic-threads'] }); qc.invalidateQueries({ queryKey: ['mic-unread'] }); }).catch(() => undefined);
    }
  }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { qc.invalidateQueries({ queryKey: ['mic-thread', withKey] }); qc.invalidateQueries({ queryKey: ['mic-threads'] }); };
  const sendText = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try { await api.post('/messages', { to: withKey, body }); setText(''); refresh(); } catch (err) { toast.error(errMsg(err)); } finally { setSending(false); }
  };
  const unsend = async (m: Message) => {
    if (!confirm(`Delete this message for ${everyone ? 'everyone' : 'both of you'}?`)) return;
    try { await api.del(`/messages/${m.id}`); refresh(); } catch (err) { toast.error(errMsg(err)); }
  };

  const days = useMemo(() => {
    const g: { day: string; items: Message[] }[] = [];
    for (const m of list) {
      const d = new Date(m.createdAt);
      const label = isToday(d) ? 'Today' : isYesterday(d) ? 'Yesterday' : format(d, 'EEEE d MMM');
      if (g[g.length - 1]?.day !== label) g.push({ day: label, items: [] });
      g[g.length - 1].items.push(m);
    }
    return g;
  }, [list]);

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button onClick={onBack} className="rounded p-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back to chats"><ArrowLeft className="h-5 w-5" /></button>
        {everyone ? <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white"><Megaphone className="h-4 w-4" /></span> : <Avatar name={name} />}
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-900">{name}</p>
          <p className="text-xs text-slate-500">{everyone ? 'Everyone in the CRM sees these messages' : 'Only the two of you can see this chat'}</p>
        </div>
      </header>

      <div className="scroll-thin flex-1 space-y-1 overflow-y-auto bg-slate-50/60 px-4 py-3">
        {msgs.isLoading ? <Spinner /> : msgs.error ? <ErrorBox error={msgs.error} /> : !list.length ? (
          <p className="py-10 text-center text-sm text-slate-400">No messages yet. Say hello, or tap the mic to send a voice message.</p>
        ) : days.map((g) => (
          <div key={g.day} className="space-y-1.5">
            <p className="py-2 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">{g.day}</p>
            {g.items.map((m) => (
              <div key={m.id} className={clsx('group flex items-end gap-2', m.mine ? 'justify-end' : 'justify-start')}>
                {!m.mine && everyone && <Avatar name={m.sender.fullName} size="sm" />}
                {m.mine && <button onClick={() => unsend(m)} className="mb-1 rounded p-1 text-slate-300 opacity-0 transition hover:text-rose-600 group-hover:opacity-100 focus:opacity-100" aria-label="Delete message"><Trash2 className="h-3.5 w-3.5" /></button>}
                <div className={clsx('max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm', m.mine ? 'rounded-br-md bg-slate-900 text-white' : 'rounded-bl-md bg-white text-slate-800')}>
                  {!m.mine && everyone && <p className="mb-0.5 text-xs font-semibold text-indigo-700">{m.sender.fullName}</p>}
                  {m.kind === 'VOICE' ? <VoicePlayer id={m.id} duration={m.durationSec ?? 0} dark={m.mine} /> : <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.body}</p>}
                  <p className={clsx('mt-0.5 text-right text-[10px]', m.mine ? 'text-slate-300' : 'text-slate-400')}>
                    {format(new Date(m.createdAt), 'h:mm a')}
                    {m.mine && (everyone ? (m.seenBy ? ` · seen by ${m.seenBy}` : '') : m.seenBy ? ' · Seen' : ' · Sent')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-slate-200 p-3">
        <Recorder to={withKey} onSent={refresh} composer={
          <form onSubmit={sendText} className="flex flex-1 items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={4000}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
              placeholder={everyone ? 'Message everyone…' : `Message ${name.split(' ')[0]}…`} aria-label="Message"
              className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-slate-300 bg-surface px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
            <button type="submit" disabled={!text.trim() || sending} aria-label="Send"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition hover:bg-slate-700 disabled:opacity-40">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        } />
      </footer>
    </>
  );
}

/** Mic button: record, then send or cancel. Shows the composer when not recording. */
function Recorder({ to, onSent, composer }: { to: string; onSent: () => void; composer: React.ReactNode }) {
  const [state, setState] = useState<'idle' | 'recording' | 'sending'>('idle');
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const send = useRef(true);
  const timer = useRef<number | undefined>(undefined);

  const stopTracks = () => rec.current?.stream.getTracks().forEach((t) => t.stop());
  useEffect(() => () => { send.current = false; if (rec.current?.state === 'recording') rec.current.stop(); stopTracks(); window.clearInterval(timer.current); }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast.error('This browser cannot record audio'); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast.error('Microphone access was blocked. Allow the microphone for this site in your browser settings.'); return; }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks.current = []; send.current = true; started.current = Date.now();
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearInterval(timer.current);
      const duration = Math.max(1, Math.min(MAX_SECONDS, Math.round((Date.now() - started.current) / 1000)));
      if (!send.current || !chunks.current.length) { setState('idle'); return; }
      setState('sending');
      const mime = (r.mimeType || type || 'audio/webm').split(';')[0];
      const ext = mime === 'audio/mp4' ? 'm4a' : mime.split('/')[1];
      const file = new File(chunks.current, `voice.${ext}`, { type: mime });
      try { await api.upload(`/messages/voice/${to}/${duration}`, file); onSent(); }
      catch (e) { toast.error(errMsg(e)); }
      finally { setState('idle'); }
    };
    rec.current = r;
    r.start(250);
    setSecs(0); setState('recording');
    timer.current = window.setInterval(() => {
      const s = (Date.now() - started.current) / 1000;
      setSecs(s);
      if (s >= MAX_SECONDS && r.state === 'recording') { toast.info('Voice messages can be up to 5 minutes, so it was sent'); r.stop(); }
    }, 200);
  };
  const finish = (andSend: boolean) => { send.current = andSend; if (rec.current?.state === 'recording') rec.current.stop(); };

  if (state === 'idle') {
    return (
      <div className="flex items-end gap-2">
        <button type="button" onClick={start} aria-label="Record a voice message" title="Record a voice message"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-surface text-slate-600 transition hover:border-indigo-400 hover:text-indigo-700">
          <MicIcon className="h-4 w-4" />
        </button>
        {composer}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-rose-50 px-3 py-2">
      {state === 'recording' ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-600" /> : <Loader2 className="h-4 w-4 animate-spin text-rose-600" />}
      <span className="font-mono text-sm tabular-nums text-rose-800">{clock(secs)}</span>
      <span className="flex-1 text-sm text-rose-800">{state === 'recording' ? 'Recording… up to 5 minutes' : 'Sending…'}</span>
      {state === 'recording' && <>
        <button type="button" onClick={() => finish(false)} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100" aria-label="Cancel recording"><X className="h-4 w-4" />Cancel</button>
        <button type="button" onClick={() => finish(true)} className="flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500" aria-label="Stop and send"><Square className="h-3.5 w-3.5" />Send</button>
      </>}
    </div>
  );
}

/** Loads a voice message on first play (the audio is private), then plays it inline. */
function VoicePlayer({ id, duration, dark }: { id: string; duration: number; dark: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const toggle = async () => {
    if (!url) {
      setBusy(true);
      try { setUrl(await api.blobUrl(`/messages/${id}/audio`)); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
      return; // autoPlay starts it once loaded
    }
    const a = audio.current!;
    if (a.paused) void a.play(); else a.pause();
  };
  const pct = duration ? Math.min(100, (pos / duration) * 100) : 0;
  return (
    <div className="flex w-56 max-w-full items-center gap-2.5 py-0.5">
      <button onClick={toggle} disabled={busy} aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', dark ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-slate-100 text-slate-800 hover:bg-slate-200')}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className={clsx('h-1.5 overflow-hidden rounded-full', dark ? 'bg-white/20' : 'bg-slate-200')}>
          <div className={clsx('h-full rounded-full', dark ? 'bg-white' : 'bg-indigo-600')} style={{ width: `${pct}%` }} />
        </div>
        <p className={clsx('mt-1 text-[11px] tabular-nums', dark ? 'text-slate-300' : 'text-slate-500')}>{playing || pos ? clock(pos) + ' / ' : ''}{clock(duration)}</p>
      </div>
      {url && <audio ref={audio} src={url} autoPlay onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0); }} onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} hidden />}
    </div>
  );
}
