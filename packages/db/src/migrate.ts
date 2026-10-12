import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { applyServiceRoles, SERVICE_ROLES, type ServiceRole } from "./roles.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { max: 1, onnotice: () => {} });
await migrate(drizzle(client), {
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
});
// The job queue's schema. pg-boss fills it but never makes it (openQueue in packages/agent/src/queue.ts), because the
// queue's role may not create schemas.
await client.unsafe("CREATE SCHEMA IF NOT EXISTS pgboss");
// Installs from deploy/init.sh give each service its own role; without the passwords (development), nothing changes.
const passwords = Object.fromEntries(SERVICE_ROLES.map((r) => [r, process.env[`MOSS_DB_PASSWORD_${r.toUpperCase()}`] ?? ""])) as Record<ServiceRole, string>;
if (Object.values(passwords).every(Boolean)) {
  await applyServiceRoles(client, passwords);
  console.log("service roles applied");
}
await client.end();
console.log("migrations applied");
