// The workflow state machine and the business rules attached to it.
import { describe, expect, it } from 'vitest';
import { as, newItem, setupApp, teamId } from './helpers.js';

const app = setupApp();

describe('invalid transitions are rejected', () => {
  it('cannot close an OPEN item', async () => {
    const asha = await as(app, 'asha');
    const { id, version } = await newItem(asha, 'Payments');
    const res = await asha.act(id, 'close', { version });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'INVALID_TRANSITION', status: 'OPEN', allowed_from: ['RESOLVED'] });
  });

  it('a closed item is final: it cannot be reopened or edited', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const { id } = await newItem(asha, 'Payments', { type: 'task' });
    let v = (await ravi.act(id, 'claim')).json().version;
    v = (await ravi.act(id, 'resolve', { version: v })).json().version;
    v = (await asha.act(id, 'close', { version: v })).json().version;

    expect((await asha.act(id, 'reopen', { version: v, reason: 'again' })).statusCode).toBe(422);
    const edit = await asha.patch(`/api/items/${id}`, { version: v, title: 'new' });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().error.code).toBe('ITEM_CLOSED');
  });

  it('status cannot be changed by editing fields directly', async () => {
    const asha = await as(app, 'asha');
    const { id, version } = await newItem(asha, 'Payments');
    const res = await asha.patch(`/api/items/${id}`, { version, status: 'CLOSED' });
    expect(res.statusCode).toBe(400); // unknown field rejected, not silently ignored
  });
});

describe('approval flow', () => {
  it('payment items need approval: request → approve by another lead → resolved → closed', async () => {
    const [asha, arjun, ravi] = await Promise.all([as(app, 'asha'), as(app, 'arjun'), as(app, 'ravi')]);
    const { id } = await newItem(asha, 'Payments', { type: 'payment' });
    let v = (await ravi.act(id, 'claim')).json().version;

    const resolve = await ravi.act(id, 'resolve', { version: v });
    expect(resolve.statusCode).toBe(422);
    expect(resolve.json().error.code).toBe('APPROVAL_REQUIRED');

    const requested = (await ravi.act(id, 'request_approval', { version: v })).json();
    expect(requested.status).toBe('AWAITING_APPROVAL');
    v = requested.version;

    const approved = (await arjun.act(id, 'approve', { version: v })).json();
    expect(approved.status).toBe('RESOLVED');
    expect((await asha.act(id, 'close', { version: approved.version })).json().status).toBe('CLOSED');
  });

  it('four-eyes: a lead cannot approve their own request, another lead can', async () => {
    const [asha, arjun] = await Promise.all([as(app, 'asha'), as(app, 'arjun')]);
    const { id } = await newItem(asha, 'Payments', { type: 'payment' });
    let v = (await asha.act(id, 'claim')).json().version;
    v = (await asha.act(id, 'request_approval', { version: v })).json().version;

    const self = await asha.act(id, 'approve', { version: v });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toBe('You cannot approve your own request.');

    expect((await arjun.act(id, 'approve', { version: v })).statusCode).toBe(200);
  });

  it('rejecting requires a reason, which is kept in the history', async () => {
    const [arjun, ravi] = await Promise.all([as(app, 'arjun'), as(app, 'ravi')]);
    const { id } = await newItem(ravi, 'Payments', { type: 'compliance' });
    let v = (await ravi.act(id, 'claim')).json().version;
    v = (await ravi.act(id, 'request_approval', { version: v })).json().version;

    expect((await arjun.act(id, 'reject', { version: v })).statusCode).toBe(400); // no reason

    const rejected = await arjun.act(id, 'reject', { version: v, reason: 'Missing bank statement' });
    expect(rejected.json()).toMatchObject({ status: 'IN_PROGRESS', approval_requested_by: null });

    const latest = (await ravi.get(`/api/items/${id}/activity?limit=1`)).json().events[0];
    expect(latest).toMatchObject({ type: 'rejected', payload: { reason: 'Missing bank statement' } });
  });

  it('a member cannot approve', async () => {
    const [ravi, meera] = await Promise.all([as(app, 'ravi'), as(app, 'meera')]);
    const { id } = await newItem(ravi, 'Payments', { type: 'payment' });
    let v = (await ravi.act(id, 'claim')).json().version;
    v = (await ravi.act(id, 'request_approval', { version: v })).json().version;
    expect((await meera.act(id, 'approve', { version: v })).statusCode).toBe(403);
  });
});

describe('ownership and assignment', () => {
  it("a member cannot change someone else's item; a lead can", async () => {
    const [neha, priya, kabir] = await Promise.all([as(app, 'neha'), as(app, 'priya'), as(app, 'kabir')]);
    const { id } = await newItem(neha, 'Customer Support');
    const v = (await neha.act(id, 'claim')).json().version;

    expect((await priya.patch(`/api/items/${id}`, { version: v, priority: 'low' })).statusCode).toBe(403);
    expect((await priya.act(id, 'resolve', { version: v })).statusCode).toBe(403);
    expect((await kabir.patch(`/api/items/${id}`, { version: v, priority: 'low' })).statusCode).toBe(200);
  });

  it('only leads assign, and only to members or leads of the same team', async () => {
    const [asha, ravi] = await Promise.all([as(app, 'asha'), as(app, 'ravi')]);
    const { id, version } = await newItem(asha, 'Payments');
    const ids = Object.fromEntries(
      (await asha.get(`/api/teams/${await teamId('Payments')}/members`)).json().map((m: { id: number; name: string }) => [m.name.split(' ')[0], m.id]),
    );

    expect((await ravi.act(id, 'assign', { version, assignee_id: ids.Meera })).statusCode).toBe(403);

    const toViewer = await asha.act(id, 'assign', { version, assignee_id: ids.Priya }); // Priya is a Payments viewer
    expect(toViewer.statusCode).toBe(422);
    expect(toViewer.json().error.code).toBe('INVALID_ASSIGNEE');

    const ok = await asha.act(id, 'assign', { version, assignee_id: ids.Meera });
    expect(ok.json()).toMatchObject({ status: 'IN_PROGRESS', assignee_name: 'Meera Iyer' });
  });

  it('viewers cannot create, comment or claim', async () => {
    const [asha, priya] = await Promise.all([as(app, 'asha'), as(app, 'priya')]);
    const { id } = await newItem(asha, 'Payments');
    expect((await priya.post('/api/items', { team_id: await teamId('Payments'), title: 'x', type: 'task', priority: 'low' })).statusCode).toBe(403);
    expect((await priya.post(`/api/items/${id}/comments`, { body: 'hi' })).statusCode).toBe(403);
    expect((await priya.act(id, 'claim')).statusCode).toBe(403);
  });
});

describe('allowed_actions tells the UI exactly what the server will accept', () => {
  it('differs by person for the same item', async () => {
    const [asha, ravi, priya] = await Promise.all([as(app, 'asha'), as(app, 'ravi'), as(app, 'priya')]);
    const { id } = await newItem(asha, 'Payments', { type: 'payment' });
    await ravi.act(id, 'claim');

    const actionsFor = async (c: typeof asha) => (await c.get(`/api/items/${id}`)).json().allowed_actions;
    expect(await actionsFor(ravi)).toEqual(['unassign', 'request_approval']); // owner; 'resolve' hidden: needs approval
    expect(await actionsFor(asha)).toEqual(['assign', 'unassign', 'request_approval']); // lead
    expect(await actionsFor(priya)).toEqual([]); // viewer
  });
});
