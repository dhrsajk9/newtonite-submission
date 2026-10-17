// The "notify" job: turns one activity event into in-app notifications.
//
// Who is told is decided here, when the job runs, from the event and the item.
// The person who acted is never notified about their own action.
//
// Safe to run more than once for the same event: notifications have a UNIQUE
// (user_id, event_id) constraint and we insert with ON CONFLICT DO NOTHING, so a
// repeat run changes nothing. This is what makes at-least-once delivery safe.
import type { PoolClient } from 'pg';

interface EventRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  actor_id: number;
  actor_name: string;
  work_item_id: number;
  title: string;
  team_id: number;
  assignee_id: number | null;
  created_by: number;
}

const quote = (t: string) => `“${t.length > 60 ? `${t.slice(0, 57)}…` : t}”`;
const STATUS_WORDS: Record<string, string> = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', AWAITING_APPROVAL: 'Awaiting approval', RESOLVED: 'Resolved', CLOSED: 'Closed',
};

async function teamLeads(tx: PoolClient, teamId: number): Promise<number[]> {
  const { rows } = await tx.query(`SELECT user_id FROM team_memberships WHERE team_id = $1 AND role = 'lead'`, [teamId]);
  return rows.map((r) => r.user_id);
}

/** Who should hear about this event, and what to tell them. */
async function plan(tx: PoolClient, e: EventRow): Promise<{ recipients: number[]; message: string }> {
  const p = e.payload;
  const who = e.actor_name;
  const what = quote(e.title);
  switch (e.type) {
    case 'assigned':
      return { recipients: [p.assignee_id as number], message: `${who} assigned you ${what}` };
    case 'unassigned':
      return { recipients: [p.previous_assignee_id as number], message: `${who} unassigned you from ${what}` };
    case 'approval_requested':
      return { recipients: await teamLeads(tx, e.team_id), message: `${who} asked for your approval on ${what}` };
    case 'approved':
      return { recipients: [p.requested_by as number], message: `${who} approved ${what}` };
    case 'rejected':
      return { recipients: [p.requested_by as number], message: `${who} rejected ${what}: ${p.reason}` };
    case 'commented':
      return { recipients: [e.assignee_id, e.created_by].filter((x): x is number => x !== null), message: `${who} commented on ${what}` };
    case 'status_changed':
      return {
        recipients: e.assignee_id ? [e.assignee_id] : [],
        message: `${who} moved ${what} to ${STATUS_WORDS[p.to_status as string] ?? p.to_status}`,
      };
    default:
      return { recipients: [], message: '' };
  }
}

export async function handleNotify(tx: PoolClient, payload: { event_id: number }): Promise<void> {
  const { rows } = await tx.query<EventRow>(
    `SELECT e.id, e.type, e.payload, e.actor_id, u.name AS actor_name, e.work_item_id,
            w.title, w.team_id, w.assignee_id, w.created_by
       FROM activity_events e
       JOIN users u ON u.id = e.actor_id
       JOIN work_items w ON w.id = e.work_item_id
      WHERE e.id = $1`,
    [payload.event_id],
  );
  if (!rows[0]) throw new Error(`Event ${payload.event_id} not found`);
  const event = rows[0];

  const { recipients, message } = await plan(tx, event);
  const unique = [...new Set(recipients)].filter((id) => id && id !== event.actor_id);
  for (const userId of unique) {
    await tx.query(
      `INSERT INTO notifications (user_id, work_item_id, event_id, message)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [userId, event.work_item_id, event.id, message],
    );
  }
}
