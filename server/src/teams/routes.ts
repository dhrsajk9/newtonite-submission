import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { currentUser, requireAuth } from '../auth/routes.js';
import { IdParams } from '../items/routes.js';

export async function teamRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Members of a team you belong to (used for "assign to" pickers).
  app.get('/api/teams/:id/members', async (request) => {
    const user = currentUser(request);
    const { id } = IdParams.parse(request.params);
    if (!user.roles.has(id)) throw new NotFoundError('Team');
    const { rows } = await pool.query(
      `SELECT u.id, u.name, m.role FROM team_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1 ORDER BY u.name`,
      [id],
    );
    return rows;
  });
}
