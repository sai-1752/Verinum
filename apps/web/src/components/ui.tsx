import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ApiError } from "../lib/api";

/* ---------------------------------- buttons ---------------------------------- */

type Variant = "primary" | "quiet" | "ghost" | "danger";
export function Button({ variant = "quiet", size, loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "lg"; loading?: boolean }) {
  return (
    <button {...rest} type={rest.type ?? "button"} disabled={disabled || loading} aria-busy={loading || undefined}
      className={clsx("btn", `btn-${variant}`, size === "sm" && "btn-sm", size === "lg" && "btn-lg", className)}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export const Spinner = ({ label }: { label?: string }) => (
  <span className="inline-flex items-center gap-2 text-sm text-ink-2" role="status">
    <span className="spinner" aria-hidden />{label ?? <span className="sr-only">Loading</span>}
  </span>
);

/* ------------------------------------ forms ------------------------------------ */

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: (p: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode; htmlFor?: string }) {
  const id = useId();
  const fid = htmlFor ?? id;
  const dId = `${fid}-d`;
  return (
    <div>
      <label htmlFor={fid} className="label">{label}</label>
      {children({ id: fid, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? dId : undefined })}
      {error ? <p id={dId} className="mt-1.5 text-xs text-down" role="alert">{error}</p> : hint ? <p id={dId} className="hint">{hint}</p> : null}
    </div>
  );
}
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx("input", className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={clsx("input h-auto py-2 leading-6", className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={clsx("input pr-8", className)}>{children}</select>;

export function Checkbox({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 rounded border-line-2 accent-[rgb(var(--thread))]" />
      <label htmlFor={id} className="text-sm leading-5"><span className="text-ink">{label}</span>{hint && <span className="mt-0.5 block text-xs text-ink-3">{hint}</span>}</label>
    </div>
  );
}

/* ---------------------------------- feedback ---------------------------------- */

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className={clsx("rounded-md border border-down/30 bg-down-wash px-3 py-2 text-sm text-down", className)}>
      {e ? e.message : (error as Error).message || "Something went wrong."}
      {e?.requestId && e.status >= 500 && <span className="mt-0.5 block text-xs opacity-80">Reference: {e.requestId}</span>}
    </div>
  );
}

export function Notice({ tone = "info", title, children, action, className }: { tone?: "info" | "warn" | "good" | "bad"; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const t = { info: "border-line-2 bg-sunk", warn: "border-warn/30 bg-warn-wash", good: "border-up/30 bg-up-wash", bad: "border-down/30 bg-down-wash" }[tone];
  return (
    <div className={clsx("flex flex-wrap items-start justify-between gap-3 rounded-md border px-3.5 py-3 text-sm", t, className)} role={tone === "bad" ? "alert" : undefined}>
      <div className="min-w-0 flex-1">{title && <p className="font-medium text-ink">{title}</p>}{children && <div className={clsx("text-ink-2", title && "mt-0.5")}>{children}</div>}</div>
      {action}
    </div>
  );
}

export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-lg border border-dashed border-line-2 px-6 py-10 text-center", className)}>
      <h3 className="text-lg">{title}</h3>
      {children && <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={clsx("skeleton", className)} aria-hidden />;

export function PageLoading({ label = "Loading" }: { label?: string }) {
  return <div className="flex min-h-[40vh] items-center justify-center"><Spinner label={label} /></div>;
}

export function QueryError({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h2>That didn't load</h2>
      <div className="mt-4"><ErrorNote error={error} /></div>
      {retry && <Button className="mt-4" onClick={retry}>Try again</Button>}
    </div>
  );
}

/* ---------------------------------- chips ---------------------------------- */

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "good" | "warn" | "bad" | "thread"; children: ReactNode; className?: string }) {
  const t = { neutral: "bg-sunk text-ink-2", good: "bg-up-wash text-up", warn: "bg-warn-wash text-warn", bad: "bg-down-wash text-down", thread: "bg-thread-wash text-thread-ink" }[tone];
  return <span className={clsx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium", t, className)}>{children}</span>;
}

export function QualityBadge({ score, label }: { score: number; label?: string }) {
  const tone = score >= 85 ? "good" : score >= 70 ? "thread" : score >= 50 ? "warn" : "bad";
  return <Badge tone={tone}><span className="num">{score}</span>{label ? ` · ${label}` : ""}</Badge>;
}

/* ---------------------------------- meter ---------------------------------- */

export function Meter({ used, limit, label, format = (n: number) => n.toLocaleString("en-US") }: { used: number; limit: number; label: string; format?: (n: number) => string }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const hot = !unlimited && pct >= 90;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink">{label}</span>
        <span className="num text-ink-2">{format(used)} <span className="text-ink-3">of</span> {unlimited ? "unlimited" : format(limit)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunk" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={unlimited ? undefined : limit} aria-valuenow={used}>
        <div className={clsx("h-full rounded-full transition-[width]", hot ? "bg-down" : "bg-thread")} style={{ width: `${unlimited ? 3 : Math.max(pct, used > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------- dialog ---------------------------------- */

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={tid} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={clsx("m-auto w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-ink/40", wide ? "max-w-2xl" : "max-w-md")}>
      {open && (
        <div className="p-5">
          <h2 id={tid} className="text-xl">{title}</h2>
          <div className="mt-3">{children}</div>
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: ReactNode; confirmLabel: string; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="text-sm text-ink-2">{children}</div>
    </Dialog>
  );
}

/* ---------------------------------- popover ---------------------------------- */

/** A click-to-open panel anchored under its trigger; closes on outside click and Escape. */
export function Popover({ trigger, children, align = "left", label }: { trigger: (p: { open: boolean; toggle: () => void; id: string }) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div id={id} role="dialog" aria-label={label} className={clsx("absolute z-40 mt-1.5 min-w-[14rem] rounded-md border border-line-2 bg-panel p-1.5 shadow-xl", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- misc ---------------------------------- */

export function Tabs({ tabs, value, onChange, label }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={clsx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", value === t.id ? "border-thread text-ink" : "border-transparent text-ink-2 hover:text-ink")}>{t.label}</button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0"><h1>{title}</h1>{subtitle && <p className="mt-1 max-w-prose text-sm text-ink-2">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <Button size="sm" variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}>{done ? "Copied" : label}</Button>;
}
