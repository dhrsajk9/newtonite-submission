import pg from 'pg';
import { config } from '../config.js';

// Postgres BIGINT (type 20) arrives as a string by default, because it can exceed
// JavaScript's safe integer range. Our ids and counts never will, so parse them as numbers.
pg.types.setTypeParser(20, (value) => Number(value));

// One shared connection pool for the whole process.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

/**
 * Run `fn` inside a database transaction.
 * Everything `fn` writes is committed together, or rolled back together if it throws.
 * This is what lets us write a change, its activity event and its outbox job atomically.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
