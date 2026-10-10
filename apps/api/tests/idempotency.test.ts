import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, countRows, createProduct, createTenant, resetDb, stockOf, type TestTenant } from './helpers/factory';

let tenant: TestTenant;

beforeEach(async () => {
  await resetDb();
  tenant = await createTenant();
});

const post = (items: { productId: string; quantity: number }[], key?: string) => {
  const req = api().post('/sales').set(bearer(tenant.operator.token));
  if (key) req.set('Idempotency-Key', key);
  return req.send({ items });
};

describe('POST /sales idempotency', () => {
  it('retrying the same request returns the original response and registers the sale once', async () => {
    const product = await createProduct(tenant.id, { stock: 10 });
    const key = randomUUID();
    const items = [{ productId: product.id, quantity: 3 }];

    const first = await post(items, key);
    const retry = await post(items, key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body); // same sale id, same total
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    expect(await stockOf(product.id)).toBe(7); // decremented once, not twice
    expect(await countRows('sales')).toBe(1);
    expect(await countRows('stock_movements', `reason = 'SALE'`)).toBe(1);
    expect(await countRows('outbox_events')).toBe(1);
  });

  it('simultaneous duplicates (a client double-submit) still register exactly one sale', async () => {
    const product = await createProduct(tenant.id, { stock: 100 });
    const key = randomUUID();
    const items = [{ productId: product.id, quantity: 4 }];

    const responses = await Promise.all(Array.from({ length: 12 }, () => post(items, key)));

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(await stockOf(product.id)).toBe(96);
    expect(await countRows('sales')).toBe(1);
  });

  it('the same key with a different body is rejected with 422 and changes nothing', async () => {
    const product = await createProduct(tenant.id, { stock: 10 });
    const key = randomUUID();
    await post([{ productId: product.id, quantity: 1 }], key).expect(201);

    const reuse = await post([{ productId: product.id, quantity: 5 }], key);
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await stockOf(product.id)).toBe(9);
  });

  it('item order does not matter: the same sale listed in a different order is the same request', async () => {
    const a = await createProduct(tenant.id, { stock: 10 });
    const b = await createProduct(tenant.id, { stock: 10 });
    const key = randomUUID();
    const first = await post([{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 2 }], key);
    const second = await post([{ productId: b.id, quantity: 2 }, { productId: a.id, quantity: 1 }], key);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await countRows('sales')).toBe(1);
  });

  it('a failed sale does not consume the key: after restocking, the same key succeeds', async () => {
    const product = await createProduct(tenant.id, { stock: 1 });
    const key = randomUUID();
    const items = [{ productId: product.id, quantity: 2 }];

    const failed = await post(items, key);
    expect(failed.status).toBe(409);
    expect(await countRows('idempotency_keys')).toBe(0);

    await api().post(`/products/${product.id}/adjust-stock`).set(bearer(tenant.admin.token)).send({ delta: 5 }).expect(200);
    const retried = await post(items, key);
    expect(retried.status).toBe(201);
    expect(await stockOf(product.id)).toBe(4);
  });

  it('without a key every request is a new sale', async () => {
    const product = await createProduct(tenant.id, { stock: 10 });
    await post([{ productId: product.id, quantity: 1 }]).expect(201);
    await post([{ productId: product.id, quantity: 1 }]).expect(201);
    expect(await stockOf(product.id)).toBe(8);
  });

  it('rejects a malformed key', async () => {
    const product = await createProduct(tenant.id, { stock: 1 });
    const res = await post([{ productId: product.id, quantity: 1 }], 'has spaces in it');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});
