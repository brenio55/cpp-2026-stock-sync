import type { PoolClient } from 'pg';
import { pool } from './pool';

/**
 * Runs `fn` inside a single transaction on a dedicated connection.
 * Commits when `fn` resolves, rolls back and rethrows when it throws.
 * Every repository function that must take part in the transaction receives the `client`.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}
