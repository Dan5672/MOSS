// Permissions and built-in roles. Agents use the same permission system as humans,
// except that HUMAN_ONLY permissions can never be granted to an agent.

export const PERMISSIONS = [
  "dashboard.read",
  "agents.read",
  "agents.manage", // hire, pause, fire, upskill
  "agents.chat", // talk to agents (each message starts a run)
  "agents.budget",
  "models.manage",
  "skills.manage",
  "tools.manage", // upload, edit and grant custom tools
  "assets.read",
  "assets.manage",
  "networks.read",
  "networks.manage", // includes marking subnets allowed / off-limits
  "incidents.read",
  "incidents.manage",
  "changes.read",
  "changes.create",
  "changes.approve",
  "monitoring.read",
  "monitoring.manage", // monitors and webhook sources
  "knowledge.read",
  "knowledge.manage", // write and delete knowledge base notes
  "notifications.send", // agents: send a notification to the person they report to
  "secrets.read", // metadata only; values are never readable
  "secrets.manage",
  "integrations.manage",
  "dev.read",
  "dev.manage",
  "users.manage",
  "settings.manage",
  "audit.read",
  "killswitch.use",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const HUMAN_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "changes.approve",
  "networks.manage",
  "secrets.manage",
  "users.manage",
  "settings.manage",
  "agents.manage",
  "agents.chat",
  "agents.budget",
  "models.manage",
  "skills.manage",
  "tools.manage",
  "integrations.manage",
  "killswitch.use",
]);

const READS: Permission[] = PERMISSIONS.filter((p) => p.endsWith(".read"));

export const BUILT_IN_ROLES: Record<string, { name: string; permissions: Permission[] }> = {
  owner: { name: "Owner", permissions: [...PERMISSIONS] },
  // Admin differs from Owner only in user management rules (an admin cannot remove or demote an owner).
  admin: { name: "Admin", permissions: [...PERMISSIONS] },
  change_approver: {
    name: "Change Approver",
    permissions: [...READS, "incidents.manage", "changes.create", "changes.approve"],
  },
  operator: {
    name: "Operator",
    permissions: [...READS, "agents.chat", "incidents.manage", "changes.create", "assets.manage", "monitoring.manage", "knowledge.manage", "dev.manage", "killswitch.use"],
  },
  viewer: { name: "Viewer", permissions: [...READS] },
  agent: {
    name: "Agent",
    permissions: [
      "agents.read",
      "assets.read",
      "assets.manage",
      "networks.read",
      "incidents.read",
      "incidents.manage",
      "changes.read",
      "changes.create",
      "monitoring.read",
      "knowledge.read",
      "knowledge.manage",
      "notifications.send",
      "dev.read",
      "dev.manage",
    ],
  },
};

export function effectivePermissions(granted: Iterable<string>, actor: "user" | "agent"): Set<Permission> {
  const known = new Set<string>(PERMISSIONS);
  const out = new Set<Permission>();
  for (const p of granted) {
    if (!known.has(p)) continue;
    if (actor === "agent" && HUMAN_ONLY_PERMISSIONS.has(p as Permission)) continue;
    out.add(p as Permission);
  }
  return out;
}

export function can(perms: ReadonlySet<Permission>, needed: Permission): boolean {
  return perms.has(needed);
}
