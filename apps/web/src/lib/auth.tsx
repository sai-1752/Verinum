import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, api, post, setUnauthorizedHandler } from "./api";
import type { AuthConfig, MeResponse, User, WorkspaceSummary } from "./types";

interface AuthState {
  user: User | null;
  workspaces: WorkspaceSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export const meKey = ["me"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const q = useQuery({
    queryKey: meKey,
    queryFn: async () => { try { return await api<MeResponse>("/auth/me", { quiet401: true }); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } },
    staleTime: 60_000, retry: false,
  });

  // A 401 from any call means the session ended: drop cached data and go to sign-in, remembering where we were.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.clear();
      qc.setQueryData(meKey, null);
      const here = window.location.pathname + window.location.search;
      if (/^\/(w|app|account|admin)(\/|$)/.test(window.location.pathname)) nav(`/login?next=${encodeURIComponent(here)}`, { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc, nav]);

  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: meKey }); }, [qc]);
  const logout = useCallback(async () => {
    try { await post("/auth/logout"); } catch { /* already signed out */ }
    qc.clear(); qc.setQueryData(meKey, null);
    nav("/", { replace: true });
  }, [qc, nav]);

  const value = useMemo<AuthState>(() => ({ user: q.data?.user ?? null, workspaces: q.data?.workspaces ?? [], loading: q.isLoading, refresh, logout }), [q.data, q.isLoading, refresh, logout]);
  void loc;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}

export function useAuthConfig() {
  return useQuery({ queryKey: ["auth-config"], queryFn: () => api<AuthConfig>("/auth/config"), staleTime: 5 * 60_000 });
}
