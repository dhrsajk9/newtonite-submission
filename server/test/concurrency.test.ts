// The dangerous cases: several people acting on the same item at the same time.
// These requests really run concurrently against the real database.
import { describe, expect, it } from 'vitest';
import { as, eventCount, newItem, pool, setupApp } from './helpers.js';

const app = setupApp();

describe('claiming an item at the same moment', () => {
  it('exactly one person wins; everyone else is told who did', async () => {
    const [asha, ravi, meera] = await Promise.all([as(app, 'asha'), as(app, 'ravi'), as(app, 'meera')]);
    const { id } = await newItem(asha, 'Payments');

    // 9 simultaneous claims: 3 users, each double/triple-clicking.
    const attempts = [asha, ravi, meera, asha, ravi, meera, asha, ravi, meera];
    const results = await Promise.all(attempts.map((c) => c.act(id, 'claim')));

    const { rows } = await pool.query('SELECT assignee_id, status FROM work_items WHERE id = $1', [id]);
    const winnerId = rows[0].assignee_id;
    expect(rows[0].status).toBe('IN_PROGRESS');

    for (const res of results) {
      if (res.statusCode === 200) {
        // Only the winner gets 200 — and every one of the winner's repeat clicks gets 200 too.
        expect(res.json().assignee_id).toBe(winnerId);
      } else {
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toMatchObject({ code: 'ALREADY_CLAIMED', assignee_id: winnerId });
      }
    }
    expect(results.filter((r) => r.statusCode === 200).length).toBe(3); // the winner's 3 clicks
    expect(results.filter((r) => r.statusCode === 409).length).toBe(6); // the other two users' 6 clicks

    // History shows exactly one assignment, not one per click.
    expect(await eventCount(id, 'assigned')).toBe(1);
  });
});

describe('editing an outdated copy (optimistic locking)', () => {
  it("rejects a stale save instead of silently overwriting someone else's change", async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const created = await newItem(asha, 'Payments', { description: 'original' });
    const claimed = (await ravi.act(created.id, 'claim')).json();
    const loadedVersion = claimed.version; // both Asha and Ravi are now looking at this version

    // Asha (lead) raises the priority.
    const ashaSave = await asha.patch(`/api/items/${created.id}`, { version: loadedVersion, priority: 'critical' });
    expect(ashaSave.statusCode).toBe(200);
    expect(ashaSave.json().version).toBe(loadedVersion + 1);

    // Ravi, still looking at the old version, edits the description.
    const raviSave = await ravi.patch(`/api/items/${created.id}`, { version: loadedVersion, description: 'stale edit' });
    expect(raviSave.statusCode).toBe(409);
    const error = raviSave.json().error;
    expect(error.code).toBe('VERSION_CONFLICT');
    // The response includes the current item, so the UI can show what changed.
    expect(error.current).toMatchObject({ priority: 'critical', version: loadedVersion + 1, description: 'original' });

    // Nothing was overwritten, and the failed save left no history.
    const { rows } = await pool.query('SELECT priority, description FROM work_items WHERE id = $1', [created.id]);
    expect(rows[0]).toEqual({ priority: 'critical', description: 'original' });
    expect(await eventCount(created.id, 'updated')).toBe(0);
  });

  it('of five simultaneous saves of the same version, exactly one succeeds', async () => {
    const asha = await as(app, 'asha');
    const { id, version } = await newItem(asha, 'Payments');
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((suffix) => asha.patch(`/api/items/${id}`, { version, title: `Title ${suffix}` })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
    const { rows } = await pool.query('SELECT version FROM work_items WHERE id = $1', [id]);
    expect(rows[0].version).toBe(version + 1);
  });

  it('a workflow action based on an outdated view is rejected too', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const { id } = await newItem(asha, 'Payments');
    const v = (await ravi.act(id, 'claim')).json().version;
    await asha.patch(`/api/items/${id}`, { version: v, priority: 'high' });

    // Ravi resolves based on the version he saw before Asha's change.
    const res = await ravi.act(id, 'resolve', { version: v });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VERSION_CONFLICT');
  });
});

describe('history is written atomically with the change', () => {
  it('a rejected request writes no history', async () => {
    const [asha, priya] = await Promise.all([as(app, 'asha'), as(app, 'priya')]);
    const { id, version } = await newItem(asha, 'Payments');
    const before = await eventCount(id);

    await priya.patch(`/api/items/${id}`, { version, title: 'viewer edit' }); // 403
    await asha.act(id, 'close', { version });                                // 422
    await asha.patch(`/api/items/${id}`, { version: version + 7, title: 'x' }); // 409

    expect(await eventCount(id)).toBe(before);
  });

  it('every successful change adds exactly the expected event', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const { id } = await newItem(asha, 'Payments');
    const v1 = (await ravi.act(id, 'claim')).json().version;
    const v2 = (await ravi.patch(`/api/items/${id}`, { version: v1, priority: 'high', next_step: 'Call bank' })).json().version;
    await ravi.act(id, 'resolve', { version: v2 });

    const res = await ravi.get(`/api/items/${id}/activity`);
    const types = res.json().events.map((e: { type: string }) => e.type);
    expect(types).toEqual(['status_changed', 'updated', 'priority_changed', 'assigned', 'created']); // newest first
    expect(res.json().events[2].payload).toEqual({ from: 'medium', to: 'high' });
    expect(res.json().events[1].payload).toEqual({ changes: { next_step: { from: '', to: 'Call bank' } } });
    expect(res.json().events[0].actor_name).toBe('Ravi Kumar');
  });
});
