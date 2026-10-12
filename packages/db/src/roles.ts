// One Postgres role per service, so a compromised container can only do what its service needs. Run by the migrate
// step (as the database owner) after the migrations, so tables added later get the same grants. The guards in
// migration 0030 cover the few trusted records the worker and the chat bridge must still write.
import type { Sql } from "postgres";

export const SERVICE_ROLES = ["gate", "web", "worker", "bridge", "backup", "queue"] as const;
export type ServiceRole = (typeof SERVICE_ROLES)[number];

// Records only people (through the web app) or the gate change: the worker and the bridge may read them.
const PEOPLE_ONLY = [
  "secrets",
  "secret_grants",
  "agent_tool_overrides",
  "custom_tool_grants",
  "custom_tools",
  "budgets",
  "roles",
  "role_permissions",
  "user_roles",
  "orgs",
  "sessions",
  "standard_change_templates",
  "providers",
  "models",
  "sites",
  "users",
  "agents",
  "networks",
  // Skills decide which tools an agent may call; the gate keeps the library's in step.
  "skills",
  "agent_skills",
  "agent_schedules",
  "integration_tokens",
  // Which certificate or host key a device should present; only the gate learns them, only people change them.
  "host_pins",
];

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Creates the roles (or resets their passwords) and grants each one what its service needs. */
export async function applyServiceRoles(sql: Sql, passwords: Record<ServiceRole, string>) {
  const [row] = await sql<{ db: string }[]>`select current_database() as db`;
  const db = row!.db;
  for (const name of SERVICE_ROLES) {
    const role = `moss_${name}`;
    // Roles belong to the whole server: another database (a test suite) may be creating the same one right now.
    await sql.unsafe(`DO $$ BEGIN CREATE ROLE ${role} LOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(passwords[name])}`);
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${role}`);
  }
  const app = "moss_gate, moss_web, moss_worker, moss_bridge";
  await sql.unsafe(`
    GRANT USAGE ON SCHEMA public TO ${app};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};
    -- The audit log only grows.
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${app};
    REVOKE INSERT, UPDATE, DELETE ON ${PEOPLE_ONLY.join(", ")} FROM moss_worker, moss_bridge;
    REVOKE INSERT, UPDATE, DELETE ON change_approvals, chat_links, chat_link_codes FROM moss_worker;
    -- What the worker still writes there: a person's "welcomed" flag, pausing an agent at its budget, a reported network.
    GRANT UPDATE (preferences, updated_at) ON users TO moss_worker;
    GRANT UPDATE (status, paused_reason, updated_at) ON agents TO moss_worker;
    GRANT INSERT ON networks TO moss_worker;
    -- Usage only grows (deleting it would reset budgets); an integration's state is the worker's, not whether it's on.
    REVOKE UPDATE, DELETE ON token_usage FROM moss_worker, moss_bridge;
    REVOKE INSERT, UPDATE, DELETE ON modules FROM moss_worker;
    GRANT INSERT (org_id, key, state), UPDATE (state) ON modules TO moss_worker;
    -- Backups read everything and write nothing.
    GRANT pg_read_all_data TO moss_backup;
    -- The job queue (pg-boss) keeps its own schema, made here for its role, which sees nothing else. No role may
    -- create schemas: one named after another role would come first in that role's search path.
    CREATE SCHEMA IF NOT EXISTS pgboss;
    REVOKE CREATE ON DATABASE "${db}" FROM moss_queue;
  `);
  for (const name of SERVICE_ROLES) await sql.unsafe(`ALTER ROLE moss_${name} SET search_path = ${name === "queue" ? "pgboss" : "public"}`);
  // A schema pg-boss made before (an older install, or a restore, which leaves everything to the owner) passes to it.
  await sql.unsafe(`
    DO $$ DECLARE r record; BEGIN
      IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'pgboss') THEN
        ALTER SCHEMA pgboss OWNER TO moss_queue;
        FOR r IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'v') LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO moss_queue', r.name);
        END LOOP;
        FOR r IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'pgboss' LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO moss_queue', r.name);
        END LOOP;
        FOR r IN SELECT t.oid::regtype AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'pgboss' AND t.typtype = 'e' LOOP
          EXECUTE format('ALTER TYPE %s OWNER TO moss_queue', r.name);
        END LOOP;
      END IF;
    END $$;
  `);
}
