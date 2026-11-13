import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Megaphone, Mic, X } from 'lucide-react';
import { api } from '../lib/api';
import { notifyDesktop } from '../lib/desktopNotify';
import { Avatar } from './ui';

interface Incoming {
  id: string; kind: 'TEXT' | 'VOICE'; preview: string | null; durationSec: number | null; createdAt: string;
  everyone: boolean; sender: { id: string; fullName: string };
}

const POLL_MS = 8000;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Shows a popup, anywhere in the CRM, when a team chat message arrives. Clicking it opens that chat.
 * Messages for the chat already open on screen don't pop up.
 */
export function ChatPopups() {
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const here = useRef('');
  here.current = loc.pathname === '/chat' ? new URLSearchParams(loc.search).get('with') ?? '' : '';

  useEffect(() => {
    let cursor: string | null = null;
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await api.get<{ now: string; items: Incoming[] }>('/messages/incoming', { after: cursor ?? undefined });
        cursor = r.now;
        if (r.items.length) {
          qc.invalidateQueries({ queryKey: ['mic-unread'] });
          qc.invalidateQueries({ queryKey: ['mic-threads'] });
        }
        const show = r.items.filter((m) => (m.everyone ? 'everyone' : m.sender.id) !== here.current);
        for (const m of show.slice(-3)) {
          const chat = m.everyone ? 'everyone' : m.sender.id;
          notifyDesktop(m.everyone ? `${m.sender.fullName} (to everyone)` : m.sender.fullName, {
            body: m.kind === 'VOICE' ? `Voice message (${clock(m.durationSec ?? 0)})` : m.preview ?? '',
            tag: `chat-${m.id}`, onClick: () => nav(`/chat?with=${chat}`),
          });
        }
        if (show.length > 3) {
          toast(`${show.length} new team chat messages`, { id: 'chat-many', action: { label: 'Open', onClick: () => nav('/chat') }, duration: 8000 });
        } else {
          for (const m of show) popup(m);
        }
      } catch { /* Signed out or offline: try again next time. */ }
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    const popup = (m: Incoming) => {
      const chat = m.everyone ? 'everyone' : m.sender.id;
      toast.custom((id) => (
        <div role="button" tabIndex={0} aria-label={`New message from ${m.sender.fullName}. Open chat`}
          onClick={() => { toast.dismiss(id); nav(`/chat?with=${chat}`); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { toast.dismiss(id); nav(`/chat?with=${chat}`); } }}
          className="flex w-[356px] max-w-[calc(100vw-2rem)] cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-surface p-3 shadow-xl transition hover:border-indigo-300">
          <Avatar name={m.sender.fullName} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <span className="truncate">{m.sender.fullName}</span>
              {m.everyone && <span className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"><Megaphone className="h-3 w-3" />Everyone</span>}
            </p>
            <p className="mt-0.5 line-clamp-2 text-sm text-slate-600 [overflow-wrap:anywhere]">
              {m.kind === 'VOICE' ? <span className="inline-flex items-center gap-1"><Mic className="h-3.5 w-3.5" />Voice message ({clock(m.durationSec ?? 0)})</span> : m.preview}
            </p>
            <p className="mt-1 text-xs font-medium text-indigo-700">Click to open the chat</p>
          </div>
          <button onClick={(e) => { e.stopPropagation(); toast.dismiss(id); }} aria-label="Dismiss" className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
        </div>
      ), { id: `chat-${m.id}`, duration: 10000 });
    };
    tick();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [nav, qc]);

  return null;
}
