import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, ConfirmDialog, ErrorNote, Field, Input, Meter, Notice, PageHeader, QueryError, Select, Skeleton } from "../components/ui";
import { ApiError, api, del, patch, post } from "../lib/api";
import { meKey, useAuth, useAuthConfig } from "../lib/auth";
import { fmtBytes, fmtDate, fmtDateTime, fmtLimit, fmtRelative, titleCase } from "../lib/format";
import { useAudit, useBilling, useMembers, useUsage } from "../lib/hooks";
import { useToast } from "../lib/toast";
import { useWorkspace } from "../lib/workspace";
import { ROLES, type Role } from "../lib/types";

const canManageRole = (actor: Role, target: Role) => actor === "owner" || (actor === "admin" && (target === "analyst" || target === "viewer"));
const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including billing and deleting the workspace.",
  admin: "Manage members, datasets and settings. Can't change billing or remove owners.",
  analyst: "Upload and analyse data, build dashboards, export.",
  viewer: "Read-only: view dashboards and insights and ask questions.",
};

/* -------------------------------------------- members -------------------------------------------- */

export function MembersPage() {
  const { id: wsId, workspace, can } = useWorkspace();
  const { user, refresh } = useAuth();
  const q = useMembers(wsId);
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [email, setEmail] = useState(""); const [role, setRole] = useState<Role>("analyst");
  const [removing, setRemoving] = useState<{ userId: string; name: string; self: boolean } | null>(null);
  const inv = () => { void qc.invalidateQueries({ queryKey: ["members", wsId] }); void qc.invalidateQueries({ queryKey: ["usage", wsId] }); };
  const invite = useMutation({ mutationFn: () => post(`/workspaces/${wsId}/invitations`, { email, role }), onSuccess: () => { toast.success(`Invitation sent to ${email}.`); setEmail(""); inv(); } });
  const changeRole = useMutation({ mutationFn: (a: { userId: string; role: Role }) => patch(`/workspaces/${wsId}/members/${a.userId}`, { role: a.role }), onSuccess: () => { toast.success("Role updated."); inv(); }, onError: (e) => toast.error((e as Error).message) });
  const remove = useMutation({
    mutationFn: (userId: string) => del(`/workspaces/${wsId}/members/${userId}`),
    onSuccess: async (_r, userId) => { inv(); setRemoving(null); if (userId === user?.id) { await refresh(); nav("/app"); } else toast.success("Member removed."); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/workspaces/${wsId}/invitations/${id}`), onSuccess: () => { toast.success("Invitation withdrawn."); inv(); } });
  const me = workspace.role;
  const invitable = ROLES.filter((r) => r !== "owner" && canManageRole(me, r));

  return (
    <div>
      <PageHeader title="Members" subtitle="People in this workspace can only see this workspace's data." />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <QueryError error={q.error} />}
      {q.data && (
        <>
          <ul className="divide-y divide-line border-y border-line" aria-label="Members">
            {q.data.members.map((m) => {
              const self = m.userId === user?.id;
              const editable = can("member.role") && !self && canManageRole(me, m.role);
              return (
                <li key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5" data-testid="member-row">
                  <div className="min-w-0 flex-1 basis-56"><p className="truncate text-sm font-medium text-ink">{m.name || m.email}{self && <span className="ml-2 text-xs font-normal text-ink-3">you</span>}</p><p className="truncate text-xs text-ink-3">{m.email} · joined {fmtDate(m.joinedAt)}</p></div>
                  {editable ? (
                    <Select aria-label={`Role for ${m.name || m.email}`} className="!w-36" value={m.role} onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as Role })}>
                      {ROLES.filter((r) => canManageRole(me, r) && (r !== "owner" || me === "owner")).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
                    </Select>
                  ) : <Badge tone={m.role === "owner" ? "thread" : "neutral"}>{titleCase(m.role)}</Badge>}
                  {((can("member.remove") && !self && canManageRole(me, m.role)) || (self && m.role !== "owner")) && <Button size="sm" variant="ghost" onClick={() => setRemoving({ userId: m.userId, name: m.name || m.email, self })}>{self ? "Leave" : "Remove"}</Button>}
                </li>
              );
            })}
          </ul>

          {can("member.invite") && (
            <section className="mt-10" aria-labelledby="inv-h">
              <h2 id="inv-h" className="text-xl">Invite someone</h2>
              <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}>
                <div className="w-72 max-w-full"><Field label="Email">{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" />}</Field></div>
                <div className="w-40"><Field label="Role">{(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>{invitable.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select>}</Field></div>
                <Button type="submit" variant="primary" loading={invite.isPending}>Send invitation</Button>
              </form>
              <p className="mt-2 text-xs text-ink-3">{ROLE_HELP[role]}</p>
              {invite.error && <div className="mt-3">{invite.error instanceof ApiError && invite.error.isPlanLimit ? <Notice tone="warn" title="Member limit reached" action={<Link to={`/w/${wsId}/usage`} className="btn btn-quiet btn-sm">See plans</Link>}>{invite.error.message}</Notice> : <ErrorNote error={invite.error} />}</div>}
            </section>
          )}

          {q.data.invitations.length > 0 && (
            <section className="mt-10" aria-labelledby="pend-h">
              <h2 id="pend-h" className="text-xl">Pending invitations</h2>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {q.data.invitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 py-3 text-sm" data-testid="invitation-row">
                    <span className="text-ink">{i.email}</span><Badge>{titleCase(i.role)}</Badge><span className="text-xs text-ink-3">expires {fmtDate(i.expiresAt)}</span>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => revoke.mutate(i.id)}>Withdraw</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-10 max-w-2xl" aria-labelledby="roles-h">
            <h2 id="roles-h" className="text-xl">What each role can do</h2>
            <dl className="mt-2 divide-y divide-line border-y border-line text-sm">{ROLES.map((r) => <div key={r} className="grid grid-cols-[6rem_1fr] gap-3 py-2.5"><dt className="font-medium text-ink">{titleCase(r)}</dt><dd className="text-ink-2">{ROLE_HELP[r]}</dd></div>)}</dl>
          </section>
        </>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} title={removing?.self ? "Leave this workspace?" : "Remove this member?"} confirmLabel={removing?.self ? "Leave workspace" : "Remove member"} danger loading={remove.isPending} onConfirm={() => removing && remove.mutate(removing.userId)}>
        {removing?.self ? "You'll lose access to its datasets immediately." : <><strong className="font-medium text-ink">{removing?.name}</strong> will lose access immediately and their sessions in this workspace end.</>}
        <ErrorNote className="mt-3" error={remove.error} />
      </ConfirmDialog>
    </div>
  );
}

/* -------------------------------------------- usage and plan -------------------------------------------- */

const nextPeriod = (iso: string) => { const d = new Date(iso); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };

export function UsagePage() {
  const { id: wsId, workspace, can } = useWorkspace();
  const cfg = useAuthConfig();
  const usage = useUsage(wsId, can("usage.read"));
  const billing = useBilling(wsId, can("billing.read"));
  const [sp] = useSearchParams();
  const toast = useToast();
  const checkout = useMutation({ mutationFn: (plan: string) => post<{ url: string }>(`/workspaces/${wsId}/billing/checkout`, { plan }), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => toast.error((e as Error).message) });
  const portal = useMutation({ mutationFn: () => post<{ url: string }>(`/workspaces/${wsId}/billing/portal`), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => toast.error((e as Error).message) });
  const u = usage.data;
  const billingOn = cfg.data?.billing;
  const isOwner = can("billing.manage");

  return (
    <div>
      <PageHeader title="Usage and plan" subtitle={`This workspace is on the ${workspace.plan.name} plan.${u ? ` Monthly allowances reset on ${fmtDate(nextPeriod(u.periodStart))}.` : ""}`} />
      {sp.get("checkout") === "success" && <Notice tone="good" className="mb-6" title="Thanks — your subscription is being activated">It can take a few seconds for the new plan to appear here.</Notice>}
      {sp.get("checkout") === "cancelled" && <Notice tone="info" className="mb-6">Checkout was cancelled. Nothing changed.</Notice>}

      <section aria-labelledby="use-h">
        <h2 id="use-h" className="sr-only">Usage this period</h2>
        {usage.isLoading && <Skeleton className="h-48" />}
        {usage.error && <QueryError error={usage.error} />}
        {u && (
          <div className="grid max-w-3xl gap-x-12 gap-y-5 sm:grid-cols-2" data-testid="usage-meters">
            <Meter label="Datasets" used={u.datasets.used} limit={u.datasets.limit} />
            <Meter label="Storage" used={u.storageBytes.used} limit={u.storageBytes.limit} format={fmtBytes} />
            <Meter label="Members" used={u.members.used} limit={u.members.limit} />
            <Meter label="AI answers this month" used={u.aiMessages.used} limit={u.aiMessages.limit} />
            <Meter label="Exports this month" used={u.exports.used} limit={u.exports.limit} />
          </div>
        )}
        {u && u.aiMessages.limit >= 0 && u.aiMessages.used >= u.aiMessages.limit && <p className="mt-4 max-w-prose text-sm text-ink-2">You've used this month's AI answers. Questions still work: you'll see the computed result without the AI's wording.</p>}
      </section>

      <section className="mt-12" aria-labelledby="plans-h">
        <h2 id="plans-h" className="text-xl">Plans</h2>
        <div className="mt-4 grid gap-0 divide-y divide-line border-y border-line md:grid-cols-3 md:divide-x md:divide-y-0">
          {(cfg.data?.plans ?? []).map((p) => {
            const current = p.id === workspace.plan.id;
            return (
              <div key={p.id} className="px-0 py-5 md:px-6 md:first:pl-0 md:last:pr-0" data-testid={`plan-${p.id}`}>
                <div className="flex items-baseline justify-between"><h3 className="text-xl">{p.name}</h3>{current && <Badge tone="thread">Current plan</Badge>}</div>
                <p className="mt-1"><span className="num font-serif text-3xl text-ink">${p.priceMonthlyUsd}</span><span className="text-sm text-ink-3"> per month</span></p>
                <ul className="mt-3 space-y-1 text-sm text-ink-2">
                  <li>{fmtLimit(p.limits.maxDatasets)} datasets</li>
                  <li>Files up to {fmtBytes(p.limits.maxUploadBytes)} and {fmtLimit(p.limits.maxRowsPerDataset)} rows</li>
                  <li>{fmtLimit(p.limits.maxMembers)} members</li>
                  <li>{fmtLimit(p.limits.aiMessagesPerMonth)} AI answers a month</li>
                  <li>{fmtLimit(p.limits.exportsPerMonth)} exports a month</li>
                  <li>{p.features.forecast ? "Forecasting" : "No forecasting"}{p.features.cohort ? ", cohort analysis" : ""}</li>
                </ul>
                {!current && p.priceMonthlyUsd > 0 && billingOn && isOwner && <Button className="mt-4" variant="primary" loading={checkout.isPending && checkout.variables === p.id} onClick={() => checkout.mutate(p.id)}>Switch to {p.name}</Button>}
              </div>
            );
          })}
        </div>
        {!billingOn && <p className="mt-3 text-sm text-ink-3">Online billing isn't enabled on this deployment. Ask your administrator to change the plan.</p>}
        {billingOn && !isOwner && <p className="mt-3 text-sm text-ink-3">Only the workspace owner can change the plan.</p>}
      </section>

      {billing.data?.enabled && (
        <section className="mt-12" aria-labelledby="bill-h">
          <h2 id="bill-h" className="text-xl">Billing</h2>
          {billing.data.subscription ? (
            <p className="mt-2 text-sm text-ink-2">Subscription is <strong className="font-medium text-ink">{billing.data.subscription.status}</strong>{billing.data.subscription.currentPeriodEnd && <> and {billing.data.subscription.cancelAtPeriodEnd ? "ends" : "renews"} on {fmtDate(billing.data.subscription.currentPeriodEnd)}</>}.</p>
          ) : <p className="mt-2 text-sm text-ink-2">No active subscription.</p>}
          {isOwner && billing.data.hasCustomer && <Button className="mt-3" loading={portal.isPending} onClick={() => portal.mutate()}>Manage billing and invoices</Button>}
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------- audit -------------------------------------------- */

const ACTION_LABEL: Record<string, string> = {
  "dataset.upload": "Uploaded a dataset", "dataset.create_demo": "Added the demo dataset", "dataset.processed": "Finished processing a dataset", "dataset.failed": "A dataset couldn't be processed",
  "dataset.delete": "Deleted a dataset", "dataset.rename": "Renamed a dataset", "dataset.reprocess": "Applied changes to a dataset", "dataset.export": "Exported data", "dataset.set_version": "Switched dataset version",
  "dashboard.save": "Saved a dashboard", "member.invite": "Invited a member", "member.invite_revoked": "Withdrew an invitation", "member.joined": "Member joined", "member.removed": "Removed a member",
  "member.left": "Left the workspace", "member.role_changed": "Changed a member's role", "workspace.create": "Created the workspace", "workspace.rename": "Renamed the workspace", "workspace.delete": "Deleted the workspace",
  "billing.event": "Billing update", "admin.set_plan": "Plan changed by a platform admin",
};

export function AuditPage() {
  const { id: wsId } = useWorkspace();
  const q = useAudit(wsId);
  return (
    <div>
      <PageHeader title="Audit log" subtitle="A permanent record of who did what in this workspace. Entries can't be edited or deleted." />
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <QueryError error={q.error} retry={() => void q.refetch()} />}
      {q.data && (q.data.length === 0 ? <p className="text-sm text-ink-2">Nothing recorded yet.</p> : (
        <div className="overflow-x-auto rounded-md border border-line bg-panel">
          <table className="w-full min-w-[40rem]" data-testid="audit-table">
            <thead className="thead"><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id} className="trow align-top">
                  <td className="whitespace-nowrap text-ink-2" title={fmtDateTime(e.createdAt)}>{fmtRelative(e.createdAt)}</td>
                  <td>{e.actor ? <>{e.actor.name || e.actor.email}</> : <span className="text-ink-3">System</span>}</td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="max-w-xs truncate text-xs text-ink-3">{e.meta && Object.keys(e.meta).length ? Object.entries(e.meta).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------- settings -------------------------------------------- */

export function SettingsPage() {
  const { id: wsId, workspace, can } = useWorkspace();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [confirm, setConfirm] = useState(""); const [deleting, setDeleting] = useState(false);
  const rename = useMutation({ mutationFn: () => patch(`/workspaces/${wsId}`, { name }), onSuccess: async () => { toast.success("Workspace renamed."); await qc.invalidateQueries({ queryKey: ["ws", wsId] }); await qc.invalidateQueries({ queryKey: meKey }); } });
  const del_ = useMutation({ mutationFn: () => api(`/workspaces/${wsId}`, { method: "DELETE", body: { confirm } }), onSuccess: async () => { setDeleting(false); await refresh(); nav("/app", { replace: true }); } });
  return (
    <div className="max-w-xl">
      <PageHeader title="Settings" />
      <section aria-labelledby="ws-name-h">
        <h2 id="ws-name-h" className="text-xl">Workspace name</h2>
        <form className="mt-3 flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
          <div className="flex-1"><Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} disabled={!can("workspace.update")} onChange={(e) => setName(e.target.value)} />}</Field></div>
          {can("workspace.update") && <Button type="submit" variant="primary" disabled={!name.trim() || name === workspace.name} loading={rename.isPending}>Save</Button>}
        </form>
        <ErrorNote className="mt-3" error={rename.error} />
      </section>
      <section className="mt-12 border-t border-line pt-6" aria-labelledby="danger-h">
        <h2 id="danger-h" className="text-xl">Delete workspace</h2>
        <p className="mt-1 text-sm text-ink-2">Permanently deletes the workspace, every dataset in it, all conversations and dashboards, and removes all members. This can't be undone.</p>
        {can("workspace.delete") ? <Button className="mt-3" variant="danger" onClick={() => setDeleting(true)}>Delete this workspace</Button> : <p className="mt-3 text-sm text-ink-3">Only the owner can delete a workspace.</p>}
      </section>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title="Delete this workspace?" confirmLabel="Delete forever" danger loading={del_.isPending} onConfirm={() => del_.mutate()}>
        <p>Type <strong className="font-medium text-ink">{workspace.name}</strong> to confirm.</p>
        <div className="mt-3"><Input aria-label="Workspace name confirmation" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        <ErrorNote className="mt-3" error={del_.error} />
      </ConfirmDialog>
    </div>
  );
}
