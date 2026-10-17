// "What needs my attention?" — four short, focused queues instead of one long list.
// Each queue is one indexed query with a small limit, plus its total.
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { currentUser, requireAuth } from '../auth/routes.js';
import { ITEM_SELECT } from '../items/repository.js';
import type { AuthUser, Role } from '../permissions.js';

const LIMIT = 8;
const ACTIVE = `('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL')`;

const teamsWhere = (user: AuthUser, roles: Role[]) =>
  [...user.roles.entries()].filter(([, r]) => roles.includes(r)).map(([id]) => id);

async function queue(where: string, params: unknown[], orderBy: string) {
  const [items, total] = await Promise.all([
    pool.query(`${ITEM_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ${LIMIT}`, params),
    pool.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${where}`, params),
  ]);
  return { items: items.rows, total: total.rows[0].n };
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/dashboard', async (request) => {
    const user = currentUser(request);
    const all = teamsWhere(user, ['viewer', 'member', 'lead']);
    const workers = teamsWhere(user, ['member', 'lead']);
    const leads = teamsWhere(user, ['lead']);
    const byUrgency = 'w.priority_rank, w.due_at NULLS LAST, w.id';

    const [mine, approvals, unclaimed, overdue] = await Promise.all([
      // Work I own that isn't finished.
      queue(`w.assignee_id = $1 AND w.status IN ('IN_PROGRESS', 'AWAITING_APPROVAL')`, [user.id], byUrgency),
      // Requests waiting for me as a lead (never my own: four-eyes).
      queue(
        `w.team_id = ANY($1::bigint[]) AND w.status = 'AWAITING_APPROVAL' AND w.approval_requested_by <> $2`,
        [leads, user.id], 'w.updated_at, w.id',
      ),
      // Urgent work nobody has taken, in teams where I can take it.
      queue(
        `w.team_id = ANY($1::bigint[]) AND w.status = 'OPEN' AND w.assignee_id IS NULL AND w.priority_rank <= 2`,
        [workers], byUrgency,
      ),
      // Anything active in my teams that is past its due date.
      queue(
        `w.team_id = ANY($1::bigint[]) AND w.status IN ${ACTIVE} AND w.due_at < now()`,
        [all], 'w.due_at, w.id',
      ),
    ]);
    return { mine, approvals, unclaimed, overdue };
  });
}
