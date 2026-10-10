import { env } from './config/env';
import { logger } from './common/logger';
import { HttpAdsClient } from './integrations/ads-client';
import { pool } from './db/pool';
import { OutboxRelay } from './messaging/outbox-relay';
import { KEY_UPDATE, assertTopology, connectRabbit, publishJson } from './messaging/rabbit';
import { RateLimiter } from './messaging/rate-limiter';
import { SyncConsumer } from './messaging/sync-consumer';
import { SyncProcessor } from './messaging/sync-processor';

/**
 * Background process: outbox relay (Postgres -> RabbitMQ) and sync consumer (RabbitMQ -> ads service).
 * If the broker connection drops the process exits and the orchestrator (docker restart policy) restarts it;
 * nothing is lost because unrelayed events stay in the outbox and unacked messages return to the queue.
 */
async function main() {
  const connection = await connectRabbit(env.RABBITMQ_URL);
  connection.on('error', (err) => logger.error({ err }, 'rabbitmq connection error'));
  connection.on('close', () => {
    logger.error('rabbitmq connection closed, exiting');
    process.exit(1);
  });

  const relayChannel = await connection.createConfirmChannel();
  const consumerChannel = await connection.createConfirmChannel();
  await assertTopology(relayChannel, env.SYNC_RETRY_DELAYS_MS);

  const relay = new OutboxRelay({
    publish: (message) => publishJson(relayChannel, KEY_UPDATE, message),
    batchSize: env.RELAY_BATCH_SIZE,
    pollMs: env.RELAY_POLL_MS,
    log: logger.child({ component: 'relay' }),
  });

  const processor = new SyncProcessor({
    ads: new HttpAdsClient(env.ADS_API_URL, env.ADS_TIMEOUT_MS),
    limiter: new RateLimiter(env.SYNC_RATE_LIMIT_RPS),
    maxAttempts: env.SYNC_MAX_ATTEMPTS,
    retryDelaysMs: env.SYNC_RETRY_DELAYS_MS,
    log: logger.child({ component: 'sync' }),
  });
  const consumer = new SyncConsumer({
    channel: consumerChannel,
    processor,
    batchSize: env.SYNC_BATCH_SIZE,
    windowMs: env.SYNC_BATCH_WINDOW_MS,
    log: logger.child({ component: 'consumer' }),
  });

  relay.start();
  await consumer.start();
  logger.info('worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    connection.removeAllListeners('close');
    await relay.stop();
    await consumer.stop();
    await connection.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
