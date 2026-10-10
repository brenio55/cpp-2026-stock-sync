import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { Logger } from 'pino';
import { z } from 'zod';
import { KEY_DEAD, UPDATES_QUEUE, publishJson, retryKey } from './rabbit';
import type { Incoming, Result, SyncProcessor } from './sync-processor';

const messageSchema = z.object({
  outboxId: z.number(),
  tenantId: z.string().uuid(),
  productId: z.string().uuid(),
  sku: z.string(),
  stock: z.number().int(),
  price: z.string(),
  version: z.number().int(),
});

export interface ConsumerOptions {
  channel: ConfirmChannel;
  processor: SyncProcessor;
  batchSize: number;
  /** max time a message waits in the buffer for the batch to fill */
  windowMs: number;
  log: Logger;
}

interface Buffered extends Incoming {
  delivery: ConsumeMessage;
}

/**
 * Pulls messages from RabbitMQ, buffers them briefly so several updates travel in one request, hands the
 * buffer to the SyncProcessor, then applies each outcome to the broker:
 *   SENT / SUPERSEDED -> ack
 *   RETRY             -> publish to the TTL retry queue (backoff) with x-attempts, then ack the original
 *   DEAD              -> publish to the DLQ, then ack the original
 * Publishing happens BEFORE the ack, so a crash in between duplicates a message instead of losing it.
 */
export class SyncConsumer {
  private buffer: Buffered[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private consumerTag: string | null = null;

  constructor(private readonly opts: ConsumerOptions) {}

  async start(): Promise<void> {
    const { channel, batchSize } = this.opts;
    // The broker will not deliver more than batchSize unacknowledged messages: that is the buffer limit.
    await channel.prefetch(batchSize);
    const { consumerTag } = await channel.consume(UPDATES_QUEUE, (delivery) => {
      if (delivery) void this.onDelivery(delivery);
    });
    this.consumerTag = consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.opts.channel.cancel(this.consumerTag);
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }

  private async onDelivery(delivery: ConsumeMessage): Promise<void> {
    const { channel, log } = this.opts;
    let parsed: z.infer<typeof messageSchema>;
    try {
      parsed = messageSchema.parse(JSON.parse(delivery.content.toString('utf8')));
    } catch {
      // Poison message: it can never succeed, so park it in the DLQ instead of looping forever.
      log.error({ body: delivery.content.toString('utf8').slice(0, 200) }, 'unparseable sync message, dead-lettering');
      await publishJson(channel, KEY_DEAD, { raw: delivery.content.toString('utf8') }, { reason: 'unparseable' });
      channel.ack(delivery);
      return;
    }

    const attempts = Number(delivery.properties.headers?.['x-attempts'] ?? 0);
    this.buffer.push({ msg: parsed, attempts, delivery });

    if (this.buffer.length >= this.opts.batchSize) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.windowMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const results = await this.opts.processor.processBatch(batch);
      await this.applyOutcomes(results, batch);
    } catch (err) {
      // Infrastructure problem (e.g. database down): give every message back to the broker untouched.
      this.opts.log.error({ err }, 'batch processing failed, requeueing');
      for (const b of batch) this.opts.channel.nack(b.delivery, false, true);
    } finally {
      this.flushing = false;
      if (this.buffer.length > 0) this.timer = setTimeout(() => void this.flush(), this.opts.windowMs);
    }
  }

  private async applyOutcomes(results: Result[], batch: Buffered[]): Promise<void> {
    const { channel, log } = this.opts;
    const deliveryOf = new Map<Incoming, ConsumeMessage>(batch.map((b) => [b, b.delivery]));
    for (const { item, outcome } of results) {
      const delivery = deliveryOf.get(item)!;
      try {
        if (outcome.type === 'RETRY') {
          await publishJson(channel, retryKey(outcome.delayMs), item.msg, { 'x-attempts': outcome.attempts });
        } else if (outcome.type === 'DEAD') {
          await publishJson(channel, KEY_DEAD, item.msg, { 'x-attempts': outcome.attempts, 'x-error': outcome.error });
        }
        channel.ack(delivery);
      } catch (err) {
        // Only this message goes back; the ones already acked in this loop must not be touched again.
        log.error({ err }, 'could not republish sync message, requeueing it');
        channel.nack(delivery, false, true);
      }
    }
  }
}