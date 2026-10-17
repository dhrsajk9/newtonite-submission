import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { UnauthenticatedError } from '../errors.js';
import type { AuthUser } from '../permissions.js';
import { SESSION_COOKIE, createSession, deleteSession, userForSession } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Route guard: attach to any route that needs a logged-in user.
 * Sets `request.user`, or responds 401.
 */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  const user = token ? await userForSession(token) : null;
  if (!user) throw new UnauthenticatedError();
  request.user = user;
}

/** Use inside handlers protected by requireAuth. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new UnauthenticatedError();
  return request.user;
}

const LoginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

// A real bcrypt hash of a random string. Comparing against it when the email is
// unknown makes "wrong email" take as long as "wrong password", so response time
// does not reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

async function describeUser(user: AuthUser) {
  const { rows } = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM teams WHERE id = ANY($1::bigint[]) ORDER BY name',
    [[...user.roles.keys()]],
  );
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    teams: rows.map((t) => ({ id: t.id, name: t.name, role: user.roles.get(t.id) })),
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (request, reply: FastifyReply) => {
    const { email, password } = LoginBody.parse(request.body);
    const { rows } = await pool.query<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const valid = await bcrypt.compare(password, rows[0]?.password_hash ?? DUMMY_HASH);
    // Same message whether the email or the password was wrong.
    if (!rows[0] || !valid) throw new UnauthenticatedError('Incorrect email or password.');

    const { token, expiresAt } = await createSession(rows[0].id);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,      // JavaScript in the page cannot read it (limits XSS damage)
      sameSite: 'lax',     // not sent on cross-site POSTs (CSRF protection)
      secure: config.secureCookies,
      expires: expiresAt,
    });
    const user = (await userForSession(token))!;
    return describeUser(user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => describeUser(currentUser(request)));
}
