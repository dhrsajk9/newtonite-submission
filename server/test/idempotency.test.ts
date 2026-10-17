// Double-clicks and retries must not create duplicates.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { as, pool, setupApp, teamId } from './helpers.js';

const app = setupApp();

const countTitled = async (title: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM work_items WHERE title = $1', [title])).rows[0].n;

const itemBody = async (title: string) => ({
  team_id: await teamId('Payments'), title, type: 'task', priority: 'medium',
});

describe('creating with an Idempotency-Key', () => {
  it('a retry returns the original response instead of creating a second item', async () => {
    const ravi = await as(app, 'ravi');
    const key = randomUUID();
    const body = await itemBody(`Retry test ${key}`);

    const first = await ravi.post('/api/items', body, { 'idempotency-key': key });
    const retry = await ravi.post('/api/items', body, { 'idempotency-key': key });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await countTitled(body.title)).toBe(1);
  });

  it('five simultaneous submissions with the same key create exactly one item', async () => {
    const ravi = await as(app, 'ravi');
    const key = randomUUID();
    const body = await itemBody(`Double click ${key}`);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ravi.post('/api/items', body, { 'idempotency-key': key })),
    );

    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await countTitled(body.title)).toBe(1);
  });

  it('rejects the same key reused for a different request', async () => {
    const ravi = await as(app, 'ravi');
    const key = randomUUID();
    await ravi.post('/api/items', await itemBody(`First ${key}`), { 'idempotency-key': key });
    const res = await ravi.post('/api/items', await itemBody(`Different ${key}`), { 'idempotency-key': key });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it("keys are per user: someone else's identical key does not collide", async () => {
    const [ravi, meera] = await Promise.all([as(app, 'ravi'), as(app, 'meera')]);
    const key = randomUUID();
    const body = await itemBody(`Per user ${key}`);
    const a = await ravi.post('/api/items', body, { 'idempotency-key': key });
    const b = await meera.post('/api/items', body, { 'idempotency-key': key });
    expect(a.json().id).not.toBe(b.json().id);
    expect(await countTitled(body.title)).toBe(2);
  });

  it('a failed request does not use up the key, so it can be retried', async () => {
    const priya = await as(app, 'priya'); // Payments viewer: cannot create
    const key = randomUUID();
    const res = await priya.post('/api/items', await itemBody(`Forbidden ${key}`), { 'idempotency-key': key });
    expect(res.statusCode).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [key]);
    expect(rows[0].n).toBe(0); // rolled back with the failed work
  });

  it('without a key, requests behave normally (two posts, two items)', async () => {
    const ravi = await as(app, 'ravi');
    const body = await itemBody(`No key ${randomUUID()}`);
    await ravi.post('/api/items', body);
    await ravi.post('/api/items', body);
    expect(await countTitled(body.title)).toBe(2);
  });

  it('rejects a malformed key', async () => {
    const ravi = await as(app, 'ravi');
    const res = await ravi.post('/api/items', await itemBody('x'), { 'idempotency-key': 'short' });
    expect(res.statusCode).toBe(400);
  });
});

describe('commenting with an Idempotency-Key', () => {
  it('a retried comment is posted once', async () => {
    const ravi = await as(app, 'ravi');
    const item = (await ravi.post('/api/items', await itemBody('Comment target'))).json();
    const key = randomUUID();
    await ravi.post(`/api/items/${item.id}/comments`, { body: 'Called the bank' }, { 'idempotency-key': key });
    await ravi.post(`/api/items/${item.id}/comments`, { body: 'Called the bank' }, { 'idempotency-key': key });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM comments WHERE work_item_id = $1', [item.id]);
    expect(rows[0].n).toBe(1);
  });
});
