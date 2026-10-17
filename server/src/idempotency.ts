// ─────────────────────────────────────────────────────────────────────────────
// Idempotency keys: a retried request is answered, not executed again.
//
// The browser generates a random key when the user STARTS an action (clicks
// "Create") and sends it as the `Idempotency-Key` header on every attempt of
// that action: the first try, a double-click, a network retry.
//
// The key is recorded IN THE SAME TRANSACTION as the work it protects:
//   • First request:  insert key → do the work → store the response → commit.
//   • Retry later:    the insert hits the existing key → replay the stored response.
//   • Retry at the SAME moment: Postgres makes the second insert wait until the
//     first transaction finishes, then it sees the key and replays the response.
//   • Work fails:     the whole transaction rolls back, key included, so the
//     client can safely retry.
// Because key and work commit together, a crash can never leave "the item was
// created but the key wasn't stored" (which would let a retry create it twice).
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { withTransaction } from './db/pool.js';
import { BusinessRuleError, ValidationError } from './errors.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

/** How long a key is remembered. The worker deletes older keys. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

export async function idempotent<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: number,
  successStatus: number,
  work: (tx: PoolClient) => Promise<T>,
) {
  const key = request.headers['idempotency-key'];

  // No key: behave like a normal request (the header is optional for API clients).
  if (key === undefined) {
    const body = await withTransaction(work);
    return reply.status(successStatus).send(body);
  }
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
    throw new ValidationError('Idempotency-Key must be 8–128 letters, digits, "-" or "_".');
  }

  // Fingerprint of the request, to catch one key reused for a different request.
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ method: request.method, url: request.url, body: request.body ?? null }))
    .digest('hex');

  const result = await withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING key`,
      [userId, key, requestHash],
    );

    if (inserted.rowCount === 0) {
      // Seen before (and committed, or we would still be waiting on the insert above).
      const { rows } = await tx.query(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      if (rows[0].request_hash !== requestHash) {
        throw new BusinessRuleError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      return { status: rows[0].response_status as number, body: rows[0].response_body, replayed: true };
    }

    const body = await work(tx);
    await tx.query(
      'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2',
      [userId, key, successStatus, JSON.stringify(body)],
    );
    return { status: successStatus, body, replayed: false };
  });

  if (result.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.status(result.status).send(result.body);
}
