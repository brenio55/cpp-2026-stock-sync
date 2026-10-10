import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, createProduct, createTenant, resetDb, stockOf, type TestProduct, type TestTenant } from './helpers/factory';

let a: TestTenant;
let b: TestTenant;
let productOfB: TestProduct;

beforeEach(async () => {
  await resetDb();
  a = await createTenant('acme');
  b = await createTenant('globex');
  productOfB = await createProduct(b.id, { sku: 'SECRET-B', stock: 20, price: '99.00' });
});

describe('a user can never see or change another tenant data', () => {
  it('cannot read, update, delete or adjust a product of another tenant (404, as if it did not exist)', async () => {
    const asA = bearer(a.admin.token);
    expect((await api().get(`/products/${productOfB.id}`).set(asA)).status).toBe(404);
    expect((await api().patch(`/products/${productOfB.id}`).set(asA).send({ price: '1.00' })).status).toBe(404);
    expect((await api().post(`/products/${productOfB.id}/adjust-stock`).set(asA).send({ delta: 5 })).status).toBe(404);
    expect((await api().delete(`/products/${productOfB.id}`).set(asA)).status).toBe(404);

    // ...and nothing changed
    const asB = await api().get(`/products/${productOfB.id}`).set(bearer(b.admin.token));
    expect(asB.status).toBe(200);
    expect(asB.body).toMatchObject({ price: '99.00', stock: 20 });
  });

  it('cannot sell a product of another tenant, and its stock is untouched', async () => {
    const res = await api()
      .post('/sales')
      .set(bearer(a.operator.token))
      .send({ items: [{ productId: productOfB.id, quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(await stockOf(productOfB.id)).toBe(20);
  });

  it('lists only its own products, movements and sync status', async () => {
    await createProduct(a.id, { sku: 'ONLY-A', stock: 3 });
    await api().post('/products').set(bearer(b.admin.token)).send({ sku: 'B-NEW', name: 'B new', price: '1.00', stock: 4 });

    const products = await api().get('/products').set(bearer(a.admin.token));
    expect(products.body.data.map((p: { sku: string }) => p.sku)).toEqual(['ONLY-A']);
    expect(products.body.meta.total).toBe(1);

    const movements = await api().get('/stock-movements').set(bearer(a.admin.token));
    expect(movements.body.data).toEqual([]);
    const movementsOfB = await api().get('/stock-movements').set(bearer(b.admin.token));
    expect(movementsOfB.body.data).toHaveLength(1);

    const syncA = await api().get('/sync/status').set(bearer(a.admin.token));
    const syncB = await api().get('/sync/status').set(bearer(b.admin.token));
    expect(syncA.body.counts.pending).toBe(0);
    expect(syncB.body.counts.pending).toBe(1); // B's own pending event only
  });

  it('cannot filter the movement history by a product of another tenant', async () => {
    await api().post(`/products/${productOfB.id}/adjust-stock`).set(bearer(b.admin.token)).send({ delta: 2 });
    const res = await api().get('/stock-movements').query({ productId: productOfB.id }).set(bearer(a.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('cannot retry a failed sync update of another tenant', async () => {
    const res = await api().post('/sync/failed/1/retry').set(bearer(a.admin.token));
    expect(res.status).toBe(404);
  });

  it('ignores a tenantId smuggled into the request: unknown fields are rejected', async () => {
    const res = await api()
      .post('/products')
      .set(bearer(a.admin.token))
      .send({ sku: 'X', name: 'x', price: '1.00', tenantId: b.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('the same SKU can exist in two tenants (unique per tenant, not global)', async () => {
    const x = await api().post('/products').set(bearer(a.admin.token)).send({ sku: 'SECRET-B', name: 'A version', price: '2.00' });
    expect(x.status).toBe(201);
    const dup = await api().post('/products').set(bearer(a.admin.token)).send({ sku: 'SECRET-B', name: 'again', price: '2.00' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SKU_ALREADY_EXISTS');
  });

  it('the same idempotency key in two tenants does not collide', async () => {
    const pa = await createProduct(a.id, { stock: 5 });
    const key = randomUUID();
    const ra = await api().post('/sales').set(bearer(a.operator.token)).set('Idempotency-Key', key).send({ items: [{ productId: pa.id, quantity: 1 }] });
    const rb = await api().post('/sales').set(bearer(b.operator.token)).set('Idempotency-Key', key).send({ items: [{ productId: productOfB.id, quantity: 1 }] });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.id).not.toBe(rb.body.id);
  });
});

describe('authentication and roles', () => {
  it('rejects missing, malformed and forged tokens', async () => {
    expect((await api().get('/products')).status).toBe(401);
    expect((await api().get('/products').set({ Authorization: 'Bearer nope' })).status).toBe(401);
    const forged = a.admin.token.slice(0, -3) + 'abc';
    expect((await api().get('/products').set(bearer(forged))).status).toBe(401);
  });

  it('operators can read products and sell, but cannot change products', async () => {
    const asOperator = bearer(a.operator.token);
    const own = await createProduct(a.id, { stock: 5 });
    expect((await api().get('/products').set(asOperator)).status).toBe(200);
    expect((await api().post('/products').set(asOperator).send({ sku: 'N', name: 'n', price: '1.00' })).status).toBe(403);
    expect((await api().patch(`/products/${own.id}`).set(asOperator).send({ name: 'x' })).status).toBe(403);
    expect((await api().delete(`/products/${own.id}`).set(asOperator)).status).toBe(403);
    expect((await api().post(`/products/${own.id}/adjust-stock`).set(asOperator).send({ delta: 1 })).status).toBe(403);
    expect((await api().post('/sales').set(asOperator).send({ items: [{ productId: own.id, quantity: 1 }] })).status).toBe(201);
  });

  it('logs in with valid credentials and rejects invalid ones with the same message', async () => {
    const ok = await api().post('/auth/login').send({ email: a.admin.email, password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: 'admin', tenant: { id: a.id, name: 'acme' } });
    expect((await api().get('/auth/me').set(bearer(ok.body.token))).body.email).toBe(a.admin.email);

    const wrongPassword = await api().post('/auth/login').send({ email: a.admin.email, password: 'wrong' });
    const unknownUser = await api().post('/auth/login').send({ email: 'nobody@nowhere.test', password: 'password123' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });
});
