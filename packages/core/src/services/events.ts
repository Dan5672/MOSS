// Transactional outbox. Services write events in the same transaction as the state change;
// the worker claims and dispatches them (FOR UPDATE SKIP LOCKED, so several workers can share).
import { events, type Database } from "@moss/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";

export type DomainEvent =
  | { type: "incident.created"; payload: { incidentId: string; priority: string } }
  | { type: "incident.assigned"; payload: { incidentId: string; agentId?: string; userId?: string } }
  | { type: "change.submitted"; payload: { changeId: string } }
  | { type: "change.approved"; payload: { changeId: string } }
  | { type: "change.rejected"; payload: { changeId: string } }
  | { type: "change.completed"; payload: { changeId: string; outcome: string } };

/** Anything with insert(): the database or an open transaction. */
type Writer = Pick<Database, "insert">;

export async function emitEvent(db: Writer, orgId: string, event: DomainEvent) {
  await db.insert(events).values({ orgId, type: event.type, payload: event.payload });
}

export type StoredEvent = typeof events.$inferSelect;

const MAX_ATTEMPTS = 5;

/**
 * Claims up to `limit` pending events and runs the handler for each inside its own transaction.
 * A handler error is recorded and the event retried later with backoff, up to MAX_ATTEMPTS.
 */
export async function dispatchEvents(db: Database, handler: (e: StoredEvent) => Promise<void>, limit = 20): Promise<number> {
  let handled = 0;
  for (let i = 0; i < limit; i++) {
    const done = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(isNull(events.processedAt), lt(events.attempts, MAX_ATTEMPTS), lte(events.availableAt, new Date())))
        .orderBy(asc(events.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!event) return false;
      try {
        await handler(event);
        await tx.update(events).set({ processedAt: new Date(), attempts: event.attempts + 1, lastError: null }).where(eq(events.id, event.id));
      } catch (err) {
        await tx
          .update(events)
          .set({
            attempts: event.attempts + 1,
            lastError: String((err as Error).message ?? err).slice(0, 1000),
            // Exponential backoff: 10s, 20s, 40s, ...
            availableAt: new Date(Date.now() + 10_000 * 2 ** event.attempts),
          })
          .where(eq(events.id, event.id));
      }
      return true;
    });
    if (!done) break;
    handled++;
  }
  return handled;
}
