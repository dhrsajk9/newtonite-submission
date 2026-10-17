# Newtonite Work Items

An internal tool for tracking operational work (customer issues, incidents,
payment investigations, compliance tasks, approvals), with team-based
permissions, a full activity history, and safe handling of concurrent edits.

> Status: **Step 3: work item API, concurrency control, workflow and history.**
> Later steps add idempotency keys, the background worker and notifications, and the UI.

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
| `test/concurrency.test.ts` | 9 simultaneous claims → exactly one winner; stale edits rejected with 409; 5 simultaneous saves → one succeeds; failed requests leave no history |
| `test/workflow.test.ts` | Invalid transitions (422); approval flow; four-eyes rule; reject needs a reason; ownership; assignment rules; `allowed_actions` per user |
| `test/items.test.ts` | Validation; team scoping of lists; filters; text search; cursor pagination is complete and stable while data changes |

The concurrency tests were checked by deliberately removing the row lock and the
version check: the relevant tests fail without them and pass with them.

## API

All errors share one shape: `{ "error": { "code": "...", "message": "..." } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → user + teams/roles; sets session cookie |
| POST | `/api/auth/logout` | revokes the session |
| GET | `/api/auth/me` | current user + teams/roles |
| GET | `/api/items` | list; filters `team`, `status`, `priority`, `type` (comma-separated), `assignee` (`me`, `unassigned`, id), `q` (text search), `limit`, `cursor` → `{ items, nextCursor }` |
| POST | `/api/items` | create → 201 |
| GET | `/api/items/:id` | item + `allowed_actions` for you. 404 if it doesn't exist **or** belongs to a team you're not in |
| PATCH | `/api/items/:id` | edit `title`, `description`, `priority`, `next_step`, `due_at`. **Requires `version`**; 409 if stale |
| POST | `/api/items/:id/actions/:action` | workflow actions (below). All except `claim` require `version` |
| POST | `/api/items/:id/comments` | `{ body }` → 201 |
| GET | `/api/items/:id/activity` | history, newest first; `limit`, `cursor` |
| GET | `/api/teams/:id/members` | for assignment pickers |
| GET | `/api/health` | liveness + database check |

### Workflow

```
OPEN ──claim/assign──► IN_PROGRESS ──request_approval──► AWAITING_APPROVAL
  ▲                      │   ▲   │                          │        │
  └────── unassign ──────┘   │   └──── resolve ───┐       reject   approve
                             └───────── reopen ───┼─────────┘        │
                                                  ▼                  │
                                              RESOLVED ◄─────────────┘
                                                  │
                                                close ──► CLOSED (final)
```

| Action | Who | Body |
|---|---|---|
| `claim` | member/lead of the team | none (succeeds only if unassigned; repeating it is harmless) |
| `assign` | lead | `version`, `assignee_id` (must be a member/lead of the team) |
| `unassign`, `request_approval`, `resolve` | the assignee, or a lead | `version` (`unassign` takes an optional `reason`) |
| `approve` | a lead **other than the requester** | `version` |
| `reject` | a lead other than the requester | `version`, `reason` (required) |
| `close` | lead | `version` |
| `reopen` | lead | `version`, `reason` (required) |

`payment` and `compliance` items cannot be resolved directly; they must be approved.
Status and assignee can only change through these actions, never through `PATCH`.

| Status | Meaning |
|---|---|
| 400 | malformed request (`VALIDATION_ERROR`, with the bad fields listed) |
| 401 | not logged in |
| 403 | you can see the item but may not do this |
| 404 | not found, or not in your teams |
| 409 | `VERSION_CONFLICT` (response includes the `current` item) or `ALREADY_CLAIMED` (includes who claimed it) |
| 422 | breaks a business rule: `INVALID_TRANSITION`, `APPROVAL_REQUIRED`, `INVALID_ASSIGNEE`, `ITEM_CLOSED` |

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
| Arjun Mehta | arjun@newtonite.test | lead | — | lead |
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
    items/
      routes.ts           HTTP layer: validation and response shapes only
      service.ts          business logic; every change goes through mutateItem()
      workflow.ts         the state machine, as data
      events.ts           activity history (written in the same transaction)
      repository.ts       queries, cursor pagination, timeline
    teams/                team members endpoint
    db/
      pool.ts             connection pool + withTransaction helper
      migrate.ts          applies migrations/*.sql in order, exactly once
      seed.ts             demo teams, users and 5,000 work items
      migrations/
        001_init.sql      the schema
        002_sessions.sql  login sessions
        003_open_items_unassigned.sql   rule: OPEN items have no assignee
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
- **Workflow:** `OPEN → IN_PROGRESS → (AWAITING_APPROVAL →) RESOLVED → CLOSED`, with reopen and reject paths. `CLOSED` is final.
- **OPEN means nobody owns it yet.** Claiming or assigning moves an item to `IN_PROGRESS`.
- **Payment and compliance items need a lead's approval** before they are resolved, and the requester cannot approve their own request (four-eyes rule).
- **Comments don't change the item's version**, so commenting never makes someone else's edit conflict.
- **Items are never deleted.** They are closed, so history is preserved.
- **Authentication is deliberately simple** (seeded users, password login). A real deployment would use company SSO.

## Known limitations

- **No login rate limiting or account lockout.** Production would rate-limit `/api/auth/login` per IP and per account.
- **Expired sessions are ignored but not deleted.** A periodic cleanup job would remove them.
- **No user or team administration UI.** Users, teams and roles come from seed data.
- **Lists have one sort order** (most recently updated first) and **no total count**. Counting every match is slow on large tables; the dashboard (a later step) uses targeted queues instead.
- **Comments cannot be edited or deleted.** Intentional for an audit trail, but a real product might allow edits with history.
- **Conflict resolution is manual.** A stale save is rejected with the current item; the user re-applies their change. Field-level merging is possible future work.
- **Cookies are not marked `Secure` by default**, because the demo runs on plain `http://localhost`. Set `SECURE_COOKIES=true` behind HTTPS.
