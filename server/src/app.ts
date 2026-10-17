import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ZodError } from 'zod';
import { pool } from './db/pool.js';
import { AppError } from './errors.js';
import { authRoutes } from './auth/routes.js';
import { itemRoutes } from './items/routes.js';
import { teamRoutes } from './teams/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { dashboardRoutes } from './dashboard/routes.js';

// Builds the HTTP app without starting it, so tests can call routes directly
// with `app.inject()` instead of opening a real port.
export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.register(cookie);

  // ─── Central error handler ────────────────────────────────────────────────
  // Routes throw; this turns every error into the same JSON shape.
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request is invalid.',
          fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    // Errors Fastify raises itself (malformed JSON, unsupported content type, ...)
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    // Anything else is a bug: log everything, reveal nothing.
    request.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  // The built web app (when present) is served from the same origin as the API,
  // so the session cookie just works and no CORS setup is needed.
  // Files are looked up when requested (the default `wildcard: true`), so a rebuilt
  // web app is picked up without restarting the server.
  const hasWebApp = existsSync(path.join(config.publicDir, 'index.html'));
  if (hasWebApp) app.register(fastifyStatic, { root: path.resolve(config.publicDir) });

  app.setNotFoundHandler((request, reply) => {
    // Browser routes like /items/42 are handled by the web app: send it index.html.
    // A missing FILE (anything with an extension, e.g. /assets/old.js) gets a real
    // 404 instead, so the browser never tries to run an HTML page as JavaScript.
    const pathname = request.url.split('?')[0];
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    if (hasWebApp && request.method === 'GET' && !pathname.startsWith('/api/') && !looksLikeFile) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  // Health check: proves the API is up and can reach the database, and shows
  // whether background jobs are keeping up (pending) or failing for good (dead).
  app.get('/api/health', async () => {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM users)::int       AS users,
             (SELECT count(*) FROM teams)::int       AS teams,
             (SELECT count(*) FROM work_items)::int  AS work_items`);
    const jobs = await pool.query(`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             count(*) FILTER (WHERE status = 'dead')::int    AS dead,
             EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int AS oldest_pending_seconds
        FROM outbox_jobs`);
    return { status: 'ok', database: 'reachable', counts: rows[0], jobs: jobs.rows[0] };
  });

  app.register(authRoutes);
  app.register(itemRoutes);
  app.register(teamRoutes);
  app.register(notificationRoutes);
  app.register(dashboardRoutes);

  return app;
}
