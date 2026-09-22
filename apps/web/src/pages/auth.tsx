import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { Button, ErrorNote, Field, Input, Notice, PageLoading, Spinner } from "../components/ui";
import { api, post } from "../lib/api";
import { meKey, useAuth, useAuthConfig } from "../lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "../lib/types";
import { titleCase } from "../lib/format";

function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-5 py-5 sm:px-8"><Link to="/" aria-label="Verinum home"><Logo /></Link></header>
      <main id="main" className="mx-auto w-full max-w-[25rem] flex-1 px-5 pb-16 pt-6 sm:pt-12">
        <h1 className="text-[1.9rem]">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-ink-2">{subtitle}</p>}
        <div className="mt-7">{children}</div>
        {footer && <div className="mt-6 text-sm text-ink-2">{footer}</div>}
      </main>
    </div>
  );
}

function safeNext(v: string | null): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
}

const OAUTH_ERRORS: Record<string, string> = { access_denied: "Google sign-in was cancelled.", state: "That sign-in attempt expired. Please try again." };

function GoogleButton({ label }: { label: string }) {
  const cfg = useAuthConfig();
  if (!cfg.data?.oauth.google) return null;
  return (
    <>
      <a href="/api/v1/auth/oauth/google/start" className="btn btn-quiet btn-lg w-full">{label}</a>
      <div className="my-5 flex items-center gap-3 text-xs text-ink-3"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
    </>
  );
}

function useEnterApp() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  return async (data: MeResponse | { user: unknown; workspaceId?: string }) => {
    await qc.invalidateQueries({ queryKey: meKey });
    const next = safeNext(sp.get("next"));
    const ws = "workspaceId" in data ? data.workspaceId : undefined;
    nav(next ?? (ws ? `/w/${ws}` : "/app"), { replace: true });
  };
}

