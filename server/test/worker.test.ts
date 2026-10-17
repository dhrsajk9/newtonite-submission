// Background jobs: notifications are created reliably, exactly once each,
// and failures are retried with backoff, then parked as "dead".
import { describe, expect, it } from 'vitest';
import { drain, MAX_ATTEMPTS, processNextJob } from '../src/worker/queue.js';
import { as, newItem, pool, setupApp } from './helpers.js';

const app = setupApp();

const userId = async (name: string) =>
  (await pool.query(`SELECT id FROM users WHERE email = $1`, [`${name}@newtonite.test`])).rows[0].id;

const notificationsFor = async (name: string, itemId: number) =>
  (await pool.query('SELECT message FROM notifications WHERE user_id = $1 AND work_item_id = $2 ORDER BY id', [
    await userId(name), itemId,
  ])).rows.map((r) => r.message);

/** Puts a job of a custom type on the queue, for testing the queue itself. */
const enqueue = async (type: string, payload: object = {}) =>
  (await pool.query(`INSERT INTO outbox_jobs (type, payload) VALUES ($1, $2) RETURNING id`, [type, JSON.stringify(payload)])).rows[0].id;

const job = async (id: number) => (await pool.query('SELECT * FROM outbox_jobs WHERE id = $1', [id])).rows[0];

/** Make a job that is waiting for its backoff runnable now (instead of sleeping in the test). */
const makeDue = (id: number) => pool.query('UPDATE outbox_jobs SET run_after = now() WHERE id = $1', [id]);

