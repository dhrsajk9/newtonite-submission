// ─────────────────────────────────────────────────────────────────────────────
// The job queue: an `outbox_jobs` table in Postgres, processed by the worker.
//
// processNextJob() takes ONE pending job in its own transaction:
//   SELECT … FOR UPDATE SKIP LOCKED
//     → locks the job; other workers SKIP it instead of waiting, so several
//       workers can run side by side without ever taking the same job.
//   run the handler (inside a savepoint)
//     → success: the handler's writes + "status = done" commit together.
//     → failure: undo the handler's writes, record the error, retry later with
//       exponential backoff (2s, 4s, 8s, 16s…); after MAX_ATTEMPTS → "dead",
//       kept for a human to inspect instead of retrying forever.
//   If the worker process dies mid-job, its transaction is rolled back by
//   Postgres, the lock is released, and the job is simply picked up again.
//
// Delivery is therefore "at least once": a handler may run more than once for
// the same job, so every handler must be idempotent (see notify.ts).
// ─────────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { IDEMPOTENCY_KEY_TTL_HOURS } from '../idempotency.js';
import { handleNotify } from './notify.js';

export const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_SECONDS = 300;

export type JobHandler = (tx: PoolClient, payload: any) => Promise<void>;
export type Handlers = Record<string, JobHandler>;

export const defaultHandlers: Handlers = { notify: handleNotify };

export interface ProcessOptions {
  handlers?: Handlers;
  /** Tests only: process this specific job. */
  jobId?: number;
}

export type ProcessResult = 'none' | 'done' | 'retry' | 'dead';

export async function processNextJob({ handlers = defaultHandlers, jobId }: ProcessOptions = {}): Promise<ProcessResult> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, type, payload, attempts FROM outbox_jobs
        WHERE status = 'pending' AND run_after <= now() AND ($1::bigint IS NULL OR id = $1)
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [jobId ?? null],
    );
    const job = rows[0];
    if (!job) return 'none';

    await tx.query('SAVEPOINT job');
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      await handler(tx, job.payload);
      await tx.query(`UPDATE outbox_jobs SET status = 'done', updated_at = now() WHERE id = $1`, [job.id]);
      return 'done';
    } catch (err) {
      // Undo whatever the handler wrote, but keep the job row locked and record the failure.
      await tx.query('ROLLBACK TO SAVEPOINT job');
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
      await tx.query(
        `UPDATE outbox_jobs
            SET attempts = $2, last_error = $3, updated_at = now(),
                status = CASE WHEN $4 THEN 'dead' ELSE 'pending' END,
                run_after = now() + make_interval(secs => $5)
          WHERE id = $1`,
        [job.id, attempts, String((err as Error).message ?? err).slice(0, 2000), dead, backoff],
      );
      return dead ? 'dead' : 'retry';
    }
  });
}

/** Processes jobs until none are ready. Used by tests and by the worker loop. */
export async function drain(options: ProcessOptions = {}): Promise<number> {
  let processed = 0;
  while ((await processNextJob(options)) !== 'none') processed++;
  return processed;
}

/** Housekeeping: forget old idempotency keys and expired sessions. */
export async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [
    IDEMPOTENCY_KEY_TTL_HOURS,
  ]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}
