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

/** Id of some seeded item in the given team. */
export async function anyItemInTeam(teamName: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT w.id FROM work_items w JOIN teams t ON t.id = w.team_id WHERE t.name = $1 ORDER BY w.id LIMIT 1',
    [teamName],
  );
  return rows[0].id;
}

export { pool };
