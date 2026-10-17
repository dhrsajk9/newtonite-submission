-- 001_init.sql: the core schema.
--
-- Design notes:
-- * Fixed value sets (status, priority, role...) use CHECK constraints rather than
--   Postgres ENUM types, because CHECK constraints are easier to change in a later
--   migration (e.g. adding a new status).
-- * The database enforces the rules it can (valid values, foreign keys, uniqueness),
--   so bad data is rejected even if application code has a bug.

-- ─── People and teams ────────────────────────────────────────────────────────

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The role lives on the membership, not the user: one person can be a lead in
-- Payments and a viewer in Engineering.
CREATE TABLE team_memberships (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  team_id    BIGINT NOT NULL REFERENCES teams(id),
  role       TEXT   NOT NULL CHECK (role IN ('viewer', 'member', 'lead')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX team_memberships_team_idx ON team_memberships (team_id);

-- ─── Work items ──────────────────────────────────────────────────────────────

CREATE TABLE work_items (
  id          BIGSERIAL PRIMARY KEY,
  team_id     BIGINT NOT NULL REFERENCES teams(id),
  title       TEXT   NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT   NOT NULL DEFAULT '',
  type        TEXT   NOT NULL CHECK (type IN ('incident', 'customer_issue', 'payment', 'compliance', 'task')),
  status      TEXT   NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED')),
  priority    TEXT   NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  -- Numeric rank of priority so we can sort critical → low with an index.
  priority_rank SMALLINT GENERATED ALWAYS AS (
    CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
  ) STORED,
  assignee_id BIGINT REFERENCES users(id),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  -- Who asked for approval. Used to enforce the "four-eyes" rule: the requester
  -- cannot approve their own request.
  approval_requested_by BIGINT REFERENCES users(id),
  next_step   TEXT   NOT NULL DEFAULT '',
  due_at      TIMESTAMPTZ,
  -- Optimistic concurrency control: every update does `version = version + 1`
  -- and only succeeds if the client's expected version still matches.
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Full-text search document, kept up to date automatically by Postgres.
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', description), 'B')
  ) STORED,
  -- Invariants the database guarantees regardless of application bugs:
  -- someone must own an item that is being worked on or awaiting approval...
  CONSTRAINT work_in_progress_has_assignee
    CHECK (status NOT IN ('IN_PROGRESS', 'AWAITING_APPROVAL') OR assignee_id IS NOT NULL),
  -- ...and an item awaiting approval must record who asked for it.
  CONSTRAINT awaiting_approval_has_requester
    CHECK (status <> 'AWAITING_APPROVAL' OR approval_requested_by IS NOT NULL)
);

-- Indexes match the queries the app actually runs:
-- team list views filtered by status, newest-updated first (keyset pagination on updated_at, id)
CREATE INDEX work_items_team_status_updated_idx ON work_items (team_id, status, updated_at DESC, id DESC);
CREATE INDEX work_items_team_updated_idx        ON work_items (team_id, updated_at DESC, id DESC);
-- "assigned to me" queue
CREATE INDEX work_items_assignee_status_idx     ON work_items (assignee_id, status, priority_rank);
-- "unassigned critical/high" queue
CREATE INDEX work_items_unassigned_idx          ON work_items (team_id, priority_rank)
  WHERE assignee_id IS NULL AND status = 'OPEN';
-- text search
CREATE INDEX work_items_search_idx              ON work_items USING GIN (search_vector);

-- ─── History and collaboration ───────────────────────────────────────────────

-- Append-only: rows are inserted, never updated or deleted.
CREATE TABLE activity_events (
  id           BIGSERIAL PRIMARY KEY,
  work_item_id BIGINT NOT NULL REFERENCES work_items(id),
  actor_id     BIGINT NOT NULL REFERENCES users(id),
  type         TEXT   NOT NULL CHECK (type IN (
                 'created', 'updated', 'status_changed', 'assigned', 'unassigned',
                 'priority_changed', 'approval_requested', 'approved', 'rejected', 'commented')),
  payload      JSONB  NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_events_item_idx ON activity_events (work_item_id, id DESC);

CREATE TABLE comments (
  id           BIGSERIAL PRIMARY KEY,
  work_item_id BIGINT NOT NULL REFERENCES work_items(id),
  author_id    BIGINT NOT NULL REFERENCES users(id),
  body         TEXT   NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_item_idx ON comments (work_item_id, id);

-- ─── Reliability ─────────────────────────────────────────────────────────────

-- Idempotency keys: a retried request with the same key gets the stored response
-- instead of being executed twice.
CREATE TABLE idempotency_keys (
  user_id         BIGINT NOT NULL REFERENCES users(id),
  key             TEXT   NOT NULL,
  request_hash    TEXT   NOT NULL,          -- detects the same key reused for a different request
  response_status INTEGER,                  -- NULL while the original request is still running
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Transactional outbox: side-effect jobs written in the same transaction as the
-- change that caused them, then processed by a separate worker.
CREATE TABLE outbox_jobs (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT   NOT NULL,
  payload    JSONB  NOT NULL,
  status     TEXT   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dead')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_after  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_jobs_pending_idx ON outbox_jobs (run_after, id) WHERE status = 'pending';

-- In-app notifications. The UNIQUE constraint makes the worker safe to run a job
-- twice: the second insert is ignored.
CREATE TABLE notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  work_item_id BIGINT NOT NULL REFERENCES work_items(id),
  event_id     BIGINT NOT NULL REFERENCES activity_events(id),
  message      TEXT   NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, id DESC) WHERE read_at IS NULL;
