import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/common/logger';
import { pool } from '../src/db/pool';
import { AdsError, type AdsClient, type AdsItem } from '../src/integrations/ads-client';
import { OutboxRelay } from '../src/messaging/outbox-relay';
import { SyncProcessor, type Incoming } from '../src/messaging/sync-processor';
import type { SyncMessage } from '../src/modules/sync/repository';
import { api, bearer, createTenant, resetDb, type TestTenant } from './helpers/factory';

/** Ads service double: records every call and fails on demand. */
class FakeAds implements AdsClient {
  calls: { tenantId: string; items: AdsItem[] }[] = [];
  constructor(private readonly failWhen: (callNumber: number, tenantId: string) => boolean = () => false) {}
  async sendBatch(tenantId: string, items: AdsItem[]): Promise<void> {
    this.calls.push({ tenantId, items });
    if (this.failWhen(this.calls.length, tenantId)) throw new AdsError('ads service responded with HTTP 500', 500);
  }
}

const DELAYS = [10, 20, 40];
const makeProcessor = (ads: AdsClient, maxAttempts = 5) => {
  const limiter = { acquire: vi.fn(async () => undefined) };
  return { limiter, processor: new SyncProcessor({ ads, limiter, maxAttempts, retryDelaysMs: DELAYS, log: logger }) };
};

/** Runs the relay against the real database, capturing what it would publish to RabbitMQ. */
async function relayAll(): Promise<SyncMessage[]> {
  const published: SyncMessage[] = [];
  const relay = new OutboxRelay({ publish: async (m) => void published.push(m), batchSize: 100, pollMs: 10, log: logger });
  while ((await relay.runOnce()) > 0);
  return published;
}

const incoming = (msg: SyncMessage, attempts = 0): Incoming => ({ msg, attempts });

async function syncRow(productId: string, version: number) {
  const res = await pool.query('SELECT status, attempts, last_error FROM sync_updates WHERE product_id = $1 AND version = $2', [
    productId,
    version,
  ]);
  return res.rows[0] as { status: string; attempts: number; last_error: string | null };
}

let tenant: TestTenant;
let productId: string;

/** product created with stock 10 (version 1), then one unit sold (version 2) */
async function createChangingProduct(t: TestTenant, sku = 'SKU-1'): Promise<string> {
  const created = await api().post('/products').set(bearer(t.admin.token)).send({ sku, name: sku, price: '10.00', stock: 10 });
  await api().post('/sales').set(bearer(t.operator.token)).send({ items: [{ productId: created.body.id, quantity: 1 }] }).expect(201);
  return created.body.id;
}

beforeEach(async () => {
  await resetDb();
  tenant = await createTenant();
  productId = await createChangingProduct(tenant);
});

