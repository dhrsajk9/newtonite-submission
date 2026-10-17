import type { Db } from '../db/pool.js';

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
