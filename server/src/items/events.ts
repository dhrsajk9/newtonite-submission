import type { PoolClient } from 'pg';

export type EventType =
  | 'created' | 'updated' | 'status_changed' | 'assigned' | 'unassigned'
  | 'priority_changed' | 'approval_requested' | 'approved' | 'rejected' | 'commented';

export interface NewEvent {
  type: EventType;
  payload: Record<string, unknown>;
}

/**
 * Appends to the item's history. Always called with the transaction client of
 * the change it describes, so the change and its history commit together or
 * not at all: history can never disagree with the data.
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
  return rows[0].id;
}
