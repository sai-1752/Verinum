import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Logo";
import { Badge, Button, ErrorNote, Field, Input, Notice, PageHeader, QueryError, Skeleton } from "../components/ui";
import { del, get, patch, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDateTime, fmtRelative } from "../lib/format";
import { useToast } from "../lib/toast";
import type { SessionInfo } from "../lib/types";

export function AccountPage() {
  const { user, workspaces, refresh, logout } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [cur, setCur] = useState(""); const [next, setNext] = useState("");
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<{ sessions: SessionInfo[] }>("/auth/sessions").then((r) => r.sessions) });
  const saveName = useMutation({ mutationFn: () => patch("/auth/profile", { name }), onSuccess: async () => { toast.success("Name updated."); await refresh(); } });
  const changePw = useMutation({ mutationFn: () => post("/auth/change-password", { currentPassword: cur, newPassword: next }), onSuccess: () => { toast.success("Password changed. Your other devices were signed out."); setCur(""); setNext(""); void qc.invalidateQueries({ queryKey: ["sessions"] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/auth/sessions/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessions"] }) });
  const revokeOthers = useMutation({ mutationFn: () => post("/auth/sessions/revoke-others"), onSuccess: () => { toast.success("Signed out everywhere else."); void qc.invalidateQueries({ queryKey: ["sessions"] }); } });
  const resend = useMutation({ mutationFn: () => post("/auth/resend-verification"), onSuccess: () => toast.success("Verification email sent.") });
  const first = workspaces[0];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between"><Link to={first ? `/w/${first.id}` : "/app"} aria-label="Back to the app"><Logo /></Link><Link to={first ? `/w/${first.id}` : "/app"} className="text-sm text-ink-2 hover:text-ink">Back to the app</Link></div>
      <PageHeader title="Account and security" />
      <section aria-labelledby="prof-h">
        <h2 id="prof-h" className="text-xl">Profile</h2>
        <form className="mt-3 flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); saveName.mutate(); }}>
          <div className="flex-1"><Field label="Your name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}</Field></div>
          <Button type="submit" variant="primary" disabled={!name.trim() || name === user?.name} loading={saveName.isPending}>Save</Button>
        </form>
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">{user?.email} {user?.emailVerified ? <Badge tone="good">Verified</Badge> : <><Badge tone="warn">Not verified</Badge><button className="text-thread underline underline-offset-2" onClick={() => resend.mutate()}>Send the link again</button></>}</p>
      </section>

      <section className="mt-12 border-t border-line pt-6" aria-labelledby="pw-h">
        <h2 id="pw-h" className="text-xl">Password</h2>
        <form className="mt-3 max-w-sm space-y-4" onSubmit={(e) => { e.preventDefault(); changePw.mutate(); }}>
          <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
          <Field label="New password" hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <ErrorNote error={changePw.error} />
          <Button type="submit" variant="primary" loading={changePw.isPending}>Change password</Button>
        </form>
      </section>

      <section className="mt-12 border-t border-line pt-6" aria-labelledby="sess-h">
        <div className="flex items-baseline justify-between gap-3"><h2 id="sess-h" className="text-xl">Where you're signed in</h2>{(sessions.data?.length ?? 0) > 1 && <Button size="sm" onClick={() => revokeOthers.mutate()} loading={revokeOthers.isPending}>Sign out everywhere else</Button>}</div>
        {sessions.isLoading && <Skeleton className="mt-3 h-20" />}
        {sessions.error && <QueryError error={sessions.error} />}
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1 basis-60"><p className="truncate text-ink">{(s.userAgent ?? "Unknown device").slice(0, 80)}{s.current && <Badge tone="thread" className="ml-2">This device</Badge>}</p><p className="text-xs text-ink-3" title={fmtDateTime(s.lastSeenAt)}>{s.ip ?? "Unknown location"} · active {fmtRelative(s.lastSeenAt)}</p></div>
              {!s.current && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
            </li>
          ))}
        </ul>
      </section>
      <div className="mt-12 border-t border-line pt-6"><Button onClick={() => void logout()}>Sign out</Button></div>
      <Notice className="mt-8" tone="info">Your data belongs to your workspaces. Deleting a workspace permanently removes its files and analysis.</Notice>
    </div>
  );
}
