import { useEffect, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth, useAuthConfig } from "../lib/auth";
import { fmtBytes, fmtLimit } from "../lib/format";
import { Logo } from "./Logo";
import type { PlanInfo } from "../lib/types";

export function MarketingLayout() {
  const { user } = useAuth();
  const { pathname, hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView(); else window.scrollTo(0, 0); }, [pathname, hash]);
  const link = "text-sm text-ink-2 hover:text-ink";
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only-focusable absolute left-3 top-3 z-50 rounded bg-panel px-3 py-2 text-sm shadow">Skip to content</a>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
          <Link to="/" aria-label="Verinum home"><Logo /></Link>
          <nav className="flex items-center gap-4 sm:gap-6" aria-label="Main">
            <NavLink to="/how-it-works" className={({ isActive }) => `${link} hidden sm:inline ${isActive ? "!text-ink" : ""}`}>How it works</NavLink>
            <NavLink to="/pricing" className={({ isActive }) => `${link} ${isActive ? "!text-ink" : ""}`}>Pricing</NavLink>
            {user ? <Link to="/app" className="btn btn-primary btn-sm">Open the app</Link> : <><Link to="/login" className={link}>Sign in</Link><Link to="/register" className="btn btn-primary btn-sm">Start free</Link></>}
          </nav>
        </div>
      </header>
      <main id="main" className="flex-1"><Outlet /></main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-8 px-5 py-10 sm:px-8">
          <div className="max-w-xs"><Logo /><p className="mt-3 text-sm text-ink-2">An AI data analyst that computes every figure from your data and shows its working.</p></div>
          <nav className="flex gap-12 text-sm" aria-label="Footer">
            <ul className="space-y-2"><li><Link className={link} to="/how-it-works">How it works</Link></li><li><Link className={link} to="/pricing">Pricing</Link></li></ul>
            <ul className="space-y-2"><li><Link className={link} to="/register">Create an account</Link></li><li><Link className={link} to="/login">Sign in</Link></li></ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export function PlanGrid({ plans, current, action }: { plans: PlanInfo[]; current?: string; action?: (p: PlanInfo) => ReactNode }) {
  return (
    <div className="grid gap-0 divide-y divide-line border-y border-line md:grid-cols-3 md:divide-x md:divide-y-0">
      {plans.map((p) => (
        <div key={p.id} className="py-6 md:px-7 md:first:pl-0 md:last:pr-0" data-testid={`plan-${p.id}`}>
          <h3 className="text-2xl">{p.name}{current === p.id && <span className="ml-2 align-middle text-xs font-sans text-thread-ink">Current plan</span>}</h3>
          <p className="mt-2"><span className="num font-serif text-4xl text-ink">${p.priceMonthlyUsd}</span><span className="text-sm text-ink-3"> per month</span></p>
          <ul className="mt-4 space-y-1.5 text-sm text-ink-2">
            <li>{fmtLimit(p.limits.maxDatasets)} datasets</li>
            <li>Files up to {fmtBytes(p.limits.maxUploadBytes)}, {fmtLimit(p.limits.maxRowsPerDataset)} rows each</li>
            <li>{fmtLimit(p.limits.maxMembers)} team members</li>
            <li>{fmtLimit(p.limits.aiMessagesPerMonth)} AI answers a month</li>
            <li>{fmtLimit(p.limits.exportsPerMonth)} exports a month</li>
            <li>{p.features.forecast ? "Forecasting" : "No forecasting"}{p.features.cohort ? " and cohort analysis" : ""}</li>
          </ul>
          {action && <div className="mt-5">{action(p)}</div>}
        </div>
      ))}
    </div>
  );
}

export function usePlans(): PlanInfo[] {
  return useAuthConfig().data?.plans ?? [];
}
