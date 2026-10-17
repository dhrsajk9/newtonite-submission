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

_More decisions are added as the project progresses: concurrency control,
authorization model, idempotency, and the background worker._