describe('notifications come from the outbox', () => {
  it('assigning someone notifies them; acting on your own work notifies nobody', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const a = await newItem(asha, 'Payments', { title: 'Chargeback for order 77' });
    await asha.act(a.id, 'assign', { version: a.version, assignee_id: await userId('ravi') });

    const b = await newItem(asha, 'Payments');
    await ravi.act(b.id, 'claim'); // Ravi assigns himself

    // Nothing is delivered until the worker runs: the request itself never waits for it.
    expect(await notificationsFor('ravi', a.id)).toEqual([]);
    await drain();

    expect(await notificationsFor('ravi', a.id)).toEqual(['Asha Rao assigned you “Chargeback for order 77”']);
    expect(await notificationsFor('ravi', b.id)).toEqual([]);
  });

  it('an approval request notifies every lead of the team except the requester', async () => {
    const asha = await as(app, 'asha');
    const { id } = await newItem(asha, 'Payments', { type: 'payment', title: 'Refund 500 EUR' });
    let v = (await asha.act(id, 'claim')).json().version;
    v = (await asha.act(id, 'request_approval', { version: v })).json().version;
    await drain();

    expect(await notificationsFor('arjun', id)).toEqual(['Asha Rao asked for your approval on “Refund 500 EUR”']);
    expect(await notificationsFor('asha', id)).toEqual([]);
  });

  it('a rejected request creates no job at all (the job is part of the same transaction)', async () => {
    const asha = await as(app, 'asha');
    const { id, version } = await newItem(asha, 'Payments');
    const before = (await pool.query('SELECT count(*)::int AS n FROM outbox_jobs')).rows[0].n;
    await asha.act(id, 'assign', { version: version + 5, assignee_id: await userId('ravi') }); // 409: stale
    const after = (await pool.query('SELECT count(*)::int AS n FROM outbox_jobs')).rows[0].n;
    expect(after).toBe(before);
  });

  it('running the same job twice still produces one notification', async () => {
    const asha = await as(app, 'asha');
    const { id, version } = await newItem(asha, 'Payments');
    await asha.act(id, 'assign', { version, assignee_id: await userId('meera') });
    const { rows } = await pool.query(`SELECT id FROM outbox_jobs WHERE status = 'pending' ORDER BY id DESC LIMIT 1`);
    const jobId = rows[0].id;

    expect(await processNextJob({ jobId })).toBe('done');
    // Simulate a crash after the work but before the job was marked done: it runs again.
    await pool.query(`UPDATE outbox_jobs SET status = 'pending' WHERE id = $1`, [jobId]);
    expect(await processNextJob({ jobId })).toBe('done');

    expect(await notificationsFor('meera', id)).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('a job that fails is retried later with backoff, and succeeds', async () => {
    let calls = 0;
    const handlers = {
      flaky: async () => {
        calls++;
        if (calls === 1) throw new Error('Mail server timeout');
      },
    };
    const id = await enqueue('flaky');

    expect(await processNextJob({ jobId: id, handlers })).toBe('retry');
    const afterFailure = await job(id);
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Mail server timeout' });
    expect(new Date(afterFailure.run_after).getTime()).toBeGreaterThan(Date.now()); // pushed into the future

    // Not due yet: the worker leaves it alone.
    expect(await processNextJob({ jobId: id, handlers })).toBe('none');

    await makeDue(id);
    expect(await processNextJob({ jobId: id, handlers })).toBe('done');
    expect((await job(id)).status).toBe('done');
  });

  it("a failing job's partial writes are undone", async () => {
    const asha = await as(app, 'asha');
    const { id: itemId } = await newItem(asha, 'Payments');
    const eventId = (await pool.query('SELECT id FROM activity_events WHERE work_item_id = $1', [itemId])).rows[0].id;
    const handlers = {
      half: async (tx: import('pg').PoolClient) => {
        await tx.query(
          `INSERT INTO notifications (user_id, work_item_id, event_id, message) VALUES ($1, $2, $3, 'partial')`,
          [await userId('ravi'), itemId, eventId],
        );
        throw new Error('crashed halfway');
      },
    };
    const id = await enqueue('half');
    await processNextJob({ jobId: id, handlers });
    expect(await notificationsFor('ravi', itemId)).toEqual([]);
  });

  it(`a job that keeps failing is marked dead after ${MAX_ATTEMPTS} attempts, with its last error`, async () => {
    const handlers = { broken: async () => { throw new Error('always fails'); } };
    const id = await enqueue('broken');
    const results = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue(id);
      results.push(await processNextJob({ jobId: id, handlers }));
    }
    expect(results).toEqual(['retry', 'retry', 'retry', 'retry', 'dead']);
    expect(await job(id)).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, last_error: 'always fails' });

    await makeDue(id);
    expect(await processNextJob({ jobId: id, handlers })).toBe('none'); // dead jobs are never picked up again
  });

  it('two workers never take the same job', async () => {
    const seen: number[] = [];
    const handlers = {
      slow: async (_tx: unknown, payload: { n: number }) => {
        seen.push(payload.n);
        await new Promise((r) => setTimeout(r, 30));
      },
    };
    await drain(); // clear other tests' jobs first
    for (let n = 0; n < 6; n++) await enqueue('slow', { n });
    // Three "workers" draining the queue at the same time.
    await Promise.all([drain({ handlers }), drain({ handlers }), drain({ handlers })]);
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]); // each job exactly once
  });
});

describe('notifications API', () => {
  it('lists your notifications with an unread count, and marks them read', async () => {
    const [asha, neha] = await Promise.all([as(app, 'asha'), as(app, 'neha')]);
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1', [await userId('neha')]);
    const kabir = await as(app, 'kabir');
    const { id, version } = await newItem(kabir, 'Customer Support', { title: 'Locked account' });
    await kabir.act(id, 'assign', { version, assignee_id: await userId('neha') });
    await drain();

    const list = (await neha.get('/api/notifications')).json();
    expect(list.unreadCount).toBe(1);
    expect(list.notifications[0]).toMatchObject({ work_item_id: id, message: 'Kabir Shah assigned you “Locked account”', read_at: null });

    // Someone else can't mark it read: same 404 as for anything you can't see.
    expect((await asha.post(`/api/notifications/${list.notifications[0].id}/read`)).statusCode).toBe(404);

    await neha.post(`/api/notifications/${list.notifications[0].id}/read`);
    expect((await neha.get('/api/notifications')).json().unreadCount).toBe(0);
  });
});
