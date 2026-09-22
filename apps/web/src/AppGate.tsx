import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { PageLoading } from "./components/ui";
import { useAuth } from "./lib/auth";
import { useSeo } from "./lib/seo";

/** Everything behind sign-in. `/app` resolves to the user's last workspace. */
export function AppShellGate() {
  const { user, workspaces, loading } = useAuth();
  const loc = useLocation();
  useSeo({ title: "Verinum", description: "Verinum workspace", path: loc.pathname, noindex: true });
  useEffect(() => { if (user) { const m = /^\/w\/([^/]+)/.exec(loc.pathname); if (m) try { localStorage.setItem("tl.lastWorkspace", m[1]!); } catch { /* storage unavailable */ } } }, [user, loc.pathname]);
  if (loading) return <PageLoading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (loc.pathname === "/app") {
    let last: string | null = null;
    try { last = localStorage.getItem("tl.lastWorkspace"); } catch { /* storage unavailable */ }
    const target = workspaces.find((w) => w.id === last) ?? workspaces[0];
    return target ? <Navigate to={`/w/${target.id}`} replace /> : <div className="mx-auto max-w-md px-4 py-28 text-center"><h1>No workspace yet</h1><p className="mt-2 text-sm text-ink-2">You aren't a member of any workspace. Ask for an invitation, or create one.</p></div>;
  }
  return <Outlet />;
}
