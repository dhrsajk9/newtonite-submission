// ─────────────────────────────────────────────────────────────────────────────
// The workflow (state machine), defined as data.
//
//   OPEN ──claim/assign──► IN_PROGRESS ──request_approval──► AWAITING_APPROVAL
//    ▲                       │  ▲  │                            │        │
//    └────── unassign ───────┘  │  └─────── resolve ──┐        reject  approve
//                               └──────────── reopen ─┼──────────┘        │
//                                                     ▼                   │
//                                                 RESOLVED ◄──────────────┘
//                                                     │
//                                                   close ──► CLOSED (final)
//
// Adding a status or an action is a change to this table, not to route code.
// ─────────────────────────────────────────────────────────────────────────────
import { can, type Action, type AuthUser } from '../permissions.js';

export type Status = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';

export type WorkflowAction =
  | 'claim' | 'assign' | 'unassign' | 'request_approval'
  | 'approve' | 'reject' | 'resolve' | 'close' | 'reopen';

interface Transition {
  from: readonly Status[];
  to: Status;
  permission: Action;
}

export const WORKFLOW: Record<WorkflowAction, Transition> = {
  claim:            { from: ['OPEN'],                to: 'IN_PROGRESS',       permission: 'item.claim' },
  assign:           { from: ['OPEN', 'IN_PROGRESS'], to: 'IN_PROGRESS',       permission: 'item.assign' },
  unassign:         { from: ['IN_PROGRESS'],         to: 'OPEN',              permission: 'item.work' },
  request_approval: { from: ['IN_PROGRESS'],         to: 'AWAITING_APPROVAL', permission: 'item.work' },
  approve:          { from: ['AWAITING_APPROVAL'],   to: 'RESOLVED',          permission: 'item.approve' },
  reject:           { from: ['AWAITING_APPROVAL'],   to: 'IN_PROGRESS',       permission: 'item.approve' },
  resolve:          { from: ['IN_PROGRESS'],         to: 'RESOLVED',          permission: 'item.work' },
  close:            { from: ['RESOLVED'],            to: 'CLOSED',            permission: 'item.close' },
  reopen:           { from: ['RESOLVED'],            to: 'IN_PROGRESS',       permission: 'item.reopen' },
};

/** Business rule: these item types must be approved by a lead; they cannot simply be resolved. */
export const TYPES_REQUIRING_APPROVAL: ReadonlySet<string> = new Set(['payment', 'compliance']);

interface ItemState {
  team_id: number;
  status: string;
  type: string;
  assignee_id: number | null;
  approval_requested_by: number | null;
}

/**
 * Actions this user can take on this item right now. Returned with every item,
 * so the UI shows exactly the buttons the server would accept. The server still
 * re-checks everything when the action is actually requested.
 */
export function allowedActions(user: AuthUser, item: ItemState): WorkflowAction[] {
  return (Object.keys(WORKFLOW) as WorkflowAction[]).filter((action) => {
    const t = WORKFLOW[action];
    if (!t.from.includes(item.status as Status)) return false;
    if (action === 'claim' && item.assignee_id !== null) return false;
    if (action === 'resolve' && TYPES_REQUIRING_APPROVAL.has(item.type)) return false;
    return can(user, t.permission, item).allowed;
  });
}
