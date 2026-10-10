import type { Queryable } from '../../common/types';

export type MovementReason = 'SALE' | 'ADJUSTMENT' | 'CREATE';

export interface NewMovement {
  tenantId: string;
  productId: string;
  userId: string;
  delta: number;
  stockAfter: number;
  reason: MovementReason;
  refId?: string | null;
  note?: string | null;
}

export interface StockMovement {
  id: string;
  productId: string;
  sku: string;
  delta: number;
  stockAfter: number;
  reason: MovementReason;
  note: string | null;
  refId: string | null;
  userId: string;
  userEmail: string;
  createdAt: string;
}

export async function insertMovement(db: Queryable, m: NewMovement): Promise<void> {
  await db.query(
    `INSERT INTO stock_movements (tenant_id, product_id, user_id, delta, stock_after, reason, ref_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.tenantId, m.productId, m.userId, m.delta, m.stockAfter, m.reason, m.refId ?? null, m.note ?? null],
  );
}

export async function listMovements(
  db: Queryable,
  tenantId: string,
  filters: { productId?: string; page: number; limit: number },
): Promise<{ items: StockMovement[]; total: number }> {
  const params: unknown[] = [tenantId];
  let where = 'm.tenant_id = $1';
  if (filters.productId) {
    params.push(filters.productId);
    where += ` AND m.product_id = $${params.length}`;
  }

  const [count, rows] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM stock_movements m WHERE ${where}`, params),
    db.query(
      `SELECT m.id, m.product_id, p.sku, m.delta, m.stock_after, m.reason, m.note, m.ref_id,
              m.user_id, u.email AS user_email, m.created_at
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id AND p.tenant_id = m.tenant_id
         JOIN users u    ON u.id = m.user_id    AND u.tenant_id = m.tenant_id
        WHERE ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, (filters.page - 1) * filters.limit],
    ),
  ]);

  return {
    total: count.rows[0].n,
    items: rows.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      delta: r.delta,
      stockAfter: r.stock_after,
      reason: r.reason,
      note: r.note,
      refId: r.ref_id,
      userId: r.user_id,
      userEmail: r.user_email,
      createdAt: r.created_at.toISOString(),
    })),
  };
}
