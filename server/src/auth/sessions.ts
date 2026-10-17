import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import type { AuthUser, Role } from '../permissions.js';

export const SESSION_COOKIE = 'sid';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates a session and returns the raw token to put in the cookie. */
export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url'); // 256 bits, unguessable
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hash(token),
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
}

/**
 * Looks up the user for a session token, including their role in every team.
 * Roles are read fresh on each request, so a role change applies immediately.
 */
export async function userForSession(token: string): Promise<AuthUser | null> {
  const { rows } = await pool.query<{
    id: number; name: string; email: string; team_id: number | null; role: Role | null;
  }>(
    `SELECT u.id, u.name, u.email, m.team_id, m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN team_memberships m ON m.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hash(token)],
  );
  if (rows.length === 0) return null;
  const roles = new Map<number, Role>();
  for (const r of rows) if (r.team_id !== null && r.role) roles.set(r.team_id, r.role);
  return { id: rows[0].id, name: rows[0].name, email: rows[0].email, roles };
}
