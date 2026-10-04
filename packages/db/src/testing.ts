// Test helper: gives each test suite its own database (<MOSS_TEST_DATABASE_URL db>_<suite>),
// so packages can run their integration tests in parallel. Applies migrations and truncates
// all tables. Integration tests skip themselves when MOSS_TEST_DATABASE_URL is not set.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema.js";

export const TEST_DATABASE_URL = process.env.MOSS_TEST_DATABASE_URL;

async function ensureDatabase(baseUrl: string, suite: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(suite)) throw new Error("Suite name must be lowercase alphanumeric");
  const url = new URL(baseUrl);
  const name = `${url.pathname.slice(1)}_${suite}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) await admin.unsafe(`create database "${name}"`);
  } catch (err) {
    // Two suites racing to create the same database: the loser can carry on.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  return url.toString();
}

export async function createTestDb(suite: string) {
  if (!TEST_DATABASE_URL) throw new Error("MOSS_TEST_DATABASE_URL is not set");
  const url = await ensureDatabase(TEST_DATABASE_URL, suite);
  const client = postgres(url, { max: 5, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  return { db, url, close: () => client.end() };
}
