import { ReactNode } from 'react';
import { SignIn, SignUp } from '@clerk/react';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui';

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center glow-page p-4">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-6 flex flex-col items-center">
          <img src="/prisim-logo-dark.png" alt="Prisim" className="mb-2 h-14 w-auto" />
          <h1 className="text-lg font-semibold tracking-[0.3em] text-slate-900">CRM</h1>
          <p className="text-sm text-slate-600">Leads, follow-ups, calls, tasks and feedback in one place</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Login() {
  return <Shell><SignIn routing="path" path="/login" signUpUrl="/sign-up" fallbackRedirectUrl="/" /></Shell>;
}

/** Reached from a Clerk invitation email. */
export function Register() {
  return <Shell><SignUp routing="path" path="/sign-up" signInUrl="/login" fallbackRedirectUrl="/" /></Shell>;
}

/** Signed in with Clerk, but not allowed into the CRM. */
export function NoAccess() {
  const { denied, logout } = useAuth();
  return (
    <Shell>
      <div className="w-full space-y-4 rounded-2xl bg-surface p-6 text-center shadow-2xl">
        <ShieldAlert className="mx-auto h-10 w-10 text-amber-600" />
        <p className="font-semibold">You can't open Prisim CRM yet</p>
        <p className="text-sm text-slate-600">{denied}</p>
        <Button variant="secondary" className="w-full" onClick={logout}>Sign out</Button>
      </div>
    </Shell>
  );
}
