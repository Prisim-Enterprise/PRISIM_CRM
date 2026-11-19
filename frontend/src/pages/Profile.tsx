import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader } from '../components/ui';

export default function Profile() {
  const { me, refresh } = useAuth();
  const [phone, setPhone] = useState(me?.phone ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const changePassword = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => { toast.success('Password changed'); setPassword(''); setConfirm(''); },
  });
  const savePhone = useMutation({
    mutationFn: () => api.patch('/auth/me', { phone: phone || null }),
    onSuccess: () => { toast.success('Profile updated'); refresh(); },
  });
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="My profile" />
      <Card title="Account">
        <div className="space-y-4 p-5">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt><dd className="col-span-2 font-medium">{me?.fullName}</dd>
            <dt className="text-slate-500">Email</dt><dd className="col-span-2">{me?.email}</dd>
            <dt className="text-slate-500">{(me?.teams?.length ?? 0) > 1 ? 'Teams' : 'Team'}</dt><dd className="col-span-2">{me?.teams?.length ? me.teams.map((t) => t.name).join(', ') : '—'}</dd>
            <dt className="text-slate-500">Roles</dt><dd className="col-span-2 flex gap-1">{me?.roles.map((r) => <Badge key={r} className="bg-indigo-50 text-indigo-700">{r.replace('_', ' ')}</Badge>)}</dd>
          </dl>
          <Field label="My phone number">
            <div className="flex gap-2">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
              <Button loading={savePhone.isPending} onClick={() => savePhone.mutate()}>Save</Button>
            </div>
          </Field>
          <ErrorBox error={savePhone.error} />
        </div>
      </Card>
      <Card title="Change password">
        <div className="space-y-4 p-5">
          <Field label="New password" hint="At least 8 characters."><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Confirm new password"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          {confirm && confirm !== password && <p className="text-sm text-rose-600">Passwords don't match</p>}
          <ErrorBox error={changePassword.error} />
          <Button loading={changePassword.isPending} disabled={password.length < 8 || password !== confirm} onClick={() => changePassword.mutate()}>Change password</Button>
        </div>
      </Card>
    </div>
  );
}
