import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';

export const EXCHANGE = 'stocksync.sync';
export const UPDATES_QUEUE = 'sync.updates';
export const DLQ = 'sync.dlq';

export const KEY_UPDATE = 'update';
export const KEY_DEAD = 'dead';
export const retryKey = (delayMs: number) => `retry.${delayMs}`;
export const retryQueueName = (delayMs: number) => `sync.retry.${delayMs}ms`;

export const connectRabbit = (url: string): Promise<ChannelModel> => amqp.connect(url);

/**
 * Declares the whole topology (idempotent, safe to run from every process):
 *
 *   stocksync.sync (direct exchange)
 *     update          -> sync.updates              main work queue
 *     retry.<ms>      -> sync.retry.<ms>ms         no consumer; messages expire after <ms> and are
 *                                                  dead-lettered back to `update`  (this IS the backoff)
 *     dead            -> sync.dlq                  dead-letter queue, kept for inspection / manual retry
 *
 * The delay is part of the retry queue's name because a queue's TTL cannot be redeclared with a different value.
 */
export async function assertTopology(ch: Channel, retryDelaysMs: number[]): Promise<void> {
  await ch.assertExchange(EXCHANGE, 'direct', { durable: true });

  await ch.assertQueue(UPDATES_QUEUE, { durable: true });
  await ch.bindQueue(UPDATES_QUEUE, EXCHANGE, KEY_UPDATE);

  await ch.assertQueue(DLQ, { durable: true });
  await ch.bindQueue(DLQ, EXCHANGE, KEY_DEAD);

  for (const delay of new Set(retryDelaysMs)) {
    const queue = retryQueueName(delay);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-message-ttl': delay,
        'x-dead-letter-exchange': EXCHANGE,
        'x-dead-letter-routing-key': KEY_UPDATE,
      },
    });
    await ch.bindQueue(queue, EXCHANGE, retryKey(delay));
  }
}

/** Publishes a persistent JSON message and resolves only when the broker has confirmed it. */
export function publishJson(
  ch: ConfirmChannel,
  routingKey: string,
  payload: unknown,
  headers: Record<string, unknown> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    ch.publish(
      EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json', headers },
      (err) => (err ? reject(err instanceof Error ? err : new Error('broker nack')) : resolve()),
    );
  });
}
