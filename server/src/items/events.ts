import type { PoolClient } from 'pg';

export type EventType =
  | 'created' | 'updated' | 'status_changed' | 'assigned' | 'unassigned'
  | 'priority_changed' | 'approval_requested' | 'approved' | 'rejected' | 'commented';

export interface NewEvent {
  type: EventType;
  payload: Record<string, unknown>;
}

/** Events that someone should be told about. The worker decides who. */
const NOTIFYING: ReadonlySet<EventType> = new Set([
  'assigned', 'unassigned', 'approval_requested', 'approved', 'rejected', 'commented', 'status_changed',
]);

/**
 * Appends to the item's history, and for events that notify people, queues a
 * job for the background worker (the "transactional outbox").
 *
 * Always called with the transaction of the change it describes, so the change,
 * its history entry and its notification job commit together or not at all:
 *   • history can never disagree with the data;
 *   • a notification is never lost (the change committed → the job exists);
 *   • a notification is never sent for a change that rolled back.
 */
export async function recordEvent(
  tx: PoolClient,
  workItemId: number,
  actorId: number,
  event: NewEvent,
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO activity_events (work_item_id, actor_id, type, payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [workItemId, actorId, event.type, JSON.stringify(event.payload)],
  );
  const eventId = rows[0].id;
  if (NOTIFYING.has(event.type)) {
    await tx.query(`INSERT INTO outbox_jobs (type, payload) VALUES ('notify', $1)`, [
      JSON.stringify({ event_id: eventId }),
    ]);
  }
  return eventId;
}
