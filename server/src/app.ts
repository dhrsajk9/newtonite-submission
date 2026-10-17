import Fastify from 'fastify';
import { pool } from './db/pool.js';

// Builds the HTTP app without starting it, so tests can call routes directly
// with `app.inject()` instead of opening a real port.
export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // Health check: proves the API is up and can reach the database.
  app.get('/api/health', async () => {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM users)::int       AS users,
             (SELECT count(*) FROM teams)::int       AS teams,
             (SELECT count(*) FROM work_items)::int  AS work_items`);
    return { status: 'ok', database: 'reachable', counts: rows[0] };
  });

  return app;
}
