import { notFound } from '../../common/errors';
import type { AuthContext } from '../../common/types';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { enqueueProductUpdate } from './outbox';
import * as repo from './repository';

export const getStatus = (auth: AuthContext) => repo.getStatus(pool, auth.tenantId);

/**
 * Re-queues a dead-lettered update. Re-publishing goes through the outbox like any other change,
 * so the API never needs a broker connection and the retry survives crashes.
 *  - same version as the product now: the failed row goes back to PENDING (attempts reset);
 *  - the product moved on since: the failed row is superseded, and the product's current state is enqueued.
 */
export async function retryFailed(auth: AuthContext, id: number): Promise<{ status: 'PENDING' | 'SUPERSEDED' }> {
  return withTransaction(async (client) => {
    const failed = await repo.lockFailedUpdate(client, auth.tenantId, id);
    if (!failed) throw notFound('Failed sync update');

    const product = await repo.getProductState(client, auth.tenantId, failed.productId);
    if (!product) throw notFound('Product');

    const status = product.version === failed.version ? 'PENDING' : 'SUPERSEDED';
    await repo.setUpdateStatus(client, auth.tenantId, id, status);
    await enqueueProductUpdate(client, {
      tenantId: auth.tenantId,
      productId: failed.productId,
      sku: product.sku,
      stock: product.stock,
      price: product.price,
      version: product.version,
    });
    return { status };
  });
}
