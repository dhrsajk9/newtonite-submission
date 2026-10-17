// The "Needs attention" queues show the right work to the right person.
import { describe, expect, it } from 'vitest';
import { as, newItem, setupApp } from './helpers.js';

const app = setupApp();

describe('dashboard queues', () => {
  it('an approval request appears in other leads\' queues, never in the requester\'s own', async () => {
    const [asha, arjun] = await Promise.all([as(app, 'asha'), as(app, 'arjun')]);
    const approvals = async (c: typeof asha) => (await c.get('/api/dashboard')).json().approvals.total;
    const [ashaBefore, arjunBefore] = [await approvals(asha), await approvals(arjun)];

    const { id } = await newItem(asha, 'Payments', { type: 'payment' });
    let v = (await asha.act(id, 'claim')).json().version;
    v = (await asha.act(id, 'request_approval', { version: v })).json().version;

    expect(await approvals(arjun)).toBe(arjunBefore + 1); // the other Payments lead
    expect(await approvals(asha)).toBe(ashaBefore);       // four-eyes: not her own
  });

  it('"Assigned to you" contains only your unfinished work', async () => {
    const ravi = await as(app, 'ravi');
    const { id } = await newItem(ravi, 'Payments', { priority: 'critical' });
    await ravi.act(id, 'claim');
    const { mine } = (await ravi.get('/api/dashboard')).json();
    expect(mine.items.length).toBeGreaterThan(0);
    for (const item of mine.items) {
      expect(item.assignee_name).toBe('Ravi Kumar');
      expect(['IN_PROGRESS', 'AWAITING_APPROVAL']).toContain(item.status);
    }
  });

  it('"Unclaimed and urgent" is open, unassigned, critical or high, in teams where you can claim', async () => {
    const [neha, vikram] = await Promise.all([as(app, 'neha'), as(app, 'vikram')]);
    const { unclaimed } = (await neha.get('/api/dashboard')).json();
    for (const item of unclaimed.items) {
      expect(item).toMatchObject({ status: 'OPEN', assignee_id: null });
      expect(['critical', 'high']).toContain(item.priority);
    }
    // Vikram only views Engineering, so he has nothing he could claim.
    expect((await vikram.get('/api/dashboard')).json().unclaimed.total).toBe(0);
  });

  it('every queue is limited to the teams you belong to', async () => {
    const vikram = await as(app, 'vikram');
    const d = (await vikram.get('/api/dashboard')).json();
    for (const q of [d.mine, d.approvals, d.unclaimed, d.overdue]) {
      for (const item of q.items) expect(item.team_name).toBe('Engineering');
    }
  });
});
