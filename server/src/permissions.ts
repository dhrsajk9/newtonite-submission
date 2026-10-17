// ─────────────────────────────────────────────────────────────────────────────
// Authorization: the single place that decides who may do what.
//
// Every route calls `authorize(user, action, item)` before doing anything.
// The rules are data (the ROLE_ACTIONS table) plus a few rules that depend on
// the specific item (ownership, four-eyes). Changing a rule means changing it
// here, once, and the tests in test/permissions.test.ts show the full matrix.
// ─────────────────────────────────────────────────────────────────────────────
import { ForbiddenError, NotFoundError } from './errors.js';

export type Role = 'viewer' | 'member' | 'lead';

export type Action =
  | 'item.view'
  | 'item.create'
  | 'item.comment'
  | 'item.claim'             // take an unassigned item for yourself
  | 'item.edit'              // change title, description, priority, next step, due date
  | 'item.work'              // move your own item along: start, resolve, request approval, unassign
  | 'item.assign'            // assign or reassign to anyone
  | 'item.approve'           // approve or reject a request
  | 'item.close'
  | 'item.reopen';

/** What each role may do, before item-specific rules are applied. */
const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  viewer: new Set(['item.view']),
  member: new Set(['item.view', 'item.create', 'item.comment', 'item.claim', 'item.edit', 'item.work']),
  lead: new Set([
    'item.view', 'item.create', 'item.comment', 'item.claim', 'item.edit', 'item.work',
    'item.assign', 'item.approve', 'item.close', 'item.reopen',
  ]),
};

/** The logged-in user, with their role in each team they belong to. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  roles: ReadonlyMap<number, Role>; // teamId -> role
}

/** The fields of an item that permission rules need. */
export interface ItemForAuth {
  team_id: number;
  assignee_id?: number | null;
  approval_requested_by?: number | null;
}

export type Decision = { allowed: true } | { allowed: false; reason: string };

const allow: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

/** Pure function: no database, no side effects. Easy to test exhaustively. */
export function can(user: AuthUser, action: Action, item: ItemForAuth): Decision {
  const role = user.roles.get(item.team_id);
  if (!role) return deny('Not a member of this team.');
  if (!ROLE_ACTIONS[role].has(action)) return deny(`A ${role} cannot do this.`);

  // Item-specific rules on top of the role table:
  switch (action) {
    case 'item.edit':
    case 'item.work':
      // Members may only change items they own. Leads may change any item in their team.
      if (role === 'member' && item.assignee_id !== user.id) {
        return deny('Only the assignee or a team lead can change this item.');
      }
      return allow;
    case 'item.approve':
      // Four-eyes rule: the person who asked for approval cannot approve it.
      if (item.approval_requested_by === user.id) {
        return deny('You cannot approve your own request.');
      }
      return allow;
    default:
      return allow;
  }
}

/**
 * Throws if the user may not perform `action` on `item`.
 *
 * Users outside the item's team get 404, not 403: a 403 would confirm that the
 * item exists (e.g. that a compliance investigation is open about someone).
 */
export function authorize(user: AuthUser, action: Action, item: ItemForAuth, what = 'Item'): void {
  if (!user.roles.has(item.team_id)) throw new NotFoundError(what);
  const decision = can(user, action, item);
  if (!decision.allowed) throw new ForbiddenError(decision.reason);
}

/** Team ids the user can see. List queries filter by these in SQL. */
export function visibleTeamIds(user: AuthUser): number[] {
  return [...user.roles.keys()];
}
