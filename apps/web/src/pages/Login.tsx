import { FormEvent, useState } from 'react';
import { useAuth } from '../lib/auth';
import { errMsg } from '../lib/api';
import { Button, ErrorBox, Field, Input } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,_var(--color-indigo-50),_#000_65%)] p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-white">
          <img src="/prisim-logo.png" alt="Prisim" className="mb-2 h-14 w-auto" />
          <h1 className="text-lg font-semibold tracking-[0.3em] text-indigo-800">CRM</h1>
          <p className="text-sm text-indigo-800">Leads, follow-ups, calls, tasks and feedback in one place</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-surface p-6 shadow-2xl">
          <Field label="Email">
            <Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <ErrorBox error={error} />}
          <Button type="submit" loading={busy} className="w-full">Sign in</Button>
          <p className="text-center text-xs text-slate-500">Forgot your password? Ask your administrator to reset it.</p>
        </form>
      </div>
    </div>
  );
}
