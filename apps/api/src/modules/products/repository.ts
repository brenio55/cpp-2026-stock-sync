import type { Queryable } from '../../common/types';

export interface ProductRow {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  price: string;
  stock: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toRow = (r: any): ProductRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  sku: r.sku,
  name: r.name,
  price: r.price,
  stock: r.stock,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const COLUMNS = 'id, tenant_id, sku, name, price, stock, version, created_at, updated_at';

/** Every function takes tenantId first and puts it in the WHERE clause: forgetting it is a compile error. */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export async function listProducts(
  db: Queryable,
  tenantId: string,
  f: { q?: string; outOfStock?: boolean; page: number; limit: number },
): Promise<{ items: ProductRow[]; total: number }> {
  const params: unknown[] = [tenantId];
  let where = 'tenant_id = $1 AND deleted_at IS NULL';
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    where += ` AND (name ILIKE $${params.length} OR sku ILIKE $${params.length})`;
  }
  if (f.outOfStock === true) where += ' AND stock = 0';
  if (f.outOfStock === false) where += ' AND stock > 0';

  const [count, rows] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM products WHERE ${where}`, params),
    db.query(
      `SELECT ${COLUMNS} FROM products WHERE ${where}
        ORDER BY name, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, (f.page - 1) * f.limit],
    ),
  ]);
  return { total: count.rows[0].n, items: rows.rows.map(toRow) };
}

export async function findProduct(
  db: Queryable,
  tenantId: string,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ProductRow | null> {
  const res = await db.query(
    `SELECT ${COLUMNS} FROM products WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL
     ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function insertProduct(
  db: Queryable,
  tenantId: string,
  p: { sku: string; name: string; price: string; stock: number },
): Promise<ProductRow> {
  const res = await db.query(
    `INSERT INTO products (tenant_id, sku, name, price, stock) VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [tenantId, p.sku, p.name, p.price, p.stock],
  );
  return toRow(res.rows[0]);
}

export async function updateProductDetails(
  db: Queryable,
  tenantId: string,
  id: string,
  p: { name: string; price: string; bumpVersion: boolean },
): Promise<ProductRow> {
  const res = await db.query(
    `UPDATE products
        SET name = $3, price = $4, version = version + $5, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [tenantId, id, p.name, p.price, p.bumpVersion ? 1 : 0],
  );
  return toRow(res.rows[0]);
}

export async function softDeleteProduct(db: Queryable, tenantId: string, id: string): Promise<ProductRow> {
  const res = await db.query(
    `UPDATE products SET deleted_at = now(), version = version + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [tenantId, id],
  );
  return toRow(res.rows[0]);
}

/**
 * Atomically applies a stock delta. The WHERE clause is the invariant: stock can never go negative,
 * even with concurrent callers, because the check and the write are one statement under the row lock.
 * Returns null when the product is missing/deleted or (for negative deltas) stock is insufficient.
 */
export async function applyStockDelta(
  db: Queryable,
  tenantId: string,
  id: string,
  delta: number,
): Promise<ProductRow | null> {
  const res = await db.query(
    `UPDATE products
        SET stock = stock + $3, version = version + 1, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND stock + $3 >= 0
      RETURNING ${COLUMNS}`,
    [tenantId, id, delta],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

/** Used only to explain a failed applyStockDelta: missing product, or how much stock is available. */
export async function peekStock(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<{ sku: string; stock: number } | null> {
  const res = await db.query(
    'SELECT sku, stock FROM products WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL',
    [tenantId, id],
  );
  return res.rows[0] ?? null;
}
