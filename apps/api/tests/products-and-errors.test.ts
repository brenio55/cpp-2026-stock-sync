import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { api, bearer, countRows, createProduct, createTenant, resetDb, type TestTenant } from './helpers/factory';

let tenant: TestTenant;
const admin = () => bearer(tenant.admin.token);

beforeEach(async () => {
  await resetDb();
  tenant = await createTenant();
});

describe('products', () => {
  it('creates a product with initial stock, a CREATE movement and a sync event', async () => {
    const res = await api().post('/products').set(admin()).send({ sku: 'MUG-1', name: ' Mug ', price: 19.5, stock: 7 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sku: 'MUG-1', name: 'Mug', price: '19.50', stock: 7, version: 1 });
    expect(res.body.tenantId).toBeUndefined();

    const movements = await api().get('/stock-movements').query({ productId: res.body.id }).set(admin());
    expect(movements.body.data).toHaveLength(1);
    expect(movements.body.data[0]).toMatchObject({ delta: 7, stockAfter: 7, reason: 'CREATE', userEmail: tenant.admin.email });
    expect(await countRows('outbox_events')).toBe(1);
  });

  it('paginates and filters by name/SKU and by out-of-stock', async () => {
    for (let i = 1; i <= 25; i++) await createProduct(tenant.id, { sku: `ITEM-${String(i).padStart(2, '0')}`, name: `Item ${i}`, stock: i % 5 === 0 ? 0 : 3 });
    await createProduct(tenant.id, { sku: 'SPECIAL_%', name: 'Odd name', stock: 1 });

    const p1 = await api().get('/products').query({ limit: 10 }).set(admin());
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.meta).toEqual({ page: 1, limit: 10, total: 26, totalPages: 3 });
    const p3 = await api().get('/products').query({ limit: 10, page: 3 }).set(admin());
    expect(p3.body.data).toHaveLength(6);

    const out = await api().get('/products').query({ outOfStock: true, limit: 100 }).set(admin());
    expect(out.body.meta.total).toBe(5);
    expect(out.body.data.every((p: { stock: number }) => p.stock === 0)).toBe(true);
    const inStock = await api().get('/products').query({ outOfStock: false, limit: 100 }).set(admin());
    expect(inStock.body.meta.total).toBe(21);

    const bySku = await api().get('/products').query({ q: 'item-07' }).set(admin());
    expect(bySku.body.data.map((p: { sku: string }) => p.sku)).toEqual(['ITEM-07']);
    // LIKE wildcards in the search text are literal characters, not patterns
    const wildcard = await api().get('/products').query({ q: '%' }).set(admin());
    expect(wildcard.body.data.map((p: { sku: string }) => p.sku)).toEqual(['SPECIAL_%']);
  });

  it('only a price change creates sync traffic; a rename does not', async () => {
    const created = await api().post('/products').set(admin()).send({ sku: 'P', name: 'Old', price: '10.00', stock: 1 });
    const id = created.body.id;
    const rename = await api().patch(`/products/${id}`).set(admin()).send({ name: 'New name' });
    expect(rename.body).toMatchObject({ name: 'New name', version: 1 });
    expect(await countRows('outbox_events')).toBe(1);

    const reprice = await api().patch(`/products/${id}`).set(admin()).send({ price: '12.50' });
    expect(reprice.body).toMatchObject({ price: '12.50', version: 2 });
    expect(await countRows('outbox_events')).toBe(2);
  });

  it('adjusts stock with a recorded reason, and refuses to go negative', async () => {
    const created = await api().post('/products').set(admin()).send({ sku: 'P', name: 'P', price: '1.00', stock: 3 });
    const id = created.body.id;

    const up = await api().post(`/products/${id}/adjust-stock`).set(admin()).send({ delta: 4, note: 'recount' });
    expect(up.body.stock).toBe(7);
    const tooMuch = await api().post(`/products/${id}/adjust-stock`).set(admin()).send({ delta: -8 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('INSUFFICIENT_STOCK');

    const history = await api().get('/stock-movements').query({ productId: id }).set(admin());
    expect(history.body.data.map((m: { reason: string; delta: number; note: string | null }) => [m.reason, m.delta, m.note])).toEqual([
      ['ADJUSTMENT', 4, 'recount'],
      ['CREATE', 3, null],
    ]);
  });

  it('soft-deletes: the product disappears, its history stays, and the ads service is told stock is 0', async () => {
    const created = await api().post('/products').set(admin()).send({ sku: 'GONE', name: 'Gone', price: '1.00', stock: 5 });
    const id = created.body.id;
    expect((await api().delete(`/products/${id}`).set(admin())).status).toBe(204);

    expect((await api().get(`/products/${id}`).set(admin())).status).toBe(404);
    expect((await api().get('/products').set(admin())).body.data).toEqual([]);
    expect((await api().get('/stock-movements').set(admin())).body.data).toHaveLength(1);
    const sale = await api().post('/sales').set(bearer(tenant.operator.token)).send({ items: [{ productId: id, quantity: 1 }] });
    expect(sale.status).toBe(404);

    const events = await pool.query('SELECT stock, version FROM outbox_events ORDER BY id');
    expect(events.rows).toEqual([{ stock: 5, version: 1 }, { stock: 0, version: 2 }]);
  });
});

describe('validation and error responses', () => {
  it('rejects invalid input with a consistent shape and field-level details', async () => {
    const res = await api().post('/products').set(admin()).send({ sku: 'bad sku!', name: '', price: -1, stock: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR', message: expect.any(String), correlationId: expect.any(String) });
    const fields = res.body.details.map((d: { path: string }) => d.path).sort();
    expect(fields).toEqual(['name', 'price', 'sku', 'stock']);
  });

  it('validates sales: empty, duplicate products, bad quantities, bad ids', async () => {
    const p = await createProduct(tenant.id, { stock: 5 });
    const op = bearer(tenant.operator.token);
    const send = (body: unknown) => api().post('/sales').set(op).send(body as object);
    expect((await send({ items: [] })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect((await send({ items: [{ productId: p.id, quantity: 0 }] })).status).toBe(400);
    expect((await send({ items: [{ productId: p.id, quantity: 1.5 }] })).status).toBe(400);
    expect((await send({ items: [{ productId: 'not-a-uuid', quantity: 1 }] })).status).toBe(400);
    expect((await send({ items: [{ productId: p.id, quantity: 1 }, { productId: p.id, quantity: 1 }] })).status).toBe(400);
    expect(await countRows('sales')).toBe(0);
  });

  it('answers malformed ids and bodies with 400, unknown routes with 404', async () => {
    expect((await api().get('/products/not-a-uuid').set(admin())).status).toBe(400);
    const badJson = await api().post('/products').set(admin()).set('Content-Type', 'application/json').send('{"sku": ');
    expect(badJson.status).toBe(400);
    expect(badJson.body.code).toBe('INVALID_JSON');
    expect((await api().get('/nope').set(admin())).body.code).toBe('ROUTE_NOT_FOUND');
  });

  it('never leaks stack traces, SQL or driver details, even when the database itself rejects the statement', async () => {
    // Make an unexpected database error happen on purpose.
    await pool.query('ALTER TABLE sale_items RENAME TO sale_items_gone');
    try {
      const p = await createProduct(tenant.id, { stock: 5 });
      const res = await api().post('/sales').set(bearer(tenant.operator.token)).send({ items: [{ productId: p.id, quantity: 1 }] });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' });
      // Exactly the public fields and nothing else: no `stack`, `detail`, `query`, ...
      expect(Object.keys(res.body).sort()).toEqual(['code', 'correlationId', 'message', 'statusCode']);
      const text = JSON.stringify(res.body).toLowerCase();
      for (const secret of ['sale_items', 'select ', 'insert ', 'does not exist', 'node_modules', '.ts:']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      await pool.query('ALTER TABLE sale_items_gone RENAME TO sale_items');
    }
  });

  it('propagates a caller-supplied request id and generates one otherwise', async () => {
    const given = await api().get('/nope').set('x-request-id', 'trace-1234567890');
    expect(given.headers['x-request-id']).toBe('trace-1234567890');
    expect(given.body.correlationId).toBe('trace-1234567890');
    const generated = await api().get('/nope');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const unsafe = await api().get('/nope').set('x-request-id', 'x'); // too short: replaced
    expect(unsafe.headers['x-request-id']).not.toBe('x');
  });
});
