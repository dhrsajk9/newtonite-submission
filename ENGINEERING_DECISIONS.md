# Engineering Decisions

The brief asks for about five important decisions. **The five below matter most**:
each answers a specific risk in the brief. Supporting decisions follow in an
appendix, after a section on what I deliberately did not build.

Each decision gives the context, what was chosen, the alternatives considered and
the trade-offs accepted.

| # | Decision | The risk it addresses | Code | Proven by |
|---|---|---|---|---|
| 1 | [Concurrency: version numbers across think-time, row locks within a request](#1-concurrency-version-numbers-across-think-time-row-locks-within-a-request) | Two users take the same work; one user edits what another just changed; many updates at once | `items/service.ts` (`mutateItem`) | `concurrency.test.ts`, e2e claim race and edit conflict |
| 2 | [Team-scoped roles, enforced in one server-side function](#2-team-scoped-roles-enforced-in-one-server-side-function) | Users in several teams with different responsibilities; enforced by the system, not hidden buttons | `permissions.ts` | `permissions.test.ts`, `authorization.test.ts`, e2e viewer test |
| 3 | [Workflow rules as data; every change recorded in an append-only history](#3-workflow-rules-as-data-every-change-recorded-in-an-append-only-history) | Approvals before moving forward; understanding what happened and why | `items/workflow.ts`, `items/events.ts` | `workflow.test.ts`, `concurrency.test.ts` (history) |
| 4 | [Transactional outbox and a separate worker for side effects](#4-transactional-outbox-and-a-separate-worker-for-side-effects) | Asynchronous work: what happens when it fails, runs twice or is delayed | `items/events.ts`, `worker/` | `worker.test.ts` |
| 5 | [Idempotency keys recorded in the same transaction as the work](#5-idempotency-keys-recorded-in-the-same-transaction-as-the-work) | A user repeating an action because they are unsure the first succeeded | `idempotency.ts` | `idempotency.test.ts`, e2e retried create |

---

## 1. Concurrency: version numbers across think-time, row locks within a request

**Context.** Two people can claim the same item at the same moment, and people
save forms they loaded minutes ago. Last-write-wins would silently lose work.

**Decision.** Two mechanisms, for two timescales:
- **Across user think-time (seconds to minutes): optimistic locking.** Every item
  has a `version`. Edits and workflow actions must send the version the user was
  looking at; if it has changed, the request fails with `409 VERSION_CONFLICT` and
  the response includes the current item so the UI can show what changed.
- **Within a request (milliseconds): a row lock.** Every change runs through one
  function, `mutateItem`, which starts a transaction and takes `SELECT … FOR UPDATE`
  on the row before checking visibility, version, permission and workflow state.
  A concurrent request for the same item waits a few milliseconds, then sees the
  updated row. This makes claiming atomic: the second claimer gets
  `409 ALREADY_CLAIMED` with the winner's name, and a repeated claim by the winner
  succeeds harmlessly.

**Alternatives considered.**
- *Last write wins:* simplest, loses data silently.
- *Pessimistic "editing" locks held while a user has a form open:* locks get stuck
  on closed tabs and lost connections, needing timeouts and force-unlock.
- *Version check in application code without a lock:* itself a check-then-write
  race. Removing the row lock makes the "five simultaneous saves" test fail even
  with the version check present.
- *A single conditional `UPDATE … WHERE version = $v`:* also correct, but
  permission and workflow rules would then have to be re-expressed in SQL or
  checked against a possibly stale read. Locking first lets all rules run in
  TypeScript against the current row.

**Trade-offs.** Requests for the same item are serialised (briefly), which is fine
for human-driven traffic and harmless for different items. Users occasionally see
a conflict and must re-apply their change. Locks are never held across network
calls or user think-time, so they cannot get stuck.

---

## 2. Team-scoped roles, enforced in one server-side function

**Context.** People belong to several teams with different responsibilities in
each. Hiding buttons in the UI is not access control: anyone can call the API directly.

**Decision.** Roles (`viewer`, `member`, `lead`) live on the team membership, not
the user. Every route calls `authorize(user, action, item)` from `permissions.ts`,
which combines a role → actions table with item-specific rules (members may only
change items assigned to them; a lead cannot approve their own approval request).
Users outside an item's team receive **404, not 403**. List queries filter by the
user's teams in SQL, never after fetching.

**Alternatives considered.**
- *Global roles (admin/user):* cannot express "lead in Payments, viewer in Engineering".
- *Policy engine (OPA, Casbin):* powerful, but heavy for about ten rules; a pure
  function is easier to test exhaustively and to explain.
- *403 for other teams' items:* accurate, but confirms the item exists, which
  leaks information (e.g. that a compliance investigation is open).

**Trade-offs.** No cross-team items and no per-item sharing. Roles are loaded on
every request (one small indexed query) so role changes take effect immediately,
at the cost of a little latency compared with caching them in a token.

---

## 3. Workflow rules as data; every change recorded in an append-only history

**Context.** Requests may need approval before moving forward, items should not
jump to arbitrary states, and "important actions should not silently disappear":
people need to see who changed ownership, priority or state, and why.

**Decision.** The state machine is a table in `workflow.ts`: each action lists the
statuses it may start from, the status it leads to, and the permission it needs.
Status and assignee change only via `POST /api/items/:id/actions/:action`, never
through `PATCH` (which rejects unknown fields). Business rules sit beside it:
payment and compliance items require approval, the requester cannot approve
(four-eyes), rejecting and reopening require a reason that is kept in the history.
Every item response includes `allowed_actions` for the current user, computed from
the same rules, so the UI shows only what the server would accept. The server
still re-checks everything on every request. The database independently enforces
the invariants it can (e.g. an `IN_PROGRESS` item has an assignee; an `OPEN` item does not).

**History.** Every change appends to `activity_events` (never updated or
deleted) **inside the same transaction** as the change, so history cannot disagree
with the data: a failed or rolled-back request leaves no entry, and a successful
one always does. Events carry before/after values (e.g. priority Low → Critical)
and the reasons given for rejections and reopenings, so "why was this decided?"
has an answer. Items are closed, never deleted.

**Alternatives considered.**
- *Only `updated_at` / `last_modified_by` columns:* shows the latest change, loses the rest.
- *Full event sourcing* (state rebuilt from events): powerful, but far more machinery
  than one day allows.
- *A generic `PATCH { status }`:* any client could skip approval.
- *A state-machine library:* more machinery than nine transitions need.

**Trade-offs.** One endpoint per action means slightly more API surface, but each
action is individually authorised, validated and recorded with a meaningful
history entry; adding a status or action is a one-line table change plus tests.
The history table grows forever: at scale it would be partitioned by month, with
old partitions archived.

---

## 4. Transactional outbox and a separate worker for side effects

**Context.** Changes should notify people, but sending inside the request would
make a slow or failing notification slow or break the user's action, and a crash
between "saved" and "sent" would lose the notification (or send one for a change
that rolled back).

**Decision.** When an event that notifies someone is recorded, a row is added to
`outbox_jobs` **in the same transaction** as the change. A separate worker process
takes one job at a time with `SELECT … FOR UPDATE SKIP LOCKED` (so several workers
never take the same job), runs its handler inside a savepoint, and marks it done
in the same transaction. On failure, the handler's writes are undone, the error
is recorded, and the job is retried with exponential backoff (2 s, 4 s, 8 s…);
after 5 attempts it is marked `dead` for a human to inspect. A crashed worker's
transaction is rolled back by Postgres and the job is picked up again. Delivery is
therefore at-least-once, so handlers are idempotent: notifications are unique per
`(user, event)` and inserted with `ON CONFLICT DO NOTHING`. `/api/health` reports
pending and dead job counts.

**Alternatives considered.**
- *Send inline in the request:* couples the user's action to the notification's
  speed and success.
- *Fire-and-forget promise / `setTimeout`:* lost on restart, no retries, no record.
- *Redis/BullMQ, RabbitMQ, SQS:* built for high volume, but the job would live
  outside the database transaction, so "save" and "enqueue" could disagree; an
  outbox is still needed to bridge them.
- *Exactly-once delivery:* not achievable across crashes for external effects;
  at-least-once with idempotent handlers is the standard answer.

**Trade-offs.** Notifications appear up to about a second later (polling). The
queue shares the database, which is fine at this volume; at much higher volume the
outbox would feed a dedicated broker. Dead jobs need manual attention.

---

## 5. Idempotency keys recorded in the same transaction as the work

**Context.** Users double-click, networks time out, and clients retry. A retried
"create" must not create a second item.

**Decision.** `POST /api/items` and comment creation accept an `Idempotency-Key`
that the client generates once per user action. Inside the request's transaction
the server inserts `(user, key, request fingerprint)` with `ON CONFLICT DO NOTHING`,
does the work, stores the response, and commits. If the key already exists, the
stored response is replayed. A simultaneous duplicate blocks on the uncommitted
insert until the first transaction finishes, then replays its result. If the work
fails, the key rolls back with it, so the client can retry. The same key with a
different body is rejected (422). Keys are per user and deleted after 24 hours.

**Alternatives considered.**
- *Disabling the button:* still used, but it doesn't help with network retries,
  refreshes or two tabs.
- *Check for the key, then insert it (two steps):* a race. Two simultaneous
  requests both see "no key"; a test fails when the code is changed to this.
- *Store the key in a separate transaction before the work, marked "in progress":*
  common, but a crash between the work and storing the response leaves a stuck
  key, and needs an extra "in progress" state. One transaction avoids both.
- *Uniqueness on business fields (e.g. title):* two genuinely different items can
  share a title.

**Trade-offs.** Only create and comment use keys. Workflow actions are already
safe to repeat (claim is a no-op for the owner; others carry a version). Stored
responses use some space until cleanup.

---

## What I deliberately did not build

The brief values "a smaller system with well-considered behaviour" over many
incomplete features. These were left out on purpose:

| Not built | Why not | What would change |
|---|---|---|
| Real-time push (WebSockets/SSE) | Improves speed, not correctness: versions already stop stale writes, and polling plus refetch-on-focus keeps screens fresh within 15–30 s | An SSE stream of item changes per team; the UI would invalidate queries on each event |
| SSO, sign-up, password reset, user admin | Not what the brief assesses, and reviewers would need accounts | OIDC login against the company identity provider; team membership synced from the directory |
| Email / Slack notifications | Same mechanism as in-app notifications; adds external credentials, not new reasoning | A new job type on the existing outbox, with the same retry and dead-job handling |
| Automatic field-level merging of conflicts | Merges can combine changes into something nobody intended; the user is better placed to decide | Merge non-overlapping fields automatically, ask only on overlap |
| Cross-team items, per-item sharing | Keeps authorization one simple rule (your role in the item's team) | An `item_access` table checked by `authorize()` |
| Relevance-ranked search, saved views | Text search plus filters already find work; ranking adds a second sort order to paginate | `ts_rank` ordering with its own cursor; saved filter URLs per user |
| SLAs, escalation, recurring work | Valuable, but each needs its own scheduler rules and UI | Scheduled jobs on the same queue that raise priority or notify leads |
| Deleting items or comments | "Important actions should not silently disappear" | Soft-delete with a history entry, if ever needed |
| Microservices, Redis, a message broker, a search engine | One database gives real transactions across data, history and jobs; extra systems would add consistency problems without solving one we have | Split out only where load demands it (see decision A) |

---

## Appendix: supporting decisions

### A. PostgreSQL as the only infrastructure

**Context.** The system needs relational data (users, teams, roles, items, history),
transactions that span several tables, safe concurrent updates, text search, and
a reliable background job queue.

**Decision.** Use PostgreSQL for all of it: data, the job queue (an `outbox_jobs`
table read with `FOR UPDATE SKIP LOCKED`), and full-text search (a generated
`tsvector` column with a GIN index). No Redis, message broker or search engine.

**Alternatives considered.**
- *MongoDB:* flexible documents, but this data is highly relational and needs
  multi-table transactions and foreign keys.
- *Redis/BullMQ or RabbitMQ for jobs:* purpose-built, but the job would live in a
  different system from the data, so "save the change" and "enqueue the job" could
  not be one atomic step.
- *Elasticsearch:* more powerful search, but another service to run and keep in
  sync. Postgres search is fast at tens of thousands of items.

**Trade-offs.** One system to run, reason about and test, with real transactions
across everything. At much larger scale the queue and search would move to
dedicated services, and the activity table would need partitioning.

### B. The database enforces invariants, not just the application

**Context.** Application code has bugs. Bad data that gets in is expensive to find
and fix later.

**Decision.** Encode every rule the database can check: allowed values for status,
priority, type and role (`CHECK` constraints), foreign keys, uniqueness (e.g. one
notification per user per event), and cross-field rules such as "an item in
progress must have an assignee" and "an item awaiting approval must record who
requested it".

**Alternatives considered.** Validate only in application code (simpler migrations,
but one missed check lets bad data in). Postgres `ENUM` types instead of `CHECK`
constraints (slightly stricter typing, but harder to change in a migration).

**Trade-offs.** Rules live in two places (DB and app), so changing one means a
migration. In return, no code path, script or bug can store an impossible state.

### C. Plain SQL with a thin migration runner instead of an ORM

**Context.** The important correctness behaviour (conditional updates, version
checks, row locking, `SKIP LOCKED`) depends on precise SQL.

**Decision.** Use `node-postgres` with hand-written, parameterised SQL. Migrations
are numbered `.sql` files applied in order, each in its own transaction, under an
advisory lock so two containers starting at once cannot both migrate.

**Alternatives considered.** Prisma/TypeORM: productive for CRUD, but they encourage
read-then-write patterns that cause race conditions, and the key queries would need
raw SQL anyway.

**Trade-offs.** More SQL to write and less automatic typing of query results. In
return, every query that matters for correctness is visible and reviewable.

### D. Server-side sessions in an httpOnly cookie, not JWTs

**Context.** The app needs simple login for seeded users. Authentication is not
the focus of the brief, but it must not be unsafe.

**Decision.** On login, generate a random 256-bit token, store only its SHA-256
hash in a `sessions` table, and send the token in an `httpOnly`, `SameSite=Lax`
cookie. Logout deletes the row. Wrong email and wrong password return the same
error and take the same time (a bcrypt comparison runs either way).

**Alternatives considered.**
- *JWT in localStorage:* readable by any injected script (XSS), and cannot be
  revoked before it expires.
- *JWT in a cookie:* safer, but still not revocable without a denylist, which is
  a session table again.
- *SSO (OAuth/OIDC):* the right production answer, but setup would consume time
  the brief wants spent elsewhere, and reviewers would need accounts.

**Trade-offs.** One extra query per request to look up the session (cheap,
indexed by primary key). In exchange, sessions can be revoked instantly and roles
are always current. `SameSite=Lax` plus a JSON-only API covers CSRF for this
scope; a production deployment would add CSRF tokens and SSO.

### E. Keyset (cursor) pagination and server-side filtering

**Context.** Tens of thousands of items; the browser must never load them all.

**Decision.** Lists are filtered, searched and paginated in SQL, always scoped to
the user's teams. Pages are ordered by `(updated_at DESC, id DESC)`, and the cursor
is the last row's key. Indexes match these queries (the common filtered list is
answered from an index in about 3 ms on 5,000 items). The cursor carries the
timestamp as Postgres text, because JavaScript dates drop microseconds and would
make the cursor skip rows.

**Alternatives considered.** `OFFSET` pagination: slower on deep pages and shows
duplicates or skips rows when data changes between pages (a test demonstrates
this does not happen with the cursor). Client-side filtering: ruled out by the brief.

**Trade-offs.** No "jump to page 37" and no exact total count; the UI offers
"load more" instead. One fixed sort order for now.

### F. Frontend: server state in a query cache, optimistic only where it's safe

**Context.** The UI must stay consistent with server decisions it cannot predict:
someone else may claim, edit or approve at any moment.

**Decision.** React with TanStack Query. Server data lives only in the query cache
(never copied into hand-written global state); filters live in the URL; form drafts
live in component state. Every server error arrives as a typed `ApiError` with the
API's `code`, so screens react to meaning (`ALREADY_CLAIMED`, `VERSION_CONFLICT`),
not to status numbers.
- **Claim is optimistic:** the page shows you as owner at once, then replaces that
  with the server's answer; on 409 it rolls back and names the winner.
- **Edits are not optimistic:** the form keeps the version it started from. On 409
  it shows what the other person changed and offers "keep my changes on top of
  theirs" (re-sending only the fields this user changed) or "discard".
- **Which buttons appear** comes from the server's `allowed_actions`.
- **Freshness** comes from polling and refetch-on-focus; correctness comes from
  versions, so a stale screen can never cause a silent overwrite.
- **One origin:** the API serves the built UI, so the session cookie works with no
  CORS configuration.

**Alternatives considered.**
- *Redux or another global store for server data:* hand-written caching,
  invalidation and loading states, and a second copy of the truth.
- *Optimistic updates everywhere:* attractive, but an optimistic edit that later
  conflicts would show the user something that never happened; claim is safe
  because its rollback is simple and its outcome is announced.
- *WebSockets:* faster updates, more moving parts (reconnection, fan-out); a
  polish item, since it improves speed, not correctness.
- *A component library:* faster to start, but generic; plain CSS with one small design
  system (dark surfaces, one blue accent for actions, distinct colours for priority)
  stays small and readable.

**Trade-offs.** Polling means other people's changes appear within 15 to 30
seconds rather than instantly. Field-level merging is manual (the user chooses),
not automatic.
