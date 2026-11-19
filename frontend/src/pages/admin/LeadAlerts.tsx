import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { Button, Card, ErrorBox, Field, Input, Select, Spinner } from '../../components/ui';
import { playAlertSound } from '../../lib/alertSound';

interface LeadRules {
  firstFollowUpEnabled: boolean; firstFollowUpMinutes: number; nudgeAfterHours: number; escalateAfterHours: number;
  followUpEscalateHours: number; workStartHour: number; workEndHour: number;
}

const hourLabel = (h: number) => (h === 0 || h === 24 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);

/** How the CRM chases leads: the automatic first follow-up, and who is alerted when a lead sits untouched. */
export function LeadAlertsPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead-rules'], queryFn: () => api.get<LeadRules>('/lead-rules') });
  const [f, setF] = useState<LeadRules | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  if (q.isLoading || !f) return q.error ? <ErrorBox error={q.error} /> : <Spinner />;
  const set = (c: Partial<LeadRules>) => setF({ ...f, ...c });
  const num = (v: string) => (v === '' ? 0 : Number(v));

  const save = async () => {
    if (f.escalateAfterHours < f.nudgeAfterHours) { toast.error('Telling the managers must come after telling the owner'); return; }
    setSaving(true);
    try { const saved = await api.put<LeadRules>('/lead-rules', f); setF(saved); qc.setQueryData(['lead-rules'], saved); toast.success('Lead alerts saved'); }
    catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <Card title="New leads">
        <div className="space-y-3 p-4 text-sm">
          <p className="text-slate-600">
            Every new lead (Google Sheet, website form, webhook or CSV) lands in <b>Leads</b> and alerts the managers with a chime.
            If auto-assign is on, the person it goes to is alerted too.
          </p>
          <label className="flex items-center gap-2 font-medium text-slate-800">
            <input type="checkbox" checked={f.firstFollowUpEnabled} onChange={(e) => set({ firstFollowUpEnabled: e.target.checked })} />
            Give every assigned lead a “First call” follow-up
          </label>
          {f.firstFollowUpEnabled && (
            <Field label="Due this many minutes after the lead is assigned" className="max-w-xs">
              <Input type="number" min={1} max={1440} value={f.firstFollowUpMinutes} onChange={(e) => set({ firstFollowUpMinutes: num(e.target.value) })} />
            </Field>
          )}
        </div>
      </Card>

      <Card title="When a lead isn’t being worked">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field label="Alert the owner after (hours)" hint="With no note, status change or completed follow-up by them.">
            <Input type="number" min={0.25} max={168} step={0.25} value={f.nudgeAfterHours} onChange={(e) => set({ nudgeAfterHours: num(e.target.value) })} />
          </Field>
          <Field label="Then tell their team leader and managers after (hours)">
            <Input type="number" min={0.25} max={720} step={0.25} value={f.escalateAfterHours} onChange={(e) => set({ escalateAfterHours: num(e.target.value) })} />
          </Field>
          <Field label="Tell them when a follow-up is overdue by (hours)">
            <Input type="number" min={0.25} max={168} step={0.25} value={f.followUpEscalateHours} onChange={(e) => set({ followUpEscalateHours: num(e.target.value) })} />
          </Field>
          <Field label="Send these alerts from">
            <Select value={f.workStartHour} onChange={(e) => set({ workStartHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </Field>
          <Field label="until" hint="Times are India time. Nothing goes out at night; it waits for the morning.">
            <Select value={f.workEndHour} onChange={(e) => set({ workEndHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </Field>
        </div>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Each alert is sent once per quiet spell. Any work on the lead resets the clock. A task past its due date also alerts the person who created it.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button loading={saving} onClick={save}>Save lead alerts</Button>
        <Button variant="secondary" onClick={() => playAlertSound(true)}>Play the alert sound</Button>
        <span className="text-xs text-slate-500">Each person can turn the sound off for themselves in the bell menu.</span>
      </div>
    </div>
  );
}
