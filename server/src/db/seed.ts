// Seed data: teams, users with different roles per team, and a few thousand
// work items so that filtering, search and pagination have something real to do.
//
// Safe to run repeatedly: it does nothing if users already exist.
// Uses a fixed random seed, so every run produces the same data.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from './pool.js';
import { config } from '../config.js';

export const SEED_PASSWORD = 'password123';

type Role = 'viewer' | 'member' | 'lead';

const TEAMS = ['Payments', 'Customer Support', 'Engineering'] as const;

// Deliberately mixed roles, so permission rules can be demonstrated:
// e.g. Asha leads Payments but can only view Customer Support.
const USERS: { name: string; email: string; roles: Partial<Record<(typeof TEAMS)[number], Role>> }[] = [
  { name: 'Asha Rao',     email: 'asha@newtonite.test',   roles: { Payments: 'lead', 'Customer Support': 'viewer' } },
  { name: 'Ravi Kumar',   email: 'ravi@newtonite.test',   roles: { Payments: 'member' } },
  { name: 'Meera Iyer',   email: 'meera@newtonite.test',  roles: { Payments: 'member', Engineering: 'member' } },
  { name: 'Kabir Shah',   email: 'kabir@newtonite.test',  roles: { 'Customer Support': 'lead' } },
  { name: 'Priya Nair',   email: 'priya@newtonite.test',  roles: { 'Customer Support': 'member', Payments: 'viewer' } },
  // Payments needs two leads: with the four-eyes rule, a lone lead's own approval
  // requests could never be approved.
  { name: 'Arjun Mehta',  email: 'arjun@newtonite.test',  roles: { Engineering: 'lead', Payments: 'lead' } },
  { name: 'Neha Gupta',   email: 'neha@newtonite.test',   roles: { Engineering: 'member', 'Customer Support': 'member' } },
  { name: 'Vikram Singh', email: 'vikram@newtonite.test', roles: { Engineering: 'viewer' } },
];

const TYPES_BY_TEAM: Record<(typeof TEAMS)[number], string[]> = {
  Payments: ['payment', 'compliance', 'incident', 'task'],
  'Customer Support': ['customer_issue', 'customer_issue', 'incident', 'task'],
  Engineering: ['incident', 'task', 'task', 'compliance'],
};

const TITLES: Record<string, string[]> = {
  payment: ['Refund not received', 'Duplicate charge reported', 'Settlement mismatch', 'Chargeback dispute', 'Payout delayed', 'Card declined unexpectedly'],
  compliance: ['KYC document review', 'Quarterly access review', 'Data retention request', 'Audit evidence request', 'Sanctions screening hit'],
  incident: ['API latency spike', 'Checkout errors elevated', 'Webhook delivery failures', 'Login outage in region', 'Database CPU at 95%'],
  customer_issue: ['Cannot update billing address', 'Account locked after reset', 'Invoice shows wrong amount', 'Export missing rows', 'Email notifications not arriving'],
  task: ['Rotate service credentials', 'Update runbook', 'Clean up stale feature flags', 'Upgrade dependency', 'Document escalation path'],
};

const CUSTOMERS = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Hooli', 'Stark Retail', 'Wayne Logistics', 'Tyrell Inc'];
const NEXT_STEPS = ['Reproduce the issue', 'Confirm with customer', 'Check provider logs', 'Waiting on finance', 'Prepare fix', 'Draft response', ''];

// Small deterministic PRNG (mulberry32) so seed data is identical on every run.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(itemCount = config.seedItemCount): Promise<boolean> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return false;

  const rand = rng(42);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const weighted = <T>(pairs: [T, number][]) => {
    let r = rand() * pairs.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of pairs) if ((r -= w) < 0) return v;
    return pairs[0][0];
  };

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  await withTransaction(async (db) => {
    const teamIds: Record<string, number> = {};
    for (const name of TEAMS) {
      const r = await db.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name]);
      teamIds[name] = Number(r.rows[0].id);
    }

    // team -> users who can own work there (members and leads)
    const workers: Record<string, number[]> = { Payments: [], 'Customer Support': [], Engineering: [] };
    for (const u of USERS) {
      const r = await db.query(
        'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [u.name, u.email, passwordHash],
      );
      const userId = Number(r.rows[0].id);
      for (const [team, role] of Object.entries(u.roles)) {
        await db.query('INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [userId, teamIds[team], role]);
        if (role !== 'viewer') workers[team].push(userId);
      }
    }

    // Insert work items in batches of 500 rows per INSERT statement.
    const now = Date.now();
    const DAY = 86_400_000;
    const BATCH = 500;
    for (let start = 0; start < itemCount; start += BATCH) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (let i = start; i < Math.min(start + BATCH, itemCount); i++) {
        const team = pick(TEAMS);
        const type = pick(TYPES_BY_TEAM[team]);
        const status = weighted<string>([['OPEN', 25], ['IN_PROGRESS', 20], ['AWAITING_APPROVAL', 5], ['RESOLVED', 15], ['CLOSED', 35]]);
        const priority = weighted<string>([['critical', 5], ['high', 20], ['medium', 45], ['low', 30]]);
        const creator = pick(workers[team]);
        // Open items are unassigned (enforced by the database); anything else has an owner.
        const assignee = status === 'OPEN' ? null : pick(workers[team]);
        const requester = status === 'AWAITING_APPROVAL' ? assignee : null;
        const createdAt = new Date(now - rand() * 90 * DAY);
        const updatedAt = new Date(Math.min(now, createdAt.getTime() + rand() * 20 * DAY));
        const dueAt = rand() < 0.6 ? new Date(createdAt.getTime() + (1 + rand() * 30) * DAY) : null;
        const title = `${pick(TITLES[type])} — ${pick(CUSTOMERS)}`;
        const description = `Seeded ${type.replace('_', ' ')} item #${i + 1}. Reported via ${pick(['email', 'phone', 'monitoring', 'internal review'])}.`;

        const row = [teamIds[team], title, description, type, status, priority, assignee, creator, requester, pick(NEXT_STEPS), dueAt, createdAt, updatedAt];
        const base = values.length;
        placeholders.push(`(${row.map((_, j) => `$${base + j + 1}`).join(', ')})`);
        values.push(...row);
      }
      await db.query(
        `INSERT INTO work_items
           (team_id, title, description, type, status, priority, assignee_id, created_by,
            approval_requested_by, next_step, due_at, created_at, updated_at)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    }

    // Every item gets a "created" event, so history is never empty.
    await db.query(`
      INSERT INTO activity_events (work_item_id, actor_id, type, payload, created_at)
      SELECT id, created_by, 'created', jsonb_build_object('title', title), created_at
      FROM work_items ORDER BY id`);
  });
  return true;
}

// Run directly: `npm run seed`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed()
    .then((created) => {
      console.log(created
        ? `Seeded ${USERS.length} users, ${TEAMS.length} teams, ${config.seedItemCount} work items. Password for every user: ${SEED_PASSWORD}`
        : 'Seed skipped: data already exists.');
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
