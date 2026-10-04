import "server-only";
import { createDb, type Database } from "@moss/db";

const globalForDb = globalThis as { __mossDb?: Database };

/** One connection pool per server process (dev hot reloads reuse it). Lazy so builds don't need a database. */
export function db(): Database {
  globalForDb.__mossDb ??= createDb();
  return globalForDb.__mossDb;
}
