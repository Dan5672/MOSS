// The job queue's own Postgres role (packages/db/src/roles.ts): it takes over a queue schema made before, and pg-boss
// keeps working as that role, which sees nothing outside its schema.
import { ensureQueues, RUN_QUEUE } from "@moss/agent";
import { applyServiceRoles, createDb, SERVICE_ROLES } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";

describe.skipIf(!TEST_DATABASE_URL)("queue role (postgres)", () => {
  it("owns the queue after the roles are applied, and can't read MOSS's tables", async () => {
    const { db, url, close } = await createTestDb("worker_queue_role");
    try {
      await db.$client.unsafe("drop schema if exists pgboss cascade");
      // An install from before the roles: pg-boss made its schema as the database owner.
      const before = new PgBoss(url);
      await before.start();
      await ensureQueues(before);
      await before.stop();

      const passwords = Object.fromEntries(SERVICE_ROLES.map((r) => [r, `test-${r}-password`])) as Record<(typeof SERVICE_ROLES)[number], string>;
      await applyServiceRoles(db.$client, passwords);
      const u = new URL(url);
      u.username = "moss_queue";
      u.password = passwords.queue;
      const boss = new PgBoss(u.toString());
      await boss.start();
      await ensureQueues(boss);
      await boss.createQueue("role-test");
      const id = await boss.send(RUN_QUEUE, { hello: 1 });
      expect(id).toBeTruthy();
      const [job] = await boss.fetch(RUN_QUEUE);
      expect(job?.data).toEqual({ hello: 1 });
      await boss.stop();

      const queue = createDb(u.toString()).$client;
      await expect(queue`select * from public.agents`).rejects.toThrow(/permission denied/);
      // A schema named after another service's role would come first in its search path: none may be made.
      await expect(queue`create schema moss_web`).rejects.toThrow(/permission denied/);
      await queue.end();
    } finally {
      await close();
    }
  });
});
