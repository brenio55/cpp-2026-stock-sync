import type { Logger } from 'pino';
import { pool } from '../db/pool';
import { withTransaction } from '../db/transaction';
import type { SyncMessage } from '../modules/sync/repository';

export interface RelayOptions {
  /** Publishes one message and resolves once the broker has confirmed it. */
  publish: (message: SyncMessage) => Promise<void>;
  batchSize: number;
  pollMs: number;
  log: Logger;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Moves committed outbox rows to RabbitMQ.
 *
 * Each pass runs in one transaction: lock a batch with FOR UPDATE SKIP LOCKED (so several workers can run
 * side by side without double-claiming), create the PENDING sync_updates row, publish with broker
 * confirmation, then stamp published_at. If publishing fails, the transaction rolls back and the rows are
 * picked up again later. A crash after publishing but before commit re-publishes, which is a harmless
 * duplicate because consumers deduplicate by (product, version).
 */
export class OutboxRelay {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: RelayOptions) {}

  /** One relay pass. Returns how many events were published. */
  async runOnce(): Promise<number> {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, product_id, sku, stock, price, version
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.opts.batchSize],
      );
      if (rows.length === 0) return 0;

      for (const r of rows) {
        const message: SyncMessage = {
          outboxId: r.id,
          tenantId: r.tenant_id,
          productId: r.product_id,
          sku: r.sku,
          stock: r.stock,
          price: r.price,
          version: r.version,
        };
        await client.query(
          `INSERT INTO sync_updates (tenant_id, product_id, sku, version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, product_id, version) DO NOTHING`,
          [message.tenantId, message.productId, message.sku, message.version],
        );
        await this.opts.publish(message);
      }

      await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ]);
      return rows.length;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let relayed = 0;
      try {
        relayed = await this.runOnce();
      } catch (err) {
        this.opts.log.error({ err }, 'outbox relay pass failed; will retry');
      }
      // A full batch means there is probably more waiting: go again immediately.
      if (relayed < this.opts.batchSize) await sleep(this.opts.pollMs);
    }
  }
}

/** Number of events not yet relayed (for /health). */
export async function countUnpublished(): Promise<number> {
  const res = await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
  return res.rows[0].n;
}
