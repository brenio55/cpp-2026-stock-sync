import type { Queryable } from '../../common/types';

export interface ProductSnapshot {
  tenantId: string;
  productId: string;
  sku: string;
  stock: number;
  price: string;
  version: number;
}

/**
 * Transactional outbox: call this with the SAME client/transaction that changed the product.
 * The event commits (or rolls back) together with the change, so a change can never be lost or phantom-published.
 * The worker relays these rows to RabbitMQ later; the request never waits for that.
 */
export async function enqueueProductUpdate(db: Queryable, p: ProductSnapshot): Promise<void> {
  await db.query(
    `INSERT INTO outbox_events (tenant_id, product_id, sku, stock, price, version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.tenantId, p.productId, p.sku, p.stock, p.price, p.version],
  );
}
