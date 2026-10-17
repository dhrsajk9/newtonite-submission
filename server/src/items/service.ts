// ─────────────────────────────────────────────────────────────────────────────
// Business logic for changing work items.
//
// EVERY change goes through `mutateItem`, which does, in one transaction:
//   1. lock the row          SELECT ... FOR UPDATE   (concurrent requests queue here)
//   2. check visibility      not in your team → 404
//   3. check the version     changed since you loaded it → 409 with the current item
//   4. run the action        permission (403), workflow (422), compute the change
//   5. write the change      version = version + 1
//   6. write history         activity events, in the same transaction
//   7. commit                the lock is released
//
// The row lock lasts milliseconds (one request). The version check protects
// the much longer time a user spends looking at a form. Nothing is ever locked
// while a human is thinking.
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../errors.js';
import { authorize, type AuthUser } from '../permissions.js';
import { recordEvent, type NewEvent } from './events.js';
import { findItem, type WorkItem } from './repository.js';
import { allowedActions, TYPES_REQUIRING_APPROVAL, WORKFLOW, type WorkflowAction } from './workflow.js';

/** The raw, locked row (no joined names). */
export interface LockedItem {
  id: number;
  team_id: number;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  assignee_id: number | null;
  approval_requested_by: number | null;
  next_step: string;
  due_at: Date | null;
  version: number;
}

/** Columns a mutation is allowed to set. Guards the dynamic UPDATE below. */
const UPDATABLE = new Set([
  'title', 'description', 'priority', 'next_step', 'due_at',
  'status', 'assignee_id', 'approval_requested_by',
]);

type Change = { set: Record<string, unknown>; events: NewEvent[] } | 'noop';

/** An item as returned by the API: data plus what this user may do with it. */
export function present(user: AuthUser, item: WorkItem) {
  return { ...item, allowed_actions: allowedActions(user, item) };
}

export async function mutateItem(
  user: AuthUser,
  id: number,
  expectedVersion: number | undefined,
  action: (item: LockedItem, tx: PoolClient) => Promise<Change>,
) {
  const updated = await withTransaction(async (tx) => {
    // 1. Lock the row. A second request for the same item waits here until we commit.
    const { rows } = await tx.query<LockedItem>('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
    const item = rows[0];

    // 2. Same response for "doesn't exist" and "not your team".
    if (!item || !user.roles.has(item.team_id)) throw new NotFoundError();

    // 3. Optimistic concurrency: reject edits based on an outdated copy.
    if (expectedVersion !== undefined && item.version !== expectedVersion) {
      const current = (await findItem(tx, id))!;
      throw new ConflictError(
        'VERSION_CONFLICT',
        'This item was changed by someone else since you loaded it. Review the latest version and try again.',
        { current: present(user, current) },
      );
    }

    // 4. The action decides what changes (and throws 403/409/422 if it can't).
    const change = await action(item, tx);
    if (change === 'noop') return null;

    // 5. Apply the change and bump the version.
    const columns = Object.keys(change.set);
    for (const c of columns) if (!UPDATABLE.has(c)) throw new Error(`Column ${c} is not updatable`);
    const assignments = columns.map((c, i) => `${c} = $${i + 2}`);
    await tx.query(
      `UPDATE work_items SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')}
        WHERE id = $1`,
      [id, ...columns.map((c) => change.set[c])],
    );

    // 6. History, in the same transaction.
    for (const event of change.events) await recordEvent(tx, id, user.id, event);

    return findItem(tx, id);
  });

  // 7. Committed. Return the fresh state (or current state for a no-op).
  const item = updated ?? (await findItem(pool, id))!;
  return present(user, item);
}

// ─── Editing fields ──────────────────────────────────────────────────────────

export interface FieldEdits {
  title?: string;
  description?: string;
  priority?: string;
  next_step?: string;
  due_at?: string | null;
}

export function editItem(user: AuthUser, id: number, version: number, edits: FieldEdits) {
  return mutateItem(user, id, version, async (item) => {
    authorize(user, 'item.edit', item);
    if (item.status === 'CLOSED') {
      throw new BusinessRuleError('ITEM_CLOSED', 'Closed items cannot be edited.');
    }

    const set: Record<string, unknown> = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, value] of Object.entries(edits) as [keyof FieldEdits, unknown][]) {
      if (value === undefined) continue;
      const before = field === 'due_at' ? item.due_at?.toISOString() ?? null : item[field];
      const after = field === 'due_at' && value ? new Date(value as string).toISOString() : value;
      if (before === after) continue;
      set[field] = after;
      changes[field] = { from: before, to: after };
    }
    if (Object.keys(set).length === 0) return 'noop';

    // Priority gets its own event type (the brief calls it out); other fields share one.
    const events: NewEvent[] = [];
    if (changes.priority) events.push({ type: 'priority_changed', payload: changes.priority });
    const { priority: _p, ...rest } = changes;
    if (Object.keys(rest).length) events.push({ type: 'updated', payload: { changes: rest } });
    return { set, events };
  });
}

// ─── Workflow actions ────────────────────────────────────────────────────────

export interface ActionInput {
  version?: number;
  assignee_id?: number;
  reason?: string;
}

