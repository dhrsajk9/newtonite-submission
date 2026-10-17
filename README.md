# Newtonite Work Items

An internal tool for tracking operational work (customer issues, incidents,
payment investigations, compliance tasks, approvals), with team-based
permissions, a full activity history, and safe handling of concurrent edits.

> Status: **Step 2: login and authorization.**
> Later steps add the work item API, concurrency handling, the background worker, and the UI.

## Running it

Requirements: Docker Desktop.

```bash
docker compose up --build
```

Then open <http://localhost:3000/api/health>. You should see:

```json
{"status":"ok","database":"reachable","counts":{"users":8,"teams":3,"work_items":5000}}
```

On startup the API container applies database migrations and seeds demo data.
Both steps are safe to repeat, so restarting never duplicates data.

To start again with an empty database: `docker compose down -v` (the `-v` deletes the data volume).

## Running the tests

Tests run against a real Postgres, in a separate `newtonite_test` database that is
wiped and rebuilt on every run. Your demo data is never touched.

```bash
docker compose up -d db                 # if it isn't already running
docker compose run --rm --build api npm test
```

Or, with Node 22+ installed: `cd server && npm install && npm test`
(uses `localhost:5432`, which Docker Compose exposes).

Tests focus on behaviour that would be dangerous if wrong, not on coverage:

| File | What it proves |
|---|---|
| `test/permissions.test.ts` | The full role × action matrix; members can only change their own items; four-eyes rule; roles don't leak across teams |
| `test/auth.test.ts` | Login, httpOnly cookie, identical errors for wrong password vs unknown email, logout revokes the session |
| `test/authorization.test.ts` | Calling the API directly: outsiders get the same 404 as for a non-existent item |

## API

All errors share one shape: `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → user + teams/roles; sets session cookie |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | current user + teams/roles |
| GET | `/api/items/:id` | 404 if it doesn't exist **or** belongs to a team you're not in |
| GET | `/api/health` | liveness + database check |

| Status | Meaning |
|---|---|
| 400 | malformed request (`VALIDATION_ERROR`, with the bad fields listed) |
| 401 | not logged in |
| 403 | you can see the item but may not do this |
| 404 | not found, or not in your teams |
| 409 | conflict with the current state (later steps) |
| 422 | breaks a business rule (later steps) |

## Demo users

Every user's password is `password123`. Roles are per team, deliberately mixed
so permission rules can be demonstrated.

| User | Email | Payments | Customer Support | Engineering |
|---|---|---|---|---|
| Asha Rao | asha@newtonite.test | lead | viewer | — |
| Ravi Kumar | ravi@newtonite.test | member | — | — |
| Meera Iyer | meera@newtonite.test | member | — | member |
| Kabir Shah | kabir@newtonite.test | — | lead | — |
| Priya Nair | priya@newtonite.test | viewer | member | — |
| Arjun Mehta | arjun@newtonite.test | viewer | — | lead |
| Neha Gupta | neha@newtonite.test | — | member | member |
| Vikram Singh | vikram@newtonite.test | — | — | viewer |

## Project layout

```
docker-compose.yml        Postgres + API
server/
  src/
    app.ts                builds the app: plugins, routes, central error handler
    index.ts              starts the server
    config.ts             settings from environment variables
    errors.ts             typed errors → consistent JSON error responses
    permissions.ts        ALL authorization rules: can() / authorize()
    auth/                 login, logout, sessions, requireAuth guard
    items/                work item routes and queries
    db/
      pool.ts             connection pool + withTransaction helper
      migrate.ts          applies migrations/*.sql in order, exactly once
      seed.ts             demo teams, users and 5,000 work items
      migrations/
        001_init.sql      the schema
        002_sessions.sql  login sessions
  test/                   integration + unit tests (real Postgres)
ENGINEERING_DECISIONS.md  key design decisions and trade-offs
```

## Running without Docker (optional)

With Node 22+ and a Postgres you can reach:

```bash
cd server
npm install
set DATABASE_URL=postgres://postgres:postgres@localhost:5432/newtonite   # Windows cmd
npm run setup
npm run dev
```

## Assumptions

The brief leaves much unspecified on purpose. Assumptions made so far:

- **Every work item belongs to exactly one team.** That team's membership decides who can see and change it.
- **Roles are per team:** `viewer` (read only), `member` (create, claim, work on items), `lead` (assign, approve, close).
- **Workflow:** `OPEN → IN_PROGRESS → (AWAITING_APPROVAL →) RESOLVED → CLOSED`, with reopen and reject paths.
- **Items are never deleted.** They are closed, so history is preserved.
- **Authentication is deliberately simple** (seeded users, password login). A real deployment would use company SSO.

## Known limitations

- **No login rate limiting or account lockout.** Production would rate-limit `/api/auth/login` per IP and per account.
- **Expired sessions are ignored but not deleted.** A periodic cleanup job would remove them.
- **No user or team administration UI.** Users, teams and roles come from seed data.
- **Cookies are not marked `Secure` by default**, because the demo runs on plain `http://localhost`. Set `SECURE_COOKIES=true` behind HTTPS.
