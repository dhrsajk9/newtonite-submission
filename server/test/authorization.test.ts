// Integration tests: authorization is enforced by the server, even when the
// API is called directly (no UI involved).
import { describe, expect, it } from 'vitest';
import { anyItemInTeam, login, setupApp } from './helpers.js';

const app = setupApp();

const getItem = (id: number | string, cookie: string) =>
  app.inject({ method: 'GET', url: `/api/items/${id}`, headers: { cookie } });

describe('viewing items across teams', () => {
  it('a team member can view their team’s item', async () => {
    const id = await anyItemInTeam('Payments');
    const res = await getItem(id, await login(app, 'asha')); // Payments lead
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, team_name: 'Payments' });
  });

  it('a viewer can view their team’s item', async () => {
    const id = await anyItemInTeam('Payments');
    expect((await getItem(id, await login(app, 'priya'))).statusCode).toBe(200); // Payments viewer
  });

  it('an outsider gets 404 — the same response as for an item that does not exist', async () => {
    const id = await anyItemInTeam('Payments');
    const cookie = await login(app, 'vikram'); // Engineering viewer only

    const otherTeam = await getItem(id, cookie);
    const missing = await getItem(999_999_999, cookie);

    expect(otherTeam.statusCode).toBe(404);
    expect(otherTeam.json()).toEqual(missing.json()); // indistinguishable
  });

  it('rejects a non-numeric id with 400', async () => {
    const res = await getItem('abc', await login(app, 'asha'));
    expect(res.statusCode).toBe(400);
  });
});

describe('error format', () => {
  it('unknown routes return the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
});
