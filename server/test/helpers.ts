import { afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SEED_PASSWORD } from '../src/db/seed.js';

/** A fresh app per test file, closed (with the DB pool) when the file finishes. */
export function setupApp() {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  return app;
}

/** Logs in a seeded user and returns the Cookie header to send with later requests. */
export async function login(app: ReturnType<typeof buildApp>, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: `${name}@newtonite.test`, password: SEED_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`Login failed for ${name}: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'sid')!;
  return `sid=${cookie.value}`;
}

/**
 * A logged-in API client for one user, so tests read like:
 *   const ravi = await as(app, 'ravi');
 *   await ravi.post(`/api/items/${id}/actions/claim`);
 */
export async function as(app: ReturnType<typeof buildApp>, name: string) {
  const cookie = await login(app, name);
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { cookie, ...headers } });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: object = {}, headers: Record<string, string> = {}) => call('POST', url, body, headers),
    patch: (url: string, body: object) => call('PATCH', url, body),
    /** POST /api/items/:id/actions/:action */
    act: (id: number, action: string, body: object = {}) => call('POST', `/api/items/${id}/actions/${action}`, body),
  };
}

export async function teamId(name: string): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM teams WHERE name = $1', [name]);
  return rows[0].id;
}

/** Creates a fresh OPEN item through the API, so each test starts from a known state. */
export async function newItem(
  client: Awaited<ReturnType<typeof as>>,
  team: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await client.post('/api/items', {
    team_id: await teamId(team),
    title: 'Test item',
    type: 'task',
    priority: 'medium',
    ...overrides,
  });
  if (res.statusCode !== 201) throw new Error(`Create failed: ${res.body}`);
  return res.json() as { id: number; version: number; status: string };
}

export async function eventCount(itemId: number, type?: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM activity_events WHERE work_item_id = $1 AND ($2::text IS NULL OR type = $2)',
    [itemId, type ?? null],
  );
  return rows[0].n;
}

/** Id of some seeded item in the given team. */
export async function anyItemInTeam(teamName: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT w.id FROM work_items w JOIN teams t ON t.id = w.team_id WHERE t.name = $1 ORDER BY w.id LIMIT 1',
    [teamName],
  );
  return rows[0].id;
}

export { pool };
