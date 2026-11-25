import { ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { allowedPages, canOpen } from './lib/pages';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import '@fontsource-variable/inter-tight';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import Login, { ForgotPassword, NoAccess, SetPassword } from './pages/Login';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import FollowUps from './pages/FollowUps';
import Tasks from './pages/Tasks';
import Feedback from './pages/Feedback';
import Clients, { ClientDetail } from './pages/Clients';
import FeedbackDetail from './pages/FeedbackDetail';
import Media from './pages/Media';
import Seo from './pages/Seo';
import TeamChat from './pages/TeamChat';
import Reports from './pages/Reports';
import AccountingDashboard from './pages/accounting/Dashboard';
import AccountingExpenses from './pages/accounting/Expenses';
import AccountingApprovals from './pages/accounting/Approvals';
import AccountingProjects, { ProjectPage as AccountingProject } from './pages/accounting/Projects';
import AccountingInvoices, { InvoicePage as AccountingInvoice } from './pages/accounting/Invoices';
import AccountingCategories from './pages/accounting/Categories';
import AccountingReports from './pages/accounting/Reports';
import AccountingClientAnalysis, { ClientAnalysisDetailPage as AccountingClientAnalysisDetail } from './pages/accounting/ClientAnalysis';
import AccountingSettings from './pages/accounting/Settings';
import AccountingPayroll, { MyPayslip, MyPayslips, PayrollPayslipPage, PayrollRunPage, PayrollRunPayslipsPage } from './pages/accounting/Payroll';
import Quotations, { QuotationEditor } from './pages/Quotations';
import Profile from './pages/Profile';
import AdminUsers from './pages/admin/Users';
import AdminRoles from './pages/admin/Roles';
import AdminIntegrations from './pages/admin/Integrations';
import AdminAudit from './pages/admin/Audit';
import AdminChatBackup from './pages/admin/ChatBackup';

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => n < 1 && !(e as { status?: number }).status, refetchOnWindowFocus: false } },
});

function Protected() {
  const { me, loading, denied } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <Spinner className="h-full items-center" />;
  if (denied) return <NoAccess />;
  if (!me) return <Navigate to="/login" replace />;
  // Limited roles (e.g. Video Editor) land on their first page and can't open the rest.
  const allowed = allowedPages(me.roles);
  if (allowed && !canOpen(allowed, pathname)) return <Navigate to={allowed[0]} replace />;
  return <Layout />;
}

function App() {
  const { me, denied } = useAuth();
  const entry = (page: ReactNode) => (me ? <Navigate to="/" replace /> : denied ? <NoAccess /> : page);
  return (
    <Routes>
      <Route path="/login" element={entry(<Login />)} />
      <Route path="/forgot-password" element={entry(<ForgotPassword />)} />
      <Route path="/set-password" element={<SetPassword />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="leads/:id" element={<LeadDetail />} />
        <Route path="follow-ups" element={<FollowUps />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="clients" element={<Clients />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="media" element={<Media />} />
        <Route path="seo" element={<Seo />} />
        <Route path="chat" element={<TeamChat />} />
        <Route path="reports" element={<Reports />} />
        <Route path="accounting" element={<Navigate to="/accounting/dashboard" replace />} />
        <Route path="accounting/dashboard" element={<AccountingDashboard />} />
        <Route path="accounting/expenses" element={<AccountingExpenses />} />
        <Route path="accounting/approvals" element={<AccountingApprovals />} />
        <Route path="accounting/projects" element={<AccountingProjects />} />
        <Route path="accounting/projects/:id" element={<AccountingProject />} />
        <Route path="accounting/invoices" element={<AccountingInvoices />} />
        <Route path="accounting/invoices/:id" element={<AccountingInvoice />} />
        <Route path="accounting/categories" element={<AccountingCategories />} />
        <Route path="accounting/reports" element={<AccountingReports />} />
        <Route path="accounting/client-analysis" element={<AccountingClientAnalysis />} />
        <Route path="accounting/client-analysis/:id" element={<AccountingClientAnalysisDetail />} />
        <Route path="accounting/settings" element={<AccountingSettings />} />
        <Route path="accounting/payroll" element={<AccountingPayroll />} />
        <Route path="accounting/payroll/runs/:id" element={<PayrollRunPage />} />
        <Route path="accounting/payroll/runs/:id/payslips" element={<PayrollRunPayslipsPage />} />
        <Route path="accounting/payroll/payslips/:id" element={<PayrollPayslipPage />} />
        <Route path="accounting/quotations" element={<Navigate to="/quotations" replace />} />
        <Route path="accounting/*" element={<Navigate to="/accounting/dashboard" replace />} />
        <Route path="quotations" element={<Quotations />} />
        <Route path="quotations/:id" element={<QuotationEditor />} />
        <Route path="mic" element={<Navigate to="/chat" replace />} />
        <Route path="feedback" element={<Feedback />} />
        <Route path="feedback/:id" element={<FeedbackDetail />} />
        <Route path="profile" element={<Profile />} />
        <Route path="payslips" element={<MyPayslips />} />
        <Route path="payslips/:id" element={<MyPayslip />} />
        <Route path="admin/users" element={<AdminUsers />} />
        <Route path="admin/roles" element={<AdminRoles />} />
        <Route path="admin/integrations" element={<AdminIntegrations />} />
        <Route path="admin/audit" element={<AdminAudit />} />
        <Route path="admin/chat-backup" element={<AdminChatBackup />} />
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
