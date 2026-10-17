import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { authorize } from '../permissions.js';
import { currentUser, requireAuth } from '../auth/routes.js';
import { findItem } from './repository.js';

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

export async function itemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/items/:id', async (request) => {
    const user = currentUser(request);
    const { id } = IdParams.parse(request.params);
    const item = await findItem(pool, id);
    // "Does not exist" and "exists in a team you're not in" look identical.
    if (!item) throw new NotFoundError();
    authorize(user, 'item.view', item);
    return item;
  });
}
