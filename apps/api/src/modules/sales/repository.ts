import type { Queryable } from '../../common/types';

export async function insertSale(
  db: Queryable,
  s: { id: string; tenantId: string; userId: string; total: string },
): Promise<{ createdAt: string }> {
  const res = await db.query(
    'INSERT INTO sales (id, tenant_id, user_id, total) VALUES ($1, $2, $3, $4) RETURNING created_at',
    [s.id, s.tenantId, s.userId, s.total],
  );
  return { createdAt: res.rows[0].created_at.toISOString() };
}

export async function insertSaleItem(
  db: Queryable,
  i: { saleId: string; tenantId: string; productId: string; quantity: number; unitPrice: string },
): Promise<void> {
  await db.query(
    `INSERT INTO sale_items (sale_id, tenant_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4, $5)`,
    [i.saleId, i.tenantId, i.productId, i.quantity, i.unitPrice],
  );
}

export interface StoredKey {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
}

/**
 * Claims an idempotency key inside the sale transaction.
 * If another transaction holds the same (tenant, key) uncommitted, this INSERT blocks on the primary key
 * until that transaction finishes: commit -> we get `false` (replay), rollback -> we get `true` (we own it).
 */
export async function reserveKey(db: Queryable, tenantId: string, key: string, requestHash: string): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, 0, '{}'::jsonb)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, key, requestHash],
  );
  return res.rowCount === 1;
}

export async function getKey(db: Queryable, tenantId: string, key: string): Promise<StoredKey | null> {
  const res = await db.query(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  const r = res.rows[0];
  return r ? { requestHash: r.request_hash, responseStatus: r.response_status, responseBody: r.response_body } : null;
}

export async function saveKeyResponse(
  db: Queryable,
  tenantId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await db.query(
    'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2',
    [tenantId, key, status, JSON.stringify(body)],
  );
}
