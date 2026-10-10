import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, bearer, countRows, createProduct, createTenant, resetDb, stockOf, type TestTenant } from './helpers/factory';
import { pool } from '../src/db/pool';

let tenant: TestTenant;

beforeEach(async () => {
  await resetDb();
  tenant = await createTenant();
});

const sell = (items: { productId: string; quantity: number }[], token = tenant.operator.token) =>
  api().post('/sales').set(bearer(token)).set('Idempotency-Key', randomUUID()).send({ items });

describe('concurrent sales cannot oversell', () => {
  it('25 simultaneous sales of 1 unit against stock 10: exactly 10 succeed, stock ends at 0', async () => {
    const product = await createProduct(tenant.id, { stock: 10, price: '5.00' });

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => sell([{ productId: product.id, quantity: 1 }])),
    );

    const ok = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(10);
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.body.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true); // no 500s

    expect(await stockOf(product.id)).toBe(0);
    // The history reconciles with the final stock: 10 sales of -1.
    const sum = await pool.query(
      `SELECT COALESCE(sum(delta), 0)::int AS total, count(*)::int AS n FROM stock_movements WHERE product_id = $1 AND reason = 'SALE'`,
      [product.id],
    );
    expect(sum.rows[0]).toEqual({ total: -10, n: 10 });
    expect(await countRows('sales', 'tenant_id = $1', [tenant.id])).toBe(10);
  });

  it('larger quantities: stock 7, ten concurrent sales of 2 units -> exactly 3 succeed and 1 unit is left', async () => {
    const product = await createProduct(tenant.id, { stock: 7 });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => sell([{ productId: product.id, quantity: 2 }])),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    expect(await stockOf(product.id)).toBe(1);
  });

  it('multi-item sales that lock the same rows in opposite order do not deadlock and never oversell', async () => {
    const a = await createProduct(tenant.id, { stock: 6 });
    const b = await createProduct(tenant.id, { stock: 6 });
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sell(
          i % 2 === 0
            ? [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]
            : [{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }],
        ),
      ),
    );
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const succeeded = responses.filter((r) => r.status === 201).length;
    expect(succeeded).toBe(6);
    expect(await stockOf(a.id)).toBe(0);
    expect(await stockOf(b.id)).toBe(0);
  });
});

describe('a sale is all-or-nothing', () => {
  it('one item without enough stock leaves every other item untouched', async () => {
    const plenty = await createProduct(tenant.id, { stock: 50 });
    const scarce = await createProduct(tenant.id, { sku: 'SCARCE-1', stock: 1 });

    const res = await sell([
      { productId: plenty.id, quantity: 5 },
      { productId: scarce.id, quantity: 2 },
    ]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.details).toMatchObject({ sku: 'SCARCE-1', requested: 2, available: 1 });
    expect(await stockOf(plenty.id)).toBe(50);
    expect(await stockOf(scarce.id)).toBe(1);
    expect(await countRows('sales')).toBe(0);
    expect(await countRows('stock_movements')).toBe(0);
    expect(await countRows('outbox_events')).toBe(0);
  });

  it('records the total from the price at the time of the sale, one movement and one outbox event per item', async () => {
    const a = await createProduct(tenant.id, { stock: 10, price: '19.99' });
    const b = await createProduct(tenant.id, { stock: 10, price: '0.10' });
    const res = await sell([
      { productId: a.id, quantity: 3 },
      { productId: b.id, quantity: 3 },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.total).toBe('60.27'); // 3 x 19.99 + 3 x 0.10, exact decimal arithmetic
    expect(await countRows('stock_movements', `reason = 'SALE' AND user_id = $1`, [tenant.operator.id])).toBe(2);
    expect(await countRows('outbox_events')).toBe(2);
  });
});
