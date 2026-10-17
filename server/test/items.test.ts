// Creating, listing, filtering, searching and paginating work items.
import { describe, expect, it } from 'vitest';
import { as, newItem, pool, setupApp, teamId } from './helpers.js';

const app = setupApp();

describe('creating items', () => {
  it('returns 201 with version 1, OPEN and unassigned, and records a "created" event', async () => {
    const ravi = await as(app, 'ravi');
    const res = await ravi.post('/api/items', {
      team_id: await teamId('Payments'),
      title: 'Refund stuck for order 1234',
      type: 'payment',
      priority: 'high',
      due_at: '2030-01-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ version: 1, status: 'OPEN', assignee_id: null, created_by_name: 'Ravi Kumar' });
    const events = (await ravi.get(`/api/items/${res.json().id}/activity`)).json().events;
    expect(events.map((e: { type: string }) => e.type)).toEqual(['created']);
  });

  it('rejects invalid input with the fields that are wrong', async () => {
    const ravi = await as(app, 'ravi');
    const res = await ravi.post('/api/items', { team_id: await teamId('Payments'), title: '', type: 'nope', priority: 'urgent' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields.map((f: { path: string }) => f.path).sort()).toEqual(['priority', 'title', 'type']);
  });

  it("cannot create in a team you're not in (404, team not revealed)", async () => {
    const vikram = await as(app, 'vikram');
    const res = await vikram.post('/api/items', { team_id: await teamId('Payments'), title: 'x', type: 'task', priority: 'low' });
    expect(res.statusCode).toBe(404);
  });
});

describe('listing', () => {
  it("only ever returns items from the user's own teams", async () => {
    const vikram = await as(app, 'vikram'); // Engineering only
    const res = await vikram.get('/api/items?limit=100');
    const teams = new Set(res.json().items.map((i: { team_name: string }) => i.team_name));
    expect([...teams]).toEqual(['Engineering']);

    // Asking for another team's items explicitly returns nothing, not an error that confirms it exists.
    const other = await vikram.get(`/api/items?team=${await teamId('Payments')}`);
    expect(other.json().items).toEqual([]);
  });

  it('filters by status, priority and assignee on the server', async () => {
    const asha = await as(app, 'asha');
    const res = await asha.get('/api/items?status=OPEN,IN_PROGRESS&priority=critical&limit=100');
    for (const item of res.json().items) {
      expect(['OPEN', 'IN_PROGRESS']).toContain(item.status);
      expect(item.priority).toBe('critical');
    }
    const unassigned = await asha.get('/api/items?assignee=unassigned&limit=100');
    expect(unassigned.json().items.every((i: { assignee_id: null }) => i.assignee_id === null)).toBe(true);
  });

  it('rejects invalid filter values', async () => {
    const asha = await as(app, 'asha');
    expect((await asha.get('/api/items?status=DONE')).statusCode).toBe(400);
    expect((await asha.get('/api/items?limit=1000')).statusCode).toBe(400);
  });

  it('finds items by text search', async () => {
    const asha = await as(app, 'asha');
    const { id } = await newItem(asha, 'Payments', { title: 'Zanzibar settlement anomaly', description: 'Ledger drift' });
    const byTitle = (await asha.get('/api/items?q=zanzibar')).json().items;
    const byDescription = (await asha.get('/api/items?q=ledger%20drift')).json().items;
    expect(byTitle.map((i: { id: number }) => i.id)).toEqual([id]);
    expect(byDescription.map((i: { id: number }) => i.id)).toContain(id);
  });
});

describe('cursor pagination', () => {
  it('walks every matching item exactly once', async () => {
    const asha = await as(app, 'asha');
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/items?team=${await teamId('Payments')}&limit=25${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await asha.get(url)).json();
      seen.push(...page.items.map((i: { id: number }) => i.id));
      cursor = page.nextCursor;
    } while (cursor);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM work_items WHERE team_id = $1', [await teamId('Payments')]);
    expect(seen.length).toBe(rows[0].n);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  it('is not disturbed by items changing between pages', async () => {
    const asha = await as(app, 'asha');
    const team = await teamId('Payments');
    const page1 = (await asha.get(`/api/items?team=${team}&limit=10`)).json();

    // While the user is on page 1, a new item is created (it sorts to the very top).
    await newItem(asha, 'Payments');

    const page2 = (await asha.get(`/api/items?team=${team}&limit=10&cursor=${page1.nextCursor}`)).json();
    const ids1 = page1.items.map((i: { id: number }) => i.id);
    const ids2 = page2.items.map((i: { id: number }) => i.id);
    // With OFFSET pagination, the last item of page 1 would be shown again on page 2.
    expect(ids2.filter((id: number) => ids1.includes(id))).toEqual([]);
  });

  it('rejects a tampered cursor', async () => {
    const asha = await as(app, 'asha');
    expect((await asha.get('/api/items?cursor=garbage')).statusCode).toBe(400);
  });
});

describe('comments', () => {
  it('adds a comment to the timeline without bumping the item version', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const { id, version } = await newItem(asha, 'Payments');
    const res = await ravi.post(`/api/items/${id}/comments`, { body: 'Checked with the bank, waiting to hear back.' });
    expect(res.statusCode).toBe(201);

    // Commenting must not cause someone else's edit to conflict.
    expect((await asha.get(`/api/items/${id}`)).json().version).toBe(version);
    const latest = (await asha.get(`/api/items/${id}/activity?limit=1`)).json().events[0];
    expect(latest).toMatchObject({ type: 'commented', actor_name: 'Ravi Kumar' });
  });
});