describe('sync retry behaviour', () => {
  it('retries a transient failure with increasing backoff and finally succeeds', async () => {
    const [, v2] = await relayAll();
    const ads = new FakeAds((n) => n <= 2); // first two calls fail
    const { processor } = makeProcessor(ads);

    const first = await processor.processBatch([incoming(v2!)]);
    expect(first[0]!.outcome).toEqual({ type: 'RETRY', delayMs: 10, attempts: 1 });
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'PENDING', attempts: 1, last_error: expect.stringContaining('500') });

    const second = await processor.processBatch([incoming(v2!, 1)]);
    expect(second[0]!.outcome).toEqual({ type: 'RETRY', delayMs: 20, attempts: 2 }); // longer wait each time

    const third = await processor.processBatch([incoming(v2!, 2)]);
    expect(third[0]!.outcome).toEqual({ type: 'SENT' });
    expect(ads.calls).toHaveLength(3);
    expect(await syncRow(productId, 2)).toEqual({ status: 'SENT', attempts: 3, last_error: null });

    const status = await api().get('/sync/status').set(bearer(tenant.admin.token));
    expect(status.body.counts).toMatchObject({ sent: 1, failed: 0 });
    expect(status.body.lastSuccessAt).not.toBeNull();
  });

  it('gives up after the maximum number of attempts: FAILED, exposed in the status, and recoverable by an admin', async () => {
    const [, v2] = await relayAll();
    const down = new FakeAds(() => true); // always fails
    const { processor } = makeProcessor(down, 3);

    const outcomes = [];
    let attempts = 0;
    for (;;) {
      const [result] = await processor.processBatch([incoming(v2!, attempts)]);
      outcomes.push(result!.outcome.type);
      if (result!.outcome.type !== 'RETRY') break;
      attempts = result!.outcome.attempts;
    }
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'DEAD']);
    expect(down.calls).toHaveLength(3); // exactly maxAttempts calls, no more
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'FAILED', attempts: 3 });

    const status = await api().get('/sync/status').set(bearer(tenant.admin.token));
    expect(status.body.counts.failed).toBe(1);
    expect(status.body.recentFailures[0]).toMatchObject({ sku: 'SKU-1', version: 2, attempts: 3 });

    // Admin re-queues it; once the ads service is healthy again it goes through.
    const failedId = status.body.recentFailures[0].id;
    await api().post(`/sync/failed/${failedId}/retry`).set(bearer(tenant.operator.token)).expect(403);
    const retry = await api().post(`/sync/failed/${failedId}/retry`).set(bearer(tenant.admin.token));
    expect(retry.status).toBe(202);
    expect(retry.body.status).toBe('PENDING');

    const republished = await relayAll();
    expect(republished.map((m) => m.version)).toEqual([2]);
    const healthy = new FakeAds();
    const [recovered] = await makeProcessor(healthy).processor.processBatch([incoming(republished[0]!)]);
    expect(recovered!.outcome.type).toBe('SENT');
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'SENT' });
  });
});

describe('duplicates and out-of-order delivery', () => {
  it('an old version arriving after a newer one is dropped and never sent', async () => {
    const [v1, v2] = await relayAll();
    const ads = new FakeAds();
    const { processor } = makeProcessor(ads);

    await processor.processBatch([incoming(v2!)]); // newest arrives first
    const late = await processor.processBatch([incoming(v1!)]); // then the old one

    expect(late[0]!.outcome.type).toBe('SUPERSEDED');
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]!.items).toEqual([{ sku: 'SKU-1', stock: 9, price: '10.00', version: 2 }]);
    expect(await syncRow(productId, 1)).toMatchObject({ status: 'SUPERSEDED' });
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'SENT' });
  });

  it('a redelivered message that was already sent is acknowledged without calling the ads service again', async () => {
    const [, v2] = await relayAll();
    const ads = new FakeAds();
    const { processor } = makeProcessor(ads);

    await processor.processBatch([incoming(v2!)]);
    const again = await processor.processBatch([incoming(v2!)]);

    expect(again[0]!.outcome.type).toBe('SUPERSEDED');
    expect(ads.calls).toHaveLength(1);
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'SENT', attempts: 1 }); // untouched
  });

  it('when several versions of a product are in one batch, only the newest is sent', async () => {
    const [v1, v2] = await relayAll();
    const ads = new FakeAds();
    const { processor } = makeProcessor(ads);

    const results = await processor.processBatch([incoming(v2!), incoming(v1!), incoming(v2!)]);

    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]!.items).toHaveLength(1);
    expect(ads.calls[0]!.items[0]).toMatchObject({ version: 2, stock: 9 });
    expect(results.filter((r) => r.outcome.type === 'SENT')).toHaveLength(1);
    expect(results).toHaveLength(3); // every message gets an outcome, so every message is acked
    expect(await syncRow(productId, 2)).toMatchObject({ status: 'SENT' });
    expect(await syncRow(productId, 1)).toMatchObject({ status: 'SUPERSEDED' });
  });

  it('a retry of an old version is dropped once a newer version has been sent', async () => {
    // v1 is the only version that exists when it first fails ...
    const t = await createTenant();
    const created = await api().post('/products').set(bearer(t.admin.token)).send({ sku: 'LATE-1', name: 'late', price: '1.00', stock: 5 });
    const [v1] = (await relayAll()).filter((m) => m.tenantId === t.id);
    const [waiting] = await makeProcessor(new FakeAds(() => true)).processor.processBatch([incoming(v1!)]);
    expect(waiting!.outcome.type).toBe('RETRY'); // now sitting in a retry queue

    // ... meanwhile the product changes and v2 goes through ...
    await api().post('/sales').set(bearer(t.operator.token)).send({ items: [{ productId: created.body.id, quantity: 1 }] }).expect(201);
    const [v2] = (await relayAll()).filter((m) => m.tenantId === t.id);
    expect(v2!.version).toBe(2);
    const ads = new FakeAds();
    const { processor } = makeProcessor(ads);
    expect((await processor.processBatch([incoming(v2!)]))[0]!.outcome.type).toBe('SENT');

    // ... so when the retry of v1 comes back it must not be sent.
    const [late] = await processor.processBatch([incoming(v1!, 1)]);
    expect(late!.outcome.type).toBe('SUPERSEDED');
    expect(ads.calls).toHaveLength(1);
    expect(ads.calls[0]!.items[0]).toMatchObject({ version: 2, stock: 4 });
  });

  it('does not even try to send a version while a newer one is already pending', async () => {
    const [v1] = await relayAll(); // the beforeEach product has v1 and v2 both pending
    const ads = new FakeAds();
    const [result] = await makeProcessor(ads).processor.processBatch([incoming(v1!)]);
    expect(result!.outcome.type).toBe('SUPERSEDED');
    expect(ads.calls).toHaveLength(0);
  });
});

