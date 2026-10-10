import { Router } from 'express';
import { env } from '../../config/env';
import { pool } from '../../db/pool';
import { DLQ, UPDATES_QUEUE, connectRabbit } from '../../messaging/rabbit';

export const healthRouter = Router();

/** Queue depths straight from the broker. A short-lived connection keeps the API free of broker state. */
async function queueDepths(): Promise<{ updates: number; deadLetter: number } | null> {
  let conn: Awaited<ReturnType<typeof connectRabbit>> | undefined;
  try {
    conn = await Promise.race([
      connectRabbit(env.RABBITMQ_URL),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    const ch = await conn.createChannel();
    // checkQueue closes the channel if the queue does not exist yet (worker not started): that is "unknown".
    const [updates, dlq] = [await ch.checkQueue(UPDATES_QUEUE), await ch.checkQueue(DLQ)];
    return { updates: updates.messageCount, deadLetter: dlq.messageCount };
  } catch {
    return null;
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

// Public on purpose (load balancer / compose healthchecks). Exposes counts only, never tenant data.
healthRouter.get('/', async (_req, res) => {
  try {
    const [db, broker] = await Promise.all([
      pool.query(`
        SELECT (SELECT count(*)::int FROM outbox_events WHERE published_at IS NULL) AS outbox_unpublished,
               (SELECT count(*)::int FROM sync_updates WHERE status = 'PENDING')    AS sync_pending,
               (SELECT count(*)::int FROM sync_updates WHERE status = 'FAILED')     AS sync_failed,
               (SELECT max(last_success_at) FROM sync_state)                        AS last_sync`),
      queueDepths(),
    ]);
    const row = db.rows[0];
    res.json({
      status: broker ? 'ok' : 'degraded',
      database: 'up',
      broker: broker ? 'up' : 'down',
      outbox: { unpublished: row.outbox_unpublished },
      sync: {
        pending: row.sync_pending,
        failed: row.sync_failed,
        lastSuccessAt: row.last_sync?.toISOString() ?? null,
      },
      queues: broker,
    });
  } catch {
    res.status(503).json({ status: 'down', database: 'down' });
  }
});
