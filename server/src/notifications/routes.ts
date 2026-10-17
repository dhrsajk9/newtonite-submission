import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { currentUser, requireAuth } from '../auth/routes.js';
import { IdParams } from '../items/routes.js';

const ListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Your latest notifications plus the unread count (for the bell icon).
  app.get('/api/notifications', async (request) => {
    const user = currentUser(request);
    const q = ListQuery.parse(request.query);
    const { rows } = await pool.query(
      `SELECT id, work_item_id, event_id, message, read_at, created_at
         FROM notifications
        WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
        ORDER BY id DESC
        LIMIT $3`,
      [user.id, q.unread === 'true', q.limit],
    );
    const unread = await pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );
    return { notifications: rows, unreadCount: unread.rows[0].n };
  });

  // Mark one as read. Someone else's notification → 404, like any other resource you can't see.
  app.post('/api/notifications/:id/read', async (request) => {
    const user = currentUser(request);
    const { id } = IdParams.parse(request.params);
    const { rowCount } = await pool.query(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2',
      [id, user.id],
    );
    if (rowCount === 0) throw new NotFoundError('Notification');
    return { ok: true };
  });

  app.post('/api/notifications/read-all', async (request) => {
    const user = currentUser(request);
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
    return { ok: true };
  });
}
