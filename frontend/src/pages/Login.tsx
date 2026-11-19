import { FormEvent, ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { Button, Field, Input, Spinner } from '../components/ui';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center glow-page p-4">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-6 flex flex-col items-center">
          <img src="/prisim-logo-dark.png" alt="Prisim" className="mb-2 h-14 w-auto" />
          <h1 className="text-lg font-semibold tracking-[0.3em] text-slate-900">CRM</h1>
          <p className="text-sm text-slate-600">Leads, follow-ups, tasks and feedback in one place</p>
        </div>
        <div className="w-full space-y-4 rounded-2xl bg-surface p-6 shadow-2xl">{children}</div>
      </div>
    </div>
  );
}

const Problem = ({ text }: { text: string | null }) => (text ? <p role="alert" className="text-sm text-rose-600">{text}</p> : null);

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setProblem(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setProblem(error.code === 'invalid_credentials' ? 'Incorrect email or password.' : error.message);
  };

  return (
    <Shell>
      <h2 className="text-center text-lg font-semibold text-slate-900">Sign in</h2>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Email"><Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Problem text={problem} />
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
      <p className="text-center text-sm"><Link to="/forgot-password" className="text-indigo-700 hover:underline">Forgot your password?</Link></p>
    </Shell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setProblem(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/set-password` });
    setBusy(false);
    if (error) setProblem(`${error.message} If this keeps happening, ask your administrator to reset your password.`);
    else setSent(true);
  };

  return (
    <Shell>
      <h2 className="text-center text-lg font-semibold text-slate-900">Reset your password</h2>
      {sent ? (
        <p className="text-center text-sm text-slate-600">If that email has an account, a reset link is on its way. If nothing arrives, ask your administrator to reset your password.</p>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <Field label="Email"><Input type="email" name="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Problem text={problem} />
          <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
      <p className="text-center text-sm"><Link to="/login" className="text-indigo-700 hover:underline">Back to sign in</Link></p>
    </Shell>
  );
}

/** Where invitation and password reset emails land. Supabase signs them in from the link first. */
export function SetPassword() {
  const { signedIn, loading } = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (loading) return <Spinner className="h-full items-center" />;
  if (!signedIn) {
    return (
      <Shell>
        <p className="text-center text-sm text-slate-600">This link is invalid or has expired. Request a new one, or ask your administrator to reset your password.</p>
        <p className="text-center text-sm"><Link to="/forgot-password" className="text-indigo-700 hover:underline">Request a new link</Link></p>
      </Shell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setProblem("Passwords don't match.");
    setBusy(true); setProblem(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) setProblem(error.message);
    else nav('/', { replace: true });
  };

  return (
    <Shell>
      <h2 className="text-center text-lg font-semibold text-slate-900">Choose a password</h2>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="New password" hint="At least 8 characters."><Input type="password" name="new-password" autoComplete="new-password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Confirm password"><Input type="password" name="confirm-password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <Problem text={problem} />
        <Button type="submit" className="w-full" loading={busy}>Save password</Button>
      </form>
    </Shell>
  );
}

/** Signed in, but not allowed into the CRM. */
export function NoAccess() {
  const { denied, logout } = useAuth();
  return (
    <Shell>
      <div className="space-y-4 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-amber-600" />
        <p className="font-semibold">You can't open Prisim CRM yet</p>
        <p className="text-sm text-slate-600">{denied}</p>
        <Button variant="secondary" className="w-full" onClick={logout}>Sign out</Button>
      </div>
    </Shell>
  );
}
