// HTTP layer: parse and validate input, call the service, shape the response.
// No business rules live here. They are in service.ts, workflow.ts and permissions.ts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { NotFoundError } from '../errors.js';
import { authorize, visibleTeamIds } from '../permissions.js';
import { currentUser, requireAuth } from '../auth/routes.js';
import { findItem, listActivity, listItems } from './repository.js';
import { addComment, createItem, editItem, performAction, present } from './service.js';
import { WORKFLOW, type WorkflowAction } from './workflow.js';
import { idempotent } from '../idempotency.js';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

/** "a,b,c" in a query string → validated array */
const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.enum(values)));

const ListQuery = z.object({
  team: z.coerce.number().int().positive().optional(),
  status: csvOf(STATUSES).optional(),
  priority: csvOf(PRIORITIES).optional(),
  type: csvOf(TYPES).optional(),
  assignee: z.union([z.enum(['me', 'unassigned']), z.coerce.number().int().positive()]).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});

const dueAt = z.string().datetime({ offset: true }).nullable();

const CreateBody = z.object({
  team_id: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  type: z.enum(TYPES),
  priority: z.enum(PRIORITIES),
  next_step: z.string().max(500).default(''),
  due_at: dueAt.default(null),
});

const EditBody = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    next_step: z.string().max(500).optional(),
    due_at: dueAt.optional(),
  })
  .strict(); // unknown fields (e.g. "status") are rejected, not silently ignored

const ActionParams = z.object({
  id: z.coerce.number().int().positive(),
  action: z.enum(Object.keys(WORKFLOW) as [WorkflowAction, ...WorkflowAction[]]),
});

// Each action's body. `version` is required for everything except claim.
const reason = z.string().trim().min(1).max(1000);
const ActionBodies: Record<WorkflowAction, z.ZodTypeAny> = {
  claim: z.object({}).passthrough(),
  assign: z.object({ version: z.number().int().positive(), assignee_id: z.number().int().positive() }),
  unassign: z.object({ version: z.number().int().positive(), reason: reason.optional() }),
  request_approval: z.object({ version: z.number().int().positive() }),
  approve: z.object({ version: z.number().int().positive() }),
  reject: z.object({ version: z.number().int().positive(), reason }), // why it was rejected is required
  resolve: z.object({ version: z.number().int().positive() }),
  close: z.object({ version: z.number().int().positive() }),
  reopen: z.object({ version: z.number().int().positive(), reason }),
};

const CommentBody = z.object({ body: z.string().trim().min(1).max(10_000) });
const ActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export async function itemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // List: always restricted, in SQL, to the user's teams.
  app.get('/api/items', async (request) => {
    const user = currentUser(request);
    const q = ListQuery.parse(request.query);
    const teams = visibleTeamIds(user);
    const teamIds = q.team ? teams.filter((t) => t === q.team) : teams;
    if (teamIds.length === 0) return { items: [], nextCursor: null };
    return listItems(pool, user.id, {
      teamIds, statuses: q.status, priorities: q.priority, types: q.type,
      assignee: q.assignee, q: q.q || undefined, limit: q.limit, cursor: q.cursor,
    });
  });

  // Create and comment accept an Idempotency-Key header: a retried request
  // returns the original response instead of creating a duplicate.
  app.post('/api/items', async (request, reply) => {
    const user = currentUser(request);
    const input = CreateBody.parse(request.body);
    return idempotent(request, reply, user.id, 201, (tx) => createItem(tx, user, input));
  });

  app.get('/api/items/:id', async (request) => {
    const user = currentUser(request);
    const { id } = IdParams.parse(request.params);
    const item = await findItem(pool, id);
    if (!item) throw new NotFoundError(); // same response as "not your team" below
    authorize(user, 'item.view', item);
    return present(user, item);
  });

  // Edit fields. Status, assignee etc. can only change through workflow actions.
  app.patch('/api/items/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const { version, ...edits } = EditBody.parse(request.body);
    return editItem(currentUser(request), id, version, edits);
  });

  // Workflow actions: POST /api/items/42/actions/claim, .../approve, etc.
  app.post('/api/items/:id/actions/:action', async (request) => {
    const { id, action } = ActionParams.parse(request.params);
    const input = ActionBodies[action].parse(request.body ?? {});
    return performAction(currentUser(request), id, action, input);
  });

  app.post('/api/items/:id/comments', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { body } = CommentBody.parse(request.body);
    const user = currentUser(request);
    return idempotent(request, reply, user.id, 201, (tx) => addComment(tx, user, id, body));
  });

  // History, newest first, paginated (it grows without limit).
  app.get('/api/items/:id/activity', async (request) => {
    const user = currentUser(request);
    const { id } = IdParams.parse(request.params);
    const { limit, cursor } = ActivityQuery.parse(request.query);
    const item = await findItem(pool, id);
    if (!item) throw new NotFoundError();
    authorize(user, 'item.view', item);
    return listActivity(pool, id, limit, cursor);
  });
}
