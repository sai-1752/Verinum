import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface Toast { id: number; kind: "success" | "error" | "info"; text: string }
interface ToastApi { success: (t: string) => void; error: (t: string) => void; info: (t: string) => void }
const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "error" ? 8000 : 4500);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (t) => push("success", t), error: (t) => push("error", t), info: (t) => push("info", t) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[80] flex w-[min(92vw,22rem)] flex-col gap-2" role="region" aria-label="Notifications">
        {items.map((t) => (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
            className={`rounded-md border px-3.5 py-2.5 text-sm shadow-lg ${t.kind === "error" ? "border-down/40 bg-down-wash text-down" : t.kind === "success" ? "border-up/40 bg-up-wash text-up" : "border-line-2 bg-panel text-ink"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
