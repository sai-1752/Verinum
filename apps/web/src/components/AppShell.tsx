import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { post } from "../lib/api";
import { applyTheme, getTheme, type ThemeChoice } from "../lib/theme";
import { useToast } from "../lib/toast";
import { WorkspaceProvider, useWorkspace } from "../lib/workspace";
import { Logo } from "./Logo";
import { Button, Dialog, ErrorNote, Field, Input, Popover } from "./ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { meKey } from "../lib/auth";

function NavItem({ to, children, end }: { to: string; children: ReactNode; end?: boolean }) {
  return <NavLink to={to} end={end} className={({ isActive }) => clsx("flex items-center rounded-md px-2.5 py-1.5 text-sm", isActive ? "bg-thread-wash font-medium text-thread-ink" : "text-ink-2 hover:bg-sunk hover:text-ink")}>{children}</NavLink>;
}

function NewWorkspace({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const nav = useNavigate();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => post<{ id: string }>("/workspaces", { name }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: meKey }); onClose(); setName(""); nav(`/w/${r.id}`); },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New workspace" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>Create workspace</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }} className="space-y-3">
        <p className="text-sm text-ink-2">A workspace holds datasets and the people who can see them. Nothing is shared between workspaces.</p>
        <Field label="Workspace name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus placeholder="Acme finance team" />}</Field>
        <ErrorNote error={m.error} />
      </form>
    </Dialog>
  );
}

function Rail({ onNavigate }: { onNavigate?: () => void }) {
  const { id, workspace, can } = useWorkspace();
  const { user, workspaces, logout } = useAuth();
  const [creating, setCreating] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(getTheme());
  const nav = useNavigate();
  const base = `/w/${id}`;
  const cycle = () => { const n: ThemeChoice = theme === "system" ? "light" : theme === "light" ? "dark" : "system"; setTheme(n); applyTheme(n); };
  return (
    <div className="flex h-full flex-col" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) onNavigate?.(); }}>
      <div className="px-4 pb-3 pt-4"><Link to="/app" aria-label="Verinum home"><Logo /></Link></div>
      <div className="px-3">
        <Popover label="Switch workspace" trigger={({ toggle, open, id: pid }) => (
          <button onClick={toggle} aria-expanded={open} aria-controls={pid} data-testid="workspace-switcher" className="flex w-full items-center justify-between gap-2 rounded-md border border-line-2 bg-panel px-2.5 py-2 text-left hover:bg-sunk">
            <span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{workspace.name}</span><span className="block text-xs capitalize text-ink-3">{workspace.plan.name} plan · {workspace.role}</span></span>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0 text-ink-3"><path d="M2 4.5 6 8l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>)}>
          {(close) => (
            <div className="w-64">
              <ul>{workspaces.map((w) => <li key={w.id}><button onClick={() => { close(); nav(`/w/${w.id}`); onNavigate?.(); }} className={clsx("block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-sunk", w.id === id && "bg-thread-wash")}><span className="block truncate text-ink">{w.name}</span><span className="text-xs capitalize text-ink-3">{w.role}</span></button></li>)}</ul>
              <div className="mt-1 border-t border-line pt-1"><button onClick={() => { close(); setCreating(true); }} className="block w-full rounded px-2 py-1.5 text-left text-sm text-thread hover:bg-sunk">New workspace</button></div>
            </div>
          )}
        </Popover>
      </div>
      <nav className="mt-4 flex-1 space-y-0.5 px-3" aria-label="Workspace">
        <NavItem to={base} end>Datasets</NavItem>
        <NavItem to={`${base}/members`}>Members</NavItem>
        <NavItem to={`${base}/usage`}>Usage and plan</NavItem>
        {can("audit.read") && <NavItem to={`${base}/audit`}>Audit log</NavItem>}
        <NavItem to={`${base}/settings`}>Settings</NavItem>
      </nav>
      <div className="border-t border-line p-3">
        <Popover label="Account" trigger={({ toggle, open, id: pid }) => (
          <button onClick={toggle} aria-expanded={open} aria-controls={pid} data-testid="account-menu" className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sunk">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-thread-wash text-xs font-medium text-thread-ink" aria-hidden>{(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0"><span className="block truncate text-sm text-ink">{user?.name || "Account"}</span><span className="block truncate text-xs text-ink-3">{user?.email}</span></span>
          </button>)}>
          {(close) => (
            <div className="w-56">
              <Link to="/account" onClick={close} className="block rounded px-2 py-1.5 text-sm text-ink hover:bg-sunk">Account and security</Link>
              {user?.isPlatformAdmin && <Link to="/admin" onClick={close} className="block rounded px-2 py-1.5 text-sm text-ink hover:bg-sunk">Platform admin</Link>}
              <button onClick={cycle} className="block w-full rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-sunk">Theme: {theme === "system" ? "match device" : theme}</button>
              <button onClick={() => { close(); void logout(); }} className="block w-full rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-sunk">Sign out</button>
            </div>
          )}
        </Popover>
      </div>
      <NewWorkspace open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function VerifyBanner() {
  const { user } = useAuth();
  const toast = useToast();
  const [sent, setSent] = useState(false);
  if (!user || user.emailVerified) return null;
  return (
    <div className="border-b border-warn/30 bg-warn-wash px-4 py-2 text-sm text-ink" role="status">
      Please confirm your email address.{" "}
      {sent ? <span className="text-ink-2">Verification email sent.</span> : <button className="font-medium underline underline-offset-2" onClick={async () => { try { await post("/auth/resend-verification"); setSent(true); } catch (e) { toast.error((e as Error).message); } }}>Send the link again</button>}
    </div>
  );
}

function Frame() {
  const [open, setOpen] = useState(false);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-panel lg:block" aria-label="Sidebar"><Rail /></aside>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-panel px-4 py-2.5 lg:hidden">
        <Link to="/app"><Logo /></Link>
        <Button size="sm" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>Menu</Button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-panel shadow-2xl"><Rail onNavigate={() => setOpen(false)} /></div>
        </div>
      )}
      <div className="min-w-0">
        <VerifyBanner />
        <main id="main" className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9"><Outlet /></main>
      </div>
    </div>
  );
}

export function WorkspaceLayout() {
  const { wsId = "" } = useParams();
  const { workspaces } = useAuth();
  if (!workspaces.some((w) => w.id === wsId)) {
    return <div className="mx-auto max-w-md px-4 py-24 text-center"><h1>Workspace not found</h1><p className="mt-2 text-sm text-ink-2">It may have been deleted, or you may not be a member.</p><Link to="/app" className="btn btn-primary mt-5">Go to your workspaces</Link></div>;
  }
  return <WorkspaceProvider id={wsId} key={wsId}><Frame /></WorkspaceProvider>;
}