describe('tenant isolation in background processing', () => {
  it('never mixes tenants in one request, and one tenant failing does not affect another', async () => {
    const other = await createTenant();
    await createChangingProduct(other, 'SKU-OTHER');
    const messages = await relayAll();
    const v2s = messages.filter((m) => m.version === 2);
    expect(v2s).toHaveLength(2);

    const ads = new FakeAds((_, tenantId) => tenantId === tenant.id); // only the first tenant's calls fail
    const { processor, limiter } = makeProcessor(ads);
    const results = await processor.processBatch(v2s.map((m) => incoming(m)));

    expect(ads.calls).toHaveLength(2);
    expect(limiter.acquire).toHaveBeenCalledTimes(2); // one rate-limited request per tenant batch
    for (const call of ads.calls) {
      const owner = call.tenantId === tenant.id ? 'SKU-1' : 'SKU-OTHER';
      expect(call.items.map((i) => i.sku)).toEqual([owner]);
    }
    const byTenant = new Map(results.map((r) => [r.item.msg.tenantId, r.outcome.type]));
    expect(byTenant.get(tenant.id)).toBe('RETRY');
    expect(byTenant.get(other.id)).toBe('SENT');

    const own = await api().get('/sync/status').set(bearer(tenant.admin.token));
    const theirs = await api().get('/sync/status').set(bearer(other.admin.token));
    expect(own.body.lastSuccessAt).toBeNull();
    expect(theirs.body.lastSuccessAt).not.toBeNull();
    expect(theirs.body.counts.sent).toBe(1);
  });
});

describe('outbox relay', () => {
  it('publishes committed events once, in order, and creates the pending tracking rows', async () => {
    const published = await relayAll();
    expect(published.map((m) => m.version)).toEqual([1, 2]);
    expect(await relayAll()).toEqual([]); // nothing left: events are marked as published

    const status = await api().get('/sync/status').set(bearer(tenant.admin.token));
    expect(status.body.counts.pending).toBe(2);
  });

  it('counts events still in the outbox as pending, before the worker has relayed them', async () => {
    const status = await api().get('/sync/status').set(bearer(tenant.admin.token));
    expect(status.body.counts.pending).toBe(2);
  });

  it('rolls back when the broker rejects a publish: nothing is marked published, and a later pass succeeds', async () => {
    const failing = new OutboxRelay({
      publish: async () => {
        throw new Error('broker unavailable');
      },
      batchSize: 100,
      pollMs: 10,
      log: logger,
    });
    await expect(failing.runOnce()).rejects.toThrow('broker unavailable');

    const unpublished = await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
    expect(unpublished.rows[0].n).toBe(2);
    const rows = await pool.query('SELECT count(*)::int AS n FROM sync_updates');
    expect(rows.rows[0].n).toBe(0);

    expect(await relayAll()).toHaveLength(2);
  });
});
