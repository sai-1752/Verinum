/** Role permissions. The single source of truth: routes call `can`, the UI reads the same matrix from /me. */
export type Role = "owner" | "admin" | "analyst" | "viewer";

export const ROLES: Role[] = ["owner", "admin", "analyst", "viewer"];

const M = {
  "workspace.read": ["owner", "admin", "analyst", "viewer"],
  "workspace.update": ["owner", "admin"],
  "workspace.delete": ["owner"],
  "billing.manage": ["owner"],
  "billing.read": ["owner", "admin"],
  "member.read": ["owner", "admin", "analyst", "viewer"],
  "member.invite": ["owner", "admin"],
  "member.remove": ["owner", "admin"],
  "member.role": ["owner", "admin"],
  "dataset.read": ["owner", "admin", "analyst", "viewer"],
  "dataset.create": ["owner", "admin", "analyst"],
  "dataset.update": ["owner", "admin", "analyst"],
  "dataset.delete": ["owner", "admin", "analyst"],
  "dataset.export": ["owner", "admin", "analyst"],
  "dashboard.save": ["owner", "admin", "analyst"],
  "chat.ask": ["owner", "admin", "analyst", "viewer"],
  "audit.read": ["owner", "admin"],
  "usage.read": ["owner", "admin", "analyst"],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof M;

export function can(role: Role, action: Action): boolean {
  return (M[action] as readonly Role[]).includes(role);
}

export function permissionsFor(role: Role): Action[] {
  return (Object.keys(M) as Action[]).filter((a) => can(role, a));
}

/** Who may assign or remove a given role: admins manage analysts/viewers, only owners manage admins/owners. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target === "analyst" || target === "viewer";
  return false;
}
