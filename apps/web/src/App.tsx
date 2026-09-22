import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShellGate } from "./AppGate";
import { MarketingLayout } from "./components/Marketing";
import { PageLoading } from "./components/ui";
import { LandingPage, PricingPage, HowItWorksPage } from "./pages/marketing";
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from "./pages/auth";
import { WorkspaceLayout } from "./components/AppShell";
import { DatasetsPage } from "./pages/datasets";
import { DatasetLayout } from "./pages/dataset/Layout";
import { OverviewPage } from "./pages/dataset/Overview";
import { InsightsPage } from "./pages/dataset/Insights";
import { AskPage } from "./pages/dataset/Ask";
import { AuditPage, MembersPage, SettingsPage, UsagePage } from "./pages/workspace";
import { AccountPage } from "./pages/account";
import { useSeo } from "./lib/seo";

// Chart-heavy and rarely-first pages load on demand
const DashboardPage = lazy(() => import("./pages/dataset/Dashboard").then((m) => ({ default: m.DashboardPage })));
const ForecastPage = lazy(() => import("./pages/dataset/Forecast").then((m) => ({ default: m.ForecastPage })));
const ExplorePage = lazy(() => import("./pages/dataset/Explore").then((m) => ({ default: m.ExplorePage })));
const DataPage = lazy(() => import("./pages/dataset/Data").then((m) => ({ default: m.DataPage })));
const AdminPage = lazy(() => import("./pages/admin").then((m) => ({ default: m.AdminPage })));

function NotFound() {
  useSeo({ title: "Page not found — Verinum", description: "That page doesn't exist.", path: useLocation().pathname, noindex: true });
  return <div className="mx-auto max-w-md px-4 py-28 text-center"><h1>Page not found</h1><p className="mt-2 text-sm text-ink-2">The link may be old or mistyped.</p><Link to="/" className="btn btn-primary mt-5">Go to the home page</Link></div>;
}

const Lazy = ({ children }: { children: React.ReactNode }) => <Suspense fallback={<PageLoading />}>{children}</Suspense>;

export function App() {
  return (
    <Routes>
      <Route element={<MarketingLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="pricing" element={<PricingPage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
      </Route>
      <Route path="login" element={<LoginPage />} />
      <Route path="register" element={<RegisterPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route path="verify-email" element={<VerifyEmailPage />} />
      <Route path="accept-invite" element={<AcceptInvitePage />} />

      <Route element={<AppShellGate />}>
        <Route path="app" element={<Navigate to="/" replace />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<Lazy><AdminPage /></Lazy>} />
        <Route path="w/:wsId" element={<WorkspaceLayout />}>
          <Route index element={<DatasetsPage />} />
          <Route path="datasets" element={<Navigate to=".." relative="path" replace />} />
          <Route path="datasets/:dsId" element={<DatasetLayout />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="insights" element={<InsightsPage />} />
            <Route path="dashboard" element={<Lazy><DashboardPage /></Lazy>} />
            <Route path="forecast" element={<Lazy><ForecastPage /></Lazy>} />
            <Route path="explore" element={<Lazy><ExplorePage /></Lazy>} />
            <Route path="ask" element={<AskPage />} />
            <Route path="data" element={<Lazy><DataPage /></Lazy>} />
          </Route>
          <Route path="members" element={<MembersPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="billing" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
