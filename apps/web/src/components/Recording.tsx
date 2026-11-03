import { useEffect, useRef, useState } from 'react';
import { Play, Upload, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';

/** Loads a protected recording on demand and plays it inline. */
export function RecordingPlayer({ callId, canPlay }: { callId: string; canPlay: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!canPlay) return <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock className="h-3 w-3" />Recording (restricted)</span>;
  if (url) return <audio src={url} controls autoPlay className="h-8 w-full max-w-xs" />;
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { setUrl(await api.blobUrl(`/calls/${callId}/recording`)); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
      }}
      className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
    >
      <Play className="h-3 w-3" />{busy ? 'Loading…' : 'Play recording'}
    </button>
  );
}

export function UploadRecording({ callId }: { callId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  return (
    <>
      <input ref={ref} type="file" accept="audio/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const t = toast.loading('Uploading recording…');
        try {
          await api.upload(`/calls/${callId}/recording`, f);
          toast.success('Recording attached', { id: t });
          qc.invalidateQueries({ queryKey: ['timeline'] });
          qc.invalidateQueries({ queryKey: ['calls'] });
        } catch (err) { toast.error(errMsg(err), { id: t }); }
      }} />
      <button onClick={() => ref.current?.click()} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600">
        <Upload className="h-3 w-3" />Attach recording
      </button>
    </>
  );
}