async function teamRole(tx: PoolClient, userId: number, teamId: number): Promise<string | null> {
  const { rows } = await tx.query('SELECT role FROM team_memberships WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
  return rows[0]?.role ?? null;
}

async function userName(tx: PoolClient, userId: number): Promise<string> {
  const { rows } = await tx.query('SELECT name FROM users WHERE id = $1', [userId]);
  return rows[0]?.name ?? 'Unknown';
}

export function performAction(user: AuthUser, id: number, actionName: WorkflowAction, input: ActionInput) {
  const t = WORKFLOW[actionName];
  // Claim needs no version: its condition is "still unassigned", checked on the locked row.
  // Every other action must say which version the user was looking at.
  const expectedVersion = actionName === 'claim' ? undefined : input.version;

  return mutateItem(user, id, expectedVersion, async (item, tx) => {
    authorize(user, t.permission, item);

    // Claim has its own conflict semantics: whoever locked the row first wins.
    if (actionName === 'claim' && item.assignee_id !== null) {
      if (item.assignee_id === user.id) return 'noop'; // retry or double-click: already yours, succeed quietly
      const owner = await userName(tx, item.assignee_id);
      throw new ConflictError('ALREADY_CLAIMED', `${owner} has already claimed this item.`, {
        assignee_id: item.assignee_id,
        assignee_name: owner,
      });
    }

    // The state machine: is this action allowed from the current status?
    if (!t.from.includes(item.status as never)) {
      throw new BusinessRuleError(
        'INVALID_TRANSITION',
        `Cannot ${actionName.replace('_', ' ')} an item that is ${item.status}.`,
        { status: item.status, allowed_from: t.from },
      );
    }

    const base = { from_status: item.status, to_status: t.to };
    switch (actionName) {
      case 'claim':
        return {
          set: { status: t.to, assignee_id: user.id },
          events: [{ type: 'assigned', payload: { ...base, assignee_id: user.id, assignee_name: user.name, claimed: true } }],
        };

      case 'assign': {
        const target = input.assignee_id!;
        const role = await teamRole(tx, target, item.team_id);
        if (role !== 'member' && role !== 'lead') {
          throw new BusinessRuleError('INVALID_ASSIGNEE', 'Items can only be assigned to members or leads of their team.');
        }
        if (target === item.assignee_id) return 'noop';
        return {
          set: { status: t.to, assignee_id: target },
          events: [{
            type: 'assigned',
            payload: { ...base, assignee_id: target, assignee_name: await userName(tx, target), previous_assignee_id: item.assignee_id },
          }],
        };
      }

      case 'unassign':
        return {
          set: { status: t.to, assignee_id: null },
          events: [{ type: 'unassigned', payload: { ...base, previous_assignee_id: item.assignee_id, reason: input.reason ?? null } }],
        };

      case 'request_approval':
        return {
          set: { status: t.to, approval_requested_by: user.id },
          events: [{ type: 'approval_requested', payload: base }],
        };

      case 'approve':
        return {
          set: { status: t.to },
          events: [{ type: 'approved', payload: { ...base, requested_by: item.approval_requested_by } }],
        };

      case 'reject':
        return {
          set: { status: t.to, approval_requested_by: null },
          events: [{ type: 'rejected', payload: { ...base, reason: input.reason, requested_by: item.approval_requested_by } }],
        };

      case 'resolve':
        if (TYPES_REQUIRING_APPROVAL.has(item.type)) {
          throw new BusinessRuleError('APPROVAL_REQUIRED', `A ${item.type} item must be approved by a team lead before it is resolved.`);
        }
        return { set: { status: t.to }, events: [{ type: 'status_changed', payload: base }] };

      case 'close':
        return { set: { status: t.to }, events: [{ type: 'status_changed', payload: base }] };

      case 'reopen':
        return {
          set: { status: t.to, approval_requested_by: null },
          events: [{ type: 'status_changed', payload: { ...base, reason: input.reason } }],
        };
    }
  });
}

// ─── Creating and commenting ─────────────────────────────────────────────────

export interface NewItem {
  team_id: number;
  title: string;
  description: string;
  type: string;
  priority: string;
  next_step: string;
  due_at: string | null;
}

/**
 * Creating and commenting take the caller's transaction (`tx`), so the route can
 * wrap them in an idempotency check that commits atomically with the work
 * (see idempotency.ts).
 */
export async function createItem(tx: PoolClient, user: AuthUser, input: NewItem) {
  authorize(user, 'item.create', { team_id: input.team_id }, 'Team');
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO work_items (team_id, title, description, type, priority, next_step, due_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.team_id, input.title, input.description, input.type, input.priority, input.next_step, input.due_at, user.id],
  );
  const id = rows[0].id;
  await recordEvent(tx, id, user.id, { type: 'created', payload: { title: input.title } });
  return present(user, (await findItem(tx, id))!);
}

export async function addComment(tx: PoolClient, user: AuthUser, itemId: number, body: string) {
  // Comments don't change the item, so they don't bump its version and never
  // cause edit conflicts. FOR SHARE just stops the item vanishing mid-insert.
  const { rows } = await tx.query('SELECT team_id FROM work_items WHERE id = $1 FOR SHARE', [itemId]);
  if (!rows[0] || !user.roles.has(rows[0].team_id)) throw new NotFoundError();
  authorize(user, 'item.comment', rows[0]);

  const c = await tx.query(
    `INSERT INTO comments (work_item_id, author_id, body) VALUES ($1, $2, $3)
     RETURNING id, body, created_at`,
    [itemId, user.id, body],
  );
  const comment = c.rows[0];
  await recordEvent(tx, itemId, user.id, { type: 'commented', payload: { comment_id: comment.id, body } });
  return { ...comment, work_item_id: itemId, author_id: user.id, author_name: user.name };
}
