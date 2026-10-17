# Engineering Decisions

Each decision records the context, what was chosen, the alternatives considered,
and the trade-offs accepted.

---

## 1. PostgreSQL as the only infrastructure

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

---

## 2. The database enforces invariants, not just the application

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

---

## 3. Plain SQL with a thin migration runner instead of an ORM

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

---

## 4. Team-scoped roles, enforced in one server-side function

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

## 5. Server-side sessions in an httpOnly cookie, not JWTs

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

---

_More decisions are added as the project progresses: concurrency control,
idempotency, and the background worker._