export function LoginPage() {
  const { user, loading } = useAuth();
  const enter = useEnterApp();
  const [sp] = useSearchParams();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const m = useMutation({ mutationFn: () => post<{ user: unknown }>("/auth/login", { email, password }), onSuccess: (r) => enter(r) });
  const nav = useNavigate();
  useEffect(() => { if (!loading && user) nav(safeNext(sp.get("next")) ?? "/app", { replace: true }); }, [loading, user, nav, sp]);
  const oauthErr = sp.get("error");
  return (
    <AuthFrame title="Sign in" subtitle="Welcome back." footer={<><Link className="link" to="/forgot-password">Forgot your password?</Link><p className="mt-2">New to Verinum? <Link className="link" to={`/register${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next")!)}` : ""}`}>Create an account</Link></p></>}>
      {oauthErr && <Notice tone="bad" className="mb-4">{OAUTH_ERRORS[oauthErr] ?? "We couldn't sign you in with Google. Please try again."}</Notice>}
      <GoogleButton label="Continue with Google" />
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
        <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>Sign in</Button>
      </form>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { user, loading } = useAuth();
  const cfg = useAuthConfig();
  const enter = useEnterApp();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const m = useMutation({ mutationFn: () => post<{ user: unknown; workspaceId: string }>("/auth/register", { name, email, password }), onSuccess: (r) => enter(r) });
  useEffect(() => { if (!loading && user) nav(safeNext(sp.get("next")) ?? "/app", { replace: true }); }, [loading, user, nav, sp]);
  if (cfg.data && !cfg.data.registration) return <AuthFrame title="Sign-ups are closed"><p className="text-sm text-ink-2">This deployment isn't accepting new accounts right now. If you were invited, use the link in your invitation email.</p><Link to="/login" className="btn btn-primary mt-5">Sign in</Link></AuthFrame>;
  return (
    <AuthFrame title="Create your account" subtitle="You'll get a workspace of your own, and a demo dataset to try straight away." footer={<>Already have an account? <Link className="link" to="/login">Sign in</Link></>}>
      <GoogleButton label="Sign up with Google" />
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Your name">{(p) => <Input {...p} autoComplete="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Work email">{(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password" hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>Create account</Button>
        <p className="text-xs text-ink-3">By creating an account you agree to how we handle your data as described in our security notes: files are encrypted at rest and never shared between workspaces.</p>
      </form>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const m = useMutation({ mutationFn: () => post("/auth/forgot-password", { email }) });
  return (
    <AuthFrame title="Reset your password" subtitle="Enter your email and we'll send a link if an account exists." footer={<Link className="link" to="/login">Back to sign in</Link>}>
      {m.isSuccess ? <Notice tone="good" title="Check your inbox">If an account exists for {email}, a reset link is on its way. The link works once and expires in an hour.</Notice> : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
          <ErrorNote error={m.error} />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>Send reset link</Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const [password, setPassword] = useState("");
  const m = useMutation({ mutationFn: () => post("/auth/reset-password", { token, password }) });
  if (!token) return <AuthFrame title="This link is incomplete"><p className="text-sm text-ink-2">Open the link from your email again, or request a new one.</p><Link className="btn btn-primary mt-5" to="/forgot-password">Request a new link</Link></AuthFrame>;
  return (
    <AuthFrame title="Choose a new password" subtitle="Resetting signs you out of every device.">
      {m.isSuccess ? <Notice tone="good" title="Password updated" action={<Link className="btn btn-primary btn-sm" to="/login">Sign in</Link>}>You can sign in with your new password.</Notice> : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="New password" hint="At least 10 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}</Field>
          <ErrorNote error={m.error} />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={m.isPending}>Update password</Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const { refresh } = useAuth();
  const m = useMutation({ mutationFn: () => post("/auth/verify-email", { token }), onSuccess: () => void refresh() });
  useEffect(() => { if (token && m.isIdle) m.mutate(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <AuthFrame title="Confirming your email">
      {m.isPending || m.isIdle ? <Spinner label="Checking the link" /> : m.isSuccess ? <Notice tone="good" title="Email confirmed" action={<Link className="btn btn-primary btn-sm" to="/app">Continue</Link>}>Thanks — your address is verified.</Notice> : <><ErrorNote error={m.error} /><Link className="btn btn-quiet mt-4" to="/app">Go to the app</Link></>}
    </AuthFrame>
  );
}

export function AcceptInvitePage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const { user, loading, refresh } = useAuth();
  const nav = useNavigate();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => api<{ workspaceName: string; role: string; email: string }>("/invitations/preview", { query: { token } }), enabled: !!token, retry: false });
  const accept = useMutation({ mutationFn: () => post<{ workspaceId: string }>("/invitations/accept", { token }), onSuccess: async (r) => { await refresh(); nav(`/w/${r.workspaceId}`, { replace: true }); } });
  if (!token) return <AuthFrame title="This link is incomplete"><p className="text-sm text-ink-2">Open the link from your invitation email again.</p></AuthFrame>;
  if (preview.isLoading || loading) return <PageLoading />;
  if (preview.error) return <AuthFrame title="This invitation can't be used"><ErrorNote error={preview.error} /><p className="mt-3 text-sm text-ink-2">It may have expired or been withdrawn. Ask the person who invited you to send a new one.</p></AuthFrame>;
  const p = preview.data!;
  const next = encodeURIComponent(`/accept-invite?token=${token}`);
  return (
    <AuthFrame title={`Join ${p.workspaceName}`} subtitle={<>You've been invited as {p.role === "admin" ? "an" : "a"} <strong className="font-medium text-ink">{titleCase(p.role).toLowerCase()}</strong>. The invitation is for {p.email}.</>}>
      {user ? (
        <div className="space-y-3">
          {user.email !== p.email && <Notice tone="warn">You're signed in as {user.email}. This invitation is for {p.email}, so accepting will fail. Sign out and use the invited address.</Notice>}
          <ErrorNote error={accept.error} />
          <Button variant="primary" size="lg" className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>Accept invitation</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Link to={`/register?next=${next}`} className="btn btn-primary btn-lg">Create an account to join</Link>
          <Link to={`/login?next=${next}`} className="btn btn-quiet btn-lg">I already have an account</Link>
        </div>
      )}
    </AuthFrame>
  );
}
