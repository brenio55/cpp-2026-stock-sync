import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMockApp } from '../src/app';

const batch = (version: number, stock = 5) => ({ items: [{ sku: 'A-1', stock, price: '9.90', version }] });
const post = (app: ReturnType<typeof createMockApp>, body: unknown, tenant = 't1') =>
  request(app).post('/v1/products/batch').set('x-tenant-id', tenant).send(body as object);

const reliable = { failureRate: 0, duplicateRate: 0 };

describe('mock ads service', () => {
  it('never lets an older version overwrite a newer one', async () => {
    const app = createMockApp(reliable);
    await post(app, batch(2, 0)).expect(200);
    const stale = await post(app, batch(1, 99)).expect(200);
    expect(stale.body).toEqual({ applied: 0, ignored: 1 });
    const state = await request(app).get('/_debug/state?tenant=t1');
    expect(state.body.products['A-1']).toMatchObject({ version: 2, stock: 0 });
  });

  it('treats a repeated update as a no-op', async () => {
    const app = createMockApp(reliable);
    await post(app, batch(1)).expect(200);
    const again = await post(app, batch(1)).expect(200);
    expect(again.body).toEqual({ applied: 0, ignored: 1 });
  });

  it('keeps tenants separate', async () => {
    const app = createMockApp(reliable);
    await post(app, batch(5, 1), 't1').expect(200);
    await post(app, batch(1, 7), 't2').expect(200);
    const state = await request(app).get('/_debug/state');
    expect(state.body.products.t1['A-1'].version).toBe(5);
    expect(state.body.products.t2['A-1'].version).toBe(1);
  });

  it('answers 429 above 5 requests in one second, and recovers afterwards', async () => {
    let clock = 1_000_000;
    const app = createMockApp({ ...reliable, now: () => clock });
    for (let i = 1; i <= 5; i++) await post(app, batch(i)).expect(200);
    await post(app, batch(6)).expect(429);
    clock += 1001;
    await post(app, batch(7)).expect(200);
  });

  it('fails with 500 when the random roll falls in the first half of the failure band', async () => {
    const app = createMockApp({ failureRate: 0.2, duplicateRate: 0, random: () => 0.05 });
    await post(app, batch(1)).expect(500);
  });

  it('rejects malformed input', async () => {
    const app = createMockApp(reliable);
    await post(app, { items: [] }).expect(400);
    await request(app).post('/v1/products/batch').send(batch(1)).expect(400); // no tenant header
  });
});
