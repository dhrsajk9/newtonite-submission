// Unit tests for the permission rules. `can()` is a pure function, so these
// need no database and can cover the full role × action matrix.
import { describe, expect, it } from 'vitest';
import { authorize, can, type Action, type AuthUser, type Role } from '../src/permissions.js';
import { ForbiddenError, NotFoundError } from '../src/errors.js';

const TEAM = 1;
const OTHER_TEAM = 2;
const ME = 100;
const SOMEONE_ELSE = 200;

const userWith = (role: Role): AuthUser => ({ id: ME, name: 'Test', email: 't@x', roles: new Map([[TEAM, role]]) });

const mine = { team_id: TEAM, assignee_id: ME };
const theirs = { team_id: TEAM, assignee_id: SOMEONE_ELSE };

describe('role table', () => {
  // [action, viewer, member, lead] — evaluated on an item the user owns.
  const matrix: [Action, boolean, boolean, boolean][] = [
    ['item.view',    true,  true,  true],
    ['item.create',  false, true,  true],
    ['item.comment', false, true,  true],
    ['item.claim',   false, true,  true],
    ['item.edit',    false, true,  true],
    ['item.work',    false, true,  true],
    ['item.assign',  false, false, true],
    ['item.approve', false, false, true],
    ['item.close',   false, false, true],
    ['item.reopen',  false, false, true],
  ];
  it.each(matrix)('%s → viewer:%s member:%s lead:%s', (action, viewer, member, lead) => {
    expect(can(userWith('viewer'), action, mine).allowed).toBe(viewer);
    expect(can(userWith('member'), action, mine).allowed).toBe(member);
    expect(can(userWith('lead'), action, mine).allowed).toBe(lead);
  });
});

describe('item-specific rules', () => {
  it("a member cannot edit or move someone else's item", () => {
    expect(can(userWith('member'), 'item.edit', theirs).allowed).toBe(false);
    expect(can(userWith('member'), 'item.work', theirs).allowed).toBe(false);
  });

  it("a lead can edit and move anyone's item in their team", () => {
    expect(can(userWith('lead'), 'item.edit', theirs).allowed).toBe(true);
    expect(can(userWith('lead'), 'item.work', theirs).allowed).toBe(true);
  });

  it('four-eyes: a lead cannot approve their own approval request', () => {
    const ownRequest = { team_id: TEAM, approval_requested_by: ME };
    const othersRequest = { team_id: TEAM, approval_requested_by: SOMEONE_ELSE };
    expect(can(userWith('lead'), 'item.approve', ownRequest)).toEqual({
      allowed: false,
      reason: 'You cannot approve your own request.',
    });
    expect(can(userWith('lead'), 'item.approve', othersRequest).allowed).toBe(true);
  });

  it('a role in one team grants nothing in another team', () => {
    const lead = userWith('lead');
    expect(can(lead, 'item.view', { team_id: OTHER_TEAM }).allowed).toBe(false);
  });
});

describe('authorize()', () => {
  it('throws NotFound (404) for teams the user is not in, so existence is not revealed', () => {
    expect(() => authorize(userWith('lead'), 'item.view', { team_id: OTHER_TEAM })).toThrow(NotFoundError);
  });

  it('throws Forbidden (403) for a visible item the user may not change', () => {
    expect(() => authorize(userWith('viewer'), 'item.edit', mine)).toThrow(ForbiddenError);
  });
});
