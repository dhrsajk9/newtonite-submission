import type { Db } from '../db/pool.js';
import { ValidationError } from '../errors.js';

export interface WorkItem {
  id: number;
  team_id: number;
  team_name: string;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  assignee_id: number | null;
  assignee_name: string | null;
  created_by: number;
  created_by_name: string;
  approval_requested_by: number | null;
  next_step: string;
  due_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

// Shared SELECT so every endpoint returns items in the same shape.
export const ITEM_SELECT = `
  SELECT w.id, w.team_id, t.name AS team_name, w.title, w.description, w.type, w.status,
         w.priority, w.assignee_id, a.name AS assignee_name, w.created_by, c.name AS created_by_name,
         w.approval_requested_by, w.next_step, w.due_at, w.version, w.created_at, w.updated_at
    FROM work_items w
    JOIN teams t ON t.id = w.team_id
    JOIN users c ON c.id = w.created_by
    LEFT JOIN users a ON a.id = w.assignee_id`;

export async function findItem(db: Db, id: number): Promise<WorkItem | null> {
  const { rows } = await db.query<WorkItem>(`${ITEM_SELECT} WHERE w.id = $1`, [id]);
  return rows[0] ?? null;
}

// ─── Listing with keyset (cursor) pagination ─────────────────────────────────
//
// Sorted by (updated_at DESC, id DESC). The cursor is the sort key of the last
// row on the page; the next page is "rows strictly after that key". Unlike
// OFFSET, this is equally fast on page 1 and page 500, and rows inserted or
// updated while paging never cause duplicates or skipped rows.
//
// The timestamp is carried as Postgres text, not a JavaScript Date: Postgres
// stores microseconds, JavaScript only milliseconds, and the lost precision
// would make the cursor skip rows.

export interface ListFilters {
  teamIds: number[];          // already restricted to the user's teams
  statuses?: string[];
  priorities?: string[];
  types?: string[];
  assignee?: 'me' | 'unassigned' | number;
  q?: string;
  limit: number;
  cursor?: string;
}

interface Cursor { u: string; id: number }

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.u === 'string' && Number.isInteger(c.id)) return c;
  } catch { /* fall through */ }
  throw new ValidationError('Invalid cursor.');
}

export async function listItems(db: Db, currentUserId: number, f: ListFilters) {
  const where: string[] = ['w.team_id = ANY($1::bigint[])'];
  const params: unknown[] = [f.teamIds];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (f.statuses?.length) add('w.status = ANY(?::text[])', f.statuses);
  if (f.priorities?.length) add('w.priority = ANY(?::text[])', f.priorities);
  if (f.types?.length) add('w.type = ANY(?::text[])', f.types);
  if (f.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (f.assignee === 'me') add('w.assignee_id = ?', currentUserId);
  else if (typeof f.assignee === 'number') add('w.assignee_id = ?', f.assignee);
  if (f.q) add(`w.search_vector @@ websearch_to_tsquery('english', ?)`, f.q);
  if (f.cursor) {
    const c = decodeCursor(f.cursor);
    params.push(c.u, c.id);
    where.push(`(w.updated_at, w.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }

  // Fetch one extra row to know whether another page exists.
  params.push(f.limit + 1);
  const { rows } = await db.query<WorkItem & { cursor_ts: string }>(
    `SELECT * FROM (
       ${ITEM_SELECT.replace('SELECT w.id,', 'SELECT w.updated_at::text AS cursor_ts, w.id,')}
       WHERE ${where.join(' AND ')}
       ORDER BY w.updated_at DESC, w.id DESC
       LIMIT $${params.length}
     ) page`,
    params,
  );

  const hasMore = rows.length > f.limit;
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ cursor_ts: _ignored, ...item }) => item),
    nextCursor: hasMore && last ? encodeCursor({ u: last.cursor_ts, id: last.id }) : null,
  };
}

// ─── Activity timeline ───────────────────────────────────────────────────────

export async function listActivity(db: Db, itemId: number, limit: number, beforeId?: number) {
  const { rows } = await db.query(
    `SELECT e.id, e.type, e.payload, e.created_at, e.actor_id, u.name AS actor_name
       FROM activity_events e JOIN users u ON u.id = e.actor_id
      WHERE e.work_item_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
      ORDER BY e.id DESC
      LIMIT $3`,
    [itemId, beforeId ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { events: page, nextCursor: hasMore ? String(page[page.length - 1].id) : null };
}
