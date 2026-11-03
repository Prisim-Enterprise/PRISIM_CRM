import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
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

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 1 && !(e as { status?: number }).status, refetchOnWindowFocus: false } },
});

function Protected() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner className="h-full items-center" />;
  if (!me) return <Navigate to="/login" replace />;
  return <Layout />;
}

function App() {
  const { me } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
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
        <AuthProvider>
          <App />
          <Toaster richColors position="top-right" />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
