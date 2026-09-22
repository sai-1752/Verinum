import { createContext, useContext, type ReactNode } from "react";
import { useWorkspaceDetail } from "./hooks";
import type { WorkspaceDetail } from "./types";
import { PageLoading, QueryError } from "../components/ui";

interface Ctx { id: string; workspace: WorkspaceDetail; can: (action: string) => boolean }
const C = createContext<Ctx | null>(null);

export function WorkspaceProvider({ id, children }: { id: string; children: ReactNode }) {
  const q = useWorkspaceDetail(id);
  if (q.isLoading) return <PageLoading label="Opening workspace" />;
  if (q.error || !q.data) return <QueryError error={q.error} retry={() => void q.refetch()} />;
  const w = q.data;
  return <C.Provider value={{ id, workspace: w, can: (a) => w.permissions.includes(a) }}>{children}</C.Provider>;
}

export function useWorkspace(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return v;
}
