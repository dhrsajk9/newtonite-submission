# Newtonite Work Items

An internal tool for tracking operational work (customer issues, incidents,
payment investigations, compliance tasks, approvals), with team-based
permissions, a full activity history, and safe handling of concurrent edits.

> Status: **Step 1 — foundation** (schema, migrations, seed data, health check).
> Later steps add the API, authorization, concurrency handling, background worker, and UI.

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
    app.ts                HTTP routes (built without listening, so tests can call them)
    index.ts              starts the server
    config.ts             settings from environment variables
    db/
      pool.ts             connection pool + withTransaction helper
      migrate.ts          applies migrations/*.sql in order, exactly once
      seed.ts             demo teams, users and 5,000 work items
      migrations/
        001_init.sql      the schema
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

_Filled in as the project progresses._
