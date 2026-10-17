// The background worker process: `npm run worker`.
// Runs separately from the API, so slow or failing side effects never slow down
// or break a user's request. Several copies can run at once (SKIP LOCKED).
import { pool } from '../db/pool.js';
import { cleanup, processNextJob } from './queue.js';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1000);
const CLEANUP_EVERY_MS = 10 * 60 * 1000;

let running = true;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Worker started (polling every ${POLL_MS} ms).`);
  let lastCleanup = 0;
  while (running) {
    try {
      const result = await processNextJob();
      if (result !== 'none') {
        if (result !== 'done') console.warn(`Job failed (${result}).`);
        continue; // there may be more work: check again immediately
      }
      if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
        await cleanup();
        lastCleanup = Date.now();
      }
    } catch (err) {
      // e.g. the database is briefly unreachable: log, wait, try again.
      console.error('Worker error:', (err as Error).message);
    }
    await sleep(POLL_MS);
  }
  await pool.end();
  console.log('Worker stopped.');
}

// Graceful shutdown: finish the current job, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running = false;
  });
}

main();
