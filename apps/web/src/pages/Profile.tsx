import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader } from '../components/ui';

export default function Profile() {
  const { me, refresh } = useAuth();
  const [phone, setPhone] = useState(me?.phone ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const savePhone = useMutation({
    mutationFn: () => api.patch('/auth/me', { phone: phone || null }),
    onSuccess: () => { toast.success('Profile updated'); refresh(); },
  });
  const changePw = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }),
    onSuccess: () => { toast.success('Password changed'); setPw({ currentPassword: '', newPassword: '', confirm: '' }); },
  });
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="My profile" />
      <Card title="Account">
        <div className="space-y-4 p-5">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt><dd className="col-span-2 font-medium">{me?.fullName}</dd>
            <dt className="text-slate-500">Email</dt><dd className="col-span-2">{me?.email}</dd>
            <dt className="text-slate-500">Team</dt><dd className="col-span-2">{me?.team?.name ?? '—'}</dd>
            <dt className="text-slate-500">Roles</dt><dd className="col-span-2 flex gap-1">{me?.roles.map((r) => <Badge key={r} className="bg-indigo-50 text-indigo-700">{r.replace('_', ' ')}</Badge>)}</dd>
          </dl>
          <Field label="My phone number" hint="Click-to-call rings this number first, then connects you to the customer.">
            <div className="flex gap-2">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
              <Button loading={savePhone.isPending} onClick={() => savePhone.mutate()}>Save</Button>
            </div>
          </Field>
          <ErrorBox error={savePhone.error} />
        </div>
      </Card>
      <Card title="Change password">
        <div className="space-y-3 p-5">
          <Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Field label="Confirm new password"><Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          {pw.confirm && pw.confirm !== pw.newPassword && <p className="text-sm text-rose-400">Passwords don't match</p>}
          <ErrorBox error={changePw.error} />
          <Button loading={changePw.isPending} disabled={pw.newPassword.length < 8 || pw.newPassword !== pw.confirm} onClick={() => changePw.mutate()}>Change password</Button>
        </div>
      </Card>
    </div>
  );
}
