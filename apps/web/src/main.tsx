import { ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ClerkProvider } from '@clerk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Login, { NoAccess, Register } from './pages/Login';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import FollowUps from './pages/FollowUps';
import Calls from './pages/Calls';
import Tasks from './pages/Tasks';
import Feedback from './pages/Feedback';
import Clients, { ClientDetail } from './pages/Clients';
import FeedbackDetail from './pages/FeedbackDetail';
import Profile from './pages/Profile';
import AdminUsers from './pages/admin/Users';
import AdminRoles from './pages/admin/Roles';
import AdminIntegrations from './pages/admin/Integrations';
import AdminAudit from './pages/admin/Audit';

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
if (!CLERK_KEY) throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set');

// Matches the app's dark theme.
const clerkAppearance = {
  variables: {
    colorPrimary: '#4f46e5', colorBackground: '#0f172a', colorInput: '#020617', colorForeground: '#f1f5f9',
    colorInputForeground: '#f1f5f9', colorMutedForeground: '#94a3b8', colorNeutral: '#f1f5f9',
  },
};

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 1 && !(e as { status?: number }).status, refetchOnWindowFocus: false } },
});

function Protected() {
  const { me, loading, denied } = useAuth();
  if (loading) return <Spinner className="h-full items-center" />;
  if (denied) return <NoAccess />;
  if (!me) return <Navigate to="/login" replace />;
  return <Layout />;
}

function App() {
  const { me, denied } = useAuth();
  const entry = (page: ReactNode) => (me ? <Navigate to="/" replace /> : denied ? <NoAccess /> : page);
  return (
    <Routes>
      <Route path="/login/*" element={entry(<Login />)} />
      <Route path="/sign-up/*" element={entry(<Register />)} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="follow-ups" element={<FollowUps />} />
        <Route path="calls" element={<Calls />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="clients" element={<Clients />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="feedback" element={<Feedback />} />
        <Route path="feedback/:id" element={<FeedbackDetail />} />
        <Route path="profile" element={<Profile />} />
        <Route path="admin/users" element={<AdminUsers />} />
        <Route path="admin/roles" element={<AdminRoles />} />
        <Route path="admin/integrations" element={<AdminIntegrations />} />
        <Route path="admin/audit" element={<AdminAudit />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ClerkProvider publishableKey={CLERK_KEY} signInUrl="/login" signUpUrl="/sign-up" afterSignOutUrl="/login" appearance={clerkAppearance}>
          <AuthProvider>
            <App />
            <Toaster richColors position="top-right" />
          </AuthProvider>
        </ClerkProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
