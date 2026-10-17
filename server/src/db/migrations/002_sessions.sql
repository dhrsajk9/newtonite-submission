-- 002_sessions.sql: server-side login sessions.
--
-- The browser holds a random token in an httpOnly cookie. We store only a
-- SHA-256 hash of it, so a leaked copy of this table cannot be used to log in.
-- Logging out (or expiry) deletes the row, which revokes the session immediately,
-- something a stateless JWT cannot do.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
